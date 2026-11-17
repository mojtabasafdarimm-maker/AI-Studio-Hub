// GET /api/cloud-send: what this server holds that Send to My Cloud compares, as a short hash per part. Read only, and
// never a secret: a login is its site and username (as GET /api/logins shows them), 1Password is when it was connected
// and which bots its vaults are kept to.
import { createHash } from "node:crypto";
import { BOT_PARTS, EMPTY, PICTURE_PART, itemKey } from "../electron/cloud-send-parts.mjs";
import { canonicalJson } from "../shared/package-format.js";
/** What a bot's move into a team never carries: being someone's Chief of Staff (the team has its own). */
const TEAM_HELD_PARTS = ["chief", "helper"];
function empty(value) {
    if (value === undefined || value === null || value === "")
        return true;
    if (Array.isArray(value))
        return value.length === 0;
    return typeof value === "object" && Object.keys(value).length === 0;
}
/** "-" for nothing at all, so a part My Cloud has no value for is told apart from one it changed. */
export function partHash(value) {
    if (empty(value))
        return EMPTY;
    const kept = typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, field]) => !empty(field)))
        : value;
    if (empty(kept))
        return EMPTY;
    return createHash("sha256").update(canonicalJson(kept)).digest("hex").slice(0, 24);
}
const pictureHashes = new Map();
/** A stored picture never changes under its name: a new picture is a new attachment. */
function pictureHash(avatarUrl, picture) {
    const known = pictureHashes.get(avatarUrl);
    if (known)
        return known;
    const bytes = picture(avatarUrl);
    if (!bytes)
        return EMPTY;
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    if (pictureHashes.size > 1000)
        pictureHashes.clear();
    pictureHashes.set(avatarUrl, hash);
    return hash;
}
export function botParts(bot, picture) {
    const fields = bot;
    const parts = {};
    for (const [part, names] of Object.entries(BOT_PARTS)) {
        parts[part] = partHash(names.length === 1 ? fields[names[0]] : Object.fromEntries(names.map((name) => [name, fields[name]])));
    }
    parts[PICTURE_PART] = bot.avatarUrl ? pictureHash(bot.avatarUrl, picture) : EMPTY;
    return parts;
}
/** A bot nobody has touched since it was made (a fresh install's starter): left out, so it never lands beside My Cloud's
 * own starter. A bot sent from another computer arrives without a greeting, so it never reads as unused. */
export function unused(bot, skills, greetingOnly, inRoom = () => false, automated = () => false) {
    return !bot.soul?.trim() && !bot.title && !bot.description && !bot.avatarUrl && !bot.sidebarHidden && !bot.welcomed && skills === 0 && (bot.tasks?.length ?? 1) <= 1 && greetingOnly(bot.threadId, bot.name)
        && !inRoom(bot.id) && !automated(bot.id);
}
/** `move`: a move's comparison, with what only a move carries. `bot`: a move of that one bot into a team: the bot, its
 * skills, its routines and the library skills it uses, never anything of the person's own. `bots`: a move of only these of
 * this computer's bots, which a calendar call stays out of: it runs where it was set up. `leaving`: this server is the one
 * bots move away from, so one that lives elsewhere now is not carried again. */
export function cloudSendSummary(sources, { move = false, bot: only, bots: chosen, leaving = false } = {}) {
    const items = [];
    const carried = new Set();
    for (const bot of sources.bots()) {
        if ((only !== undefined && bot.id !== only) || (chosen && !chosen.has(bot.id)) || (leaving && bot.movedTo?.state === "moved"))
            continue;
        const skills = sources.skills(bot);
        if (only === undefined && unused(bot, skills.length, sources.greetingOnly, sources.inRoom, move ? sources.automated : undefined))
            continue;
        carried.add(bot.id);
        const parts = { ...botParts(bot, sources.picture), ...(move && sources.move ? sources.move.botParts(bot) : {}) };
        if (only !== undefined)
            for (const part of TEAM_HELD_PARTS)
                delete parts[part];
        items.push({ key: itemKey.bot(bot.id), kind: "bot", label: bot.name, id: bot.id, parts });
        for (const skill of skills) {
            items.push({ key: itemKey.skill(bot.id, skill.name), kind: "skill", label: skill.name, id: skill.name, bot: bot.id,
                parts: { text: skill.sha256.slice(0, 24) || EMPTY, on: skill.enabled ? "on" : "off" } });
        }
    }
    if (only !== undefined) {
        const bot = sources.bots().find((candidate) => candidate.id === only);
        if (move && sources.move && bot)
            items.push(...sources.move.items(carried, bot));
        return { v: 1, appVersion: sources.appVersion, items };
    }
    for (const login of sources.logins()) {
        items.push({ key: itemKey.login(login.site, login.username, login.exactHost ? login.hosts[0] : undefined), kind: "login", label: login.hosts[0] ?? login.site, detail: login.username, id: login.id,
            parts: { saved: partHash(login.updatedAt) } });
    }
    const onePassword = sources.onePassword();
    if (onePassword) {
        items.push({ key: itemKey.onePassword(), kind: "1password", label: "1Password",
            // Items' own bots count with the vaults', so narrowing one item sends again; without any the hash stays as before.
            parts: { token: partHash(onePassword.connectedAt),
                vaults: partHash(Object.keys(onePassword.itemGrants ?? {}).length ? { vaults: onePassword.grants, items: onePassword.itemGrants } : onePassword.grants) } });
    }
    for (const secret of sources.secrets?.() ?? []) {
        items.push({ key: itemKey.secret(secret.id), kind: "secret", label: secret.name, id: secret.id, parts: { saved: partHash(secret.updatedAt) } });
    }
    const { profile = {}, language } = sources.settings();
    items.push({ key: itemKey.setting("profile"), kind: "setting", label: "profile",
        parts: { name: partHash(profile.name), email: partHash(profile.email), about: partHash(profile.aboutMe) } });
    items.push({ key: itemKey.setting("language"), kind: "setting", label: "language", parts: { value: partHash(language) } });
    if (move && sources.move)
        items.push(...sources.move.items(carried).filter((item) => !chosen || item.kind !== "call"));
    return { v: 1, appVersion: sources.appVersion, items };
}
