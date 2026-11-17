import { noticeSummary } from "../chat-notices.js";
// The phone integration's per-turn pieces: the mount, the prompt part and the internal MCP handler (owner check, per-bot
// verdict, decision rows, the phone job, write activity). A send waits on the person's Send tap on the phone, never on a
// card of OpenMausBot's own.
import { isOutboundTool } from "../../shared/outbound.js";
import { PHONE_MCP_SERVER, phoneToolCapability } from "../../shared/phone-apps.js";
import { appendDecision } from "../decision-log.js";
import { harnessMcpTokenEnv } from "../harness-mcp-token.js";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.js";
import { capName, phoneAccess, phoneAppsFor, phoneSystemPrompt, phoneWithheldPrompt } from "./access.js";
import { PHONE_NO_PHONE_TEXT, PHONE_PLACE_PROMPT } from "./instructions.js";
import { PHONE_JOB_TIMEOUT_MS, PHONE_SEND_TIMEOUT_MS } from "./jobs.js";
import { phoneRpc } from "./rpc.js";
import { PHONE_TOOLS } from "./tools.js";
const NOT_OWNER_TEXT = "This conversation can't use a phone: only the owner's own turns can.";
const GONE_TEXT = "This bot no longer exists.";
/** The default phone: used ones first, the latest use first; then never-used ones, the newest pairing first. The poll
 * heartbeat (`seen`) never ranks: a phone that merely polled must not take a send meant for the one in use. */
const byUse = (a, b) => a.lastUsedAt !== null && b.lastUsedAt !== null ? b.lastUsedAt - a.lastUsedAt
    : a.lastUsedAt !== null ? -1 : b.lastUsedAt !== null ? 1 : b.registeredAt - a.registeredAt;
const allows = (phone, cap) => Boolean(phone.registration.capabilities[cap]);
const target = (phone) => ({ key: phone.key, name: phone.registration.name, platform: phone.registration.platform });
const notAllowed = (phone, name) => ({ ok: false, code: "denied", text: `${phone} does not allow ${capName(phoneToolCapability(name))}.` });
const denied = (name, text, rule, code) => ({ ok: false, text, rows: [{ tool: name, ...noticeSummary(code), decision: "auto-denied", rule }] });
export function createPhoneHost(deps) {
    const { registry, jobs } = deps;
    /** The owner's phones that allow at least one app, in default order. */
    const phonesOf = (owner) => registry.forOwner(owner)
        .filter((phone) => Object.values(phone.registration.capabilities).some(Boolean))
        .sort(byUse);
    /** The apps any of the owner's phones allows: what exists for the verdict. The chosen phone's own apps decide the pick. */
    const merged = (phones) => Object.assign({}, ...phones.map((phone) => phone.registration.capabilities));
    const mounts = (bot, owner) => {
        if (owner === null)
            return false;
        const grants = phoneAppsFor(bot);
        const granted = Object.keys(grants).filter((cap) => grants[cap]);
        return phonesOf(owner).some((phone) => granted.some((cap) => allows(phone, cap)));
    };
    const prompt = (bot, owner) => (owner === null ? "" : phoneSystemPrompt(bot, phonesOf(owner).map(({ registration }) => registration)));
    return {
        mounts,
        integration(bot, owner, mint, harnessUrl) {
            if (!mounts(bot, owner))
                return null;
            const token = mint();
            return {
                command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, PHONE_MCP_SERVER],
                env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("device")]: token, OMB_HARNESS_URL: harnessUrl },
            };
        },
        prompt,
        parts(bot, owner, place) {
            const text = prompt(bot, owner);
            return [{ id: "device", label: "Phone", text }, { id: "device-place", label: "Where the person is", text: text && PHONE_PLACE_PROMPT[place] }];
        },
        withheld: (bot, owner) => (owner !== null && mounts(bot, owner) ? phoneWithheldPrompt(bot, phonesOf(owner).map(({ registration }) => registration)) : ""),
        toolListing: () => (registry.list(null, () => false).length === 0 ? null : { phone: PHONE_TOOLS.map(({ name, description }) => ({ name, description })) }),
        async handle(body, capability, assertActive) {
            return phoneRpc(body, {
                assertActive,
                // Re-read the live bot and the turn's owner on every call, so a permission change wins over a request
                // authenticated under the old one.
                authorize: (name) => {
                    const bot = deps.bot(capability.botId);
                    if (!bot)
                        return { ok: false, text: GONE_TEXT };
                    const owner = deps.turnOwner(capability);
                    const phones = owner === null ? [] : phonesOf(owner);
                    const verdict = owner === null ? denied(name, NOT_OWNER_TEXT, "phone:not-owner", "chat.notice.phone.notOwner")
                        : phones.length === 0 ? denied(name, PHONE_NO_PHONE_TEXT, "phone:no-phone", "chat.notice.phone.noPhone")
                            : phoneAccess(bot, merged(phones), name);
                    for (const row of verdict.rows) {
                        appendDecision(deps.dataDir, { threadId: capability.threadId, botId: bot.id, botName: bot.name, tool: row.tool, decision: row.decision, source: "connector-scope", rule: row.rule, ...(row.summary ? { summary: row.summary, summaryCode: row.summaryCode, summaryParams: row.summaryParams } : {}) });
                    }
                    return verdict.ok ? { ok: true } : { ok: false, text: verdict.text };
                },
                // A named phone is looked up among all of the owner's phones; the default only among those allowing the tool's app.
                phone: (preferred, name) => {
                    const owner = deps.turnOwner(capability);
                    const phones = owner === null ? [] : registry.forOwner(owner).sort(byUse);
                    if (preferred === undefined) {
                        const chosen = phones.find((phone) => allows(phone, phoneToolCapability(name)));
                        return chosen ? target(chosen) : null;
                    }
                    if (phones.length === 0)
                        return null;
                    const wanted = preferred.trim().toLowerCase();
                    const match = phones.find((phone) => phone.registration.name.trim().toLowerCase() === wanted);
                    if (!match)
                        return { ok: false, code: "no_phone", text: `${PHONE_NO_PHONE_TEXT} Available phones: ${phones.map((phone) => phone.registration.name).join(", ")}.` };
                    return allows(match, phoneToolCapability(name)) ? target(match) : notAllowed(match.registration.name, name);
                },
                run: async (phone, name, args) => {
                    const owner = deps.turnOwner(capability);
                    const active = () => {
                        if (!deps.active(capability) || owner === null || deps.turnOwner(capability) !== owner)
                            return false;
                        const bot = deps.bot(capability.botId);
                        const current = registry.get(phone.key);
                        return Boolean(bot && current && current.owner === owner && phoneAccess(bot, current.registration.capabilities, name).ok);
                    };
                    const outcome = await jobs.request(phone.key, name, args, {
                        active, timeoutMs: isOutboundTool(name) ? PHONE_SEND_TIMEOUT_MS : PHONE_JOB_TIMEOUT_MS,
                        offlineText: `${phone.name} is offline. Open the MausBot app on it.`, online: () => registry.online(phone.key),
                    });
                    if (outcome.ok)
                        registry.used(phone.key);
                    return outcome;
                },
                onWrite: (record) => {
                    const bot = deps.bot(capability.botId);
                    deps.appendMessage(capability.threadId, {
                        role: "bot", kind: "activity",
                        tool: { name: `mcp__${PHONE_MCP_SERVER}__${record.tool}`, ok: true, summary: record.summary, summaryCode: record.summaryCode, summaryParams: record.summaryParams },
                        ...(bot && deps.inRoom(capability.threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
                    });
                },
            });
        },
    };
}
