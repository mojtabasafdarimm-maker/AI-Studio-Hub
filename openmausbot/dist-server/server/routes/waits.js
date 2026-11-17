import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { WAIT_HOURS, WAIT_KINDS } from "../../shared/waits.js";
import { expandHome } from "../wait-probes.js";
import { WAIT_WAKE_MS, waitList } from "../waits.js";
import { PASS } from "./table.js";
const WAITS = "/api/internal/waits";
const CANCEL = "/api/internal/waits/cancel";
export const WAIT_MESSAGES = {
    notYours: "This conversation is not yours.",
    room: "Waits are made in a one-to-one chat with the person, not in a room.",
    notPerson: "Only the person can set up or stop a wait, in their own chat with you; a routine or an outside event cannot, and work a bot handed you can set one only when the person's own request started it.",
    handedStop: "Work handed to you by a bot can set one wait but not stop one: it ends on its own, or the person stops it.",
    serverHost: "File and program waits look at the computer MausBot runs on, and here that is a server, not the computer you work on. Use url_contains, url_missing or bot_idle.",
    guest: "File and program waits are only for the owner of this computer. Use url_contains, url_missing or bot_idle.",
    guestFollowUp: "Guests can be told when something happens, but can't set a follow-up. Make the wait without follow_up.",
    otherComputer: "You work on another computer this turn (a private desktop or a cloud desktop), and file and program waits look at the one MausBot runs on. Use url_contains, url_missing or bot_idle.",
    noPeer: "No bot you can reach goes by that name. Use a name or id from list_bots.",
    self: "You cannot wait for yourself to finish. Tell the person yourself when you are done.",
    noWait: "None of your waits in this chat has that id. Use list_waits.",
    none: "You are not waiting for anything in this chat.",
    noneToCancel: "You are not waiting for anything in this chat, so there is nothing to cancel.",
};
const FIELD_KINDS = {
    url: ["url_contains", "url_missing"],
    text: ["url_contains", "url_missing"],
    path: ["file_exists", "file_missing", "file_changed"],
    process: ["process_running", "process_gone"],
    bot: ["bot_idle"],
};
const FIELDS = Object.keys(FIELD_KINDS);
/**
 * `\\host\share` or `//host/share`, with either slash, mixed or percent-encoded (`%5C`, `%2F`, `%255C`): a network path.
 * Windows would sign in to that host to check it, sending it the person's password hash.
 */
export function isNetworkPath(path) {
    let plain = path.trim();
    for (let round = 0; round < 4 && /%(?:25|5c|2f)/i.test(plain); round++) {
        plain = plain.replace(/%(25|5c|2f)/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    return /^[\\/]{2}/.test(plain);
}
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const absent = (value) => value === undefined || value === null;
const joinWords = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);
const iso = (ms) => new Date(ms).toISOString();
export function parseWaitRequest(body, home) {
    const fail = (error) => ({ ok: false, error });
    if (!isRecord(body))
        return fail("Send a JSON object.");
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 120)
        return fail("label: the person's words for what you wait for, up to 120 characters.");
    if (/\p{Cc}/u.test(label))
        return fail("label must be a single line of plain text.");
    const kind = WAIT_KINDS.find((candidate) => candidate === body.kind);
    if (!kind)
        return fail(`kind is one of: ${WAIT_KINDS.join(", ")}.`);
    const needed = FIELDS.filter((field) => FIELD_KINDS[field].includes(kind));
    if (needed.some((field) => absent(body[field])))
        return fail(`${kind} needs ${needed.join(" and ")}.`);
    const stray = FIELDS.find((field) => !needed.includes(field) && !absent(body[field]));
    if (stray)
        return fail(`${stray} applies only to ${joinWords(FIELD_KINDS[stray])}.`);
    const request = { label, kind, hours: WAIT_HOURS.default };
    const size = (field, max, trim = false) => {
        const raw = body[field];
        const value = typeof raw === "string" ? (trim ? raw.trim() : raw) : "";
        return value.length >= 1 && value.length <= max && value.trim() ? value : null;
    };
    const lengthError = (field, max) => fail(`${field} must be 1 to ${max} characters.`);
    if (needed.includes("url")) {
        const raw = body.url;
        let parsed = null;
        try {
            parsed = typeof raw === "string" && raw.length <= 2048 ? new URL(raw) : null;
        }
        catch {
            parsed = null;
        }
        if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:"))
            return fail("url must be an http or https address.");
        if (parsed.username || parsed.password)
            return fail("Put no sign-in details in the address.");
        request.url = parsed.href;
        const text = size("text", 500);
        if (text === null)
            return lengthError("text", 500);
        request.text = text;
    }
    if (needed.includes("path")) {
        const raw = body.path;
        if (typeof raw === "string" && isNetworkPath(raw))
            return fail("path must be on this computer: a network path (\\\\server\\share or //server/share) is never checked.");
        const path = typeof raw === "string" && raw.length >= 1 && raw.length <= 1024 ? expandHome(raw, home) : "";
        if (!path || !isAbsolute(path))
            return fail("path must be a full path or start with ~.");
        request.path = path;
    }
    if (needed.includes("process")) {
        const process = size("process", 256);
        if (process === null)
            return lengthError("process", 256);
        request.process = process;
    }
    if (needed.includes("bot")) {
        const bot = size("bot", 128, true);
        if (bot === null)
            return lengthError("bot", 128);
        request.bot = bot;
    }
    if (!absent(body.follow_up)) {
        const followUp = size("follow_up", 2000, true);
        if (followUp === null)
            return lengthError("follow_up", 2000);
        request.followUp = followUp;
    }
    if (!absent(body.hours)) {
        const hours = body.hours;
        if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > WAIT_HOURS.max)
            return fail(`hours is a whole number from 1 to ${WAIT_HOURS.max}.`);
        request.hours = hours;
    }
    return { ok: true, request };
}
export function waitSourceRefusal(turn) {
    if (!turn.owned)
        return WAIT_MESSAGES.notYours;
    if (turn.room)
        return WAIT_MESSAGES.room;
    if (turn.routineRun || turn.outsideDriven)
        return WAIT_MESSAGES.notPerson;
    if (turn.depth > 0 || turn.handedOff) {
        if (!turn.personStarted || turn.guest || !turn.assignmentId)
            return WAIT_MESSAGES.notPerson;
        return turn.op === "create" ? null : WAIT_MESSAGES.handedStop;
    }
    if (!(turn.personStarted || turn.guest))
        return WAIT_MESSAGES.notPerson;
    return null;
}
export function handedAssignment(id, node) {
    const found = id ? node(id) : undefined;
    return found?.parentId !== undefined && found.status === "running" ? found.id : undefined;
}
export function hostWaitRefusal(turn) {
    if (turn.cloudHome || turn.hosted)
        return WAIT_MESSAGES.serverHost;
    if (turn.guest)
        return WAIT_MESSAGES.guest;
    if (turn.place === "vm" || turn.place === "cloud")
        return WAIT_MESSAGES.otherComputer;
    return null;
}
export function findWaitPeer(peers, selfId, nameOrId) {
    const wanted = nameOrId.toLowerCase();
    const match = peers.find((peer) => !peer.hidden && (peer.id === nameOrId || peer.name.toLowerCase() === wanted));
    if (!match)
        return null;
    return match.id === selfId ? "self" : { id: match.id, name: match.name };
}
/**
 * Routes for listing, making and stopping a bot's waits. `sleeps`: the home is a personal My Cloud, whose plan
 * sleeps when idle; a Team Cloud never sleeps. Work a bot handed on is read once, before the body, and must still
 * be running after the body is read and again right before the wait is stored.
 */
export function createWaitRoutes(deps) {
    const home = deps.home ?? homedir;
    return async (ctx) => {
        const { res, json } = ctx;
        const here = () => deps.waits.list(ctx.botId).filter((wait) => wait.threadId === ctx.threadId);
        if (ctx.method === "GET" && ctx.path === WAITS) {
            if (ctx.sourceRefusal("create", undefined) === WAIT_MESSAGES.notYours)
                return void json(res, 403, { error: WAIT_MESSAGES.notYours });
            const mine = here();
            return void json(res, 200, { text: mine.length ? waitList(mine) : WAIT_MESSAGES.none });
        }
        if (ctx.method !== "POST" || (ctx.path !== WAITS && ctx.path !== CANCEL))
            return PASS;
        const assignmentId = ctx.assignmentId?.();
        const refusal = ctx.sourceRefusal(ctx.path === CANCEL ? "cancel" : "create", assignmentId);
        if (refusal)
            return void json(res, 403, { error: refusal });
        const body = await ctx.readBody();
        if (assignmentId !== undefined && ctx.assignmentId?.() !== assignmentId)
            return void json(res, 403, { error: WAIT_MESSAGES.notPerson });
        if (ctx.path === CANCEL) {
            if (!here().length)
                return void json(res, 404, { error: WAIT_MESSAGES.noneToCancel });
            const id = isRecord(body) ? body.id : undefined;
            if (typeof id !== "string" || !id)
                return void json(res, 400, { error: "id: the wait id from list_waits." });
            const stopped = here().some((wait) => wait.id === id) ? deps.waits.cancel(id, ctx.botId) : null;
            if (!stopped)
                return void json(res, 404, { error: WAIT_MESSAGES.noWait });
            return void json(res, 200, { text: `Stopped waiting for ${stopped.label}.` });
        }
        const parsed = parseWaitRequest(body, home());
        if (!parsed.ok)
            return void json(res, 400, { error: parsed.error });
        const { request } = parsed;
        if (request.followUp && ctx.guest())
            return void json(res, 403, { error: WAIT_MESSAGES.guestFollowUp });
        if (request.kind.startsWith("file_") || request.kind.startsWith("process_")) {
            const away = ctx.hostRefusal();
            if (away)
                return void json(res, 403, { error: away });
        }
        let condition;
        if (request.kind === "bot_idle") {
            const peer = ctx.peer(request.bot);
            if (peer === "self")
                return void json(res, 400, { error: WAIT_MESSAGES.self });
            if (!peer) {
                const away = ctx.elsewhere?.(request.bot) ?? null;
                return void json(res, 400, { error: !away ? WAIT_MESSAGES.noPeer : "where" in away ? away.where : `${WAIT_MESSAGES.noPeer} ${away.hint}` });
            }
            condition = { kind: "bot_idle", botId: peer.id, botName: peer.name };
        }
        else if (request.kind === "url_contains" || request.kind === "url_missing") {
            condition = { kind: request.kind, url: request.url, text: request.text };
        }
        else if (request.kind === "process_running" || request.kind === "process_gone") {
            condition = { kind: request.kind, process: request.process };
        }
        else {
            condition = { kind: request.kind, path: request.path };
        }
        const result = await deps.waits.create({
            botId: ctx.botId,
            threadId: ctx.threadId,
            label: request.label,
            condition,
            ...(request.followUp ? { followUp: request.followUp } : {}),
            hours: request.hours,
            ...(assignmentId ? { assignmentId, stillAllowed: () => (ctx.assignmentId?.() === assignmentId ? null : WAIT_MESSAGES.notPerson) } : {}),
        });
        if (result.state === "refused")
            return void json(res, result.status, { error: result.error });
        if (result.state === "already")
            return void json(res, 200, { text: result.text });
        const { wait, note } = result;
        const then = request.followUp ? `, and you will then do what you wrote in follow_up${deps.cloudHome ? " in a run that reports in its own results chat, not this one" : ""}` : "";
        const every = WAIT_WAKE_MS / 60_000;
        const sleeps = deps.sleeps ? ` While My Cloud sleeps it wakes to check every ${every} minutes, so the message can come up to ${every} minutes late: tell the person that too.` : "";
        const text = `Waiting for ${wait.label} (wait id ${wait.id}): plain checks, no AI, until ${iso(wait.expiresAt)}. When it happens a message lands in this chat${then}.${sleeps} Tell the person in one sentence; do not keep checking yourself.`;
        return void json(res, 201, { text: note ? `${text}\n\n${note}` : text });
    };
}
