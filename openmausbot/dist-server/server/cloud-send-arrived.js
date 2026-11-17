// POST /api/cloud-send/arrived, at the end of the move, over the owner's own session: My Cloud keeps which computer the
// bots came from, so each bot knows what stayed there (cloud-connections-prompt.ts), and each bot whose webhook has a new
// address here says so once in its own chat. The address itself never goes in a chat: it stays on the webhook's card.
// POST /api/cloud-send/automations-off: the automations a computer brought stop on My Cloud as its bots go home to it.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
import { chatNotice } from "./chat-notices.js";
import { switchAutomationsOff } from "./move-freeze.js";
import { serverLine } from "./server-lines.js";
const FILE = "moved-from.json";
export function movedFrom(dataDir) {
    try {
        const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
        if (typeof raw.computer !== "string" || !raw.computer.trim() || !Number.isSafeInteger(raw.at))
            return null;
        return { computer: raw.computer, at: raw.at, told: Array.isArray(raw.told) ? raw.told.filter((id) => typeof id === "string") : [] };
    }
    catch {
        return null;
    }
}
/** `place`: the server of the person's own the bot moved to, by the name they know it by; My Cloud without one. */
export const webhookMovedLine = (name, place = "My Cloud", language) => serverLine(language, "server.moves.webhookMoved", { name, place });
export const webhookHomeLine = (name) => chatNotice("chat.notice.webhookHome", { name });
const botLine = (key, name) => ({ role: "bot", kind: "text", text: chatNotice(key, { name }), textCode: key, textParams: { name } });
const arrivedBody = z.object({ v: z.literal(1), computer: z.string().trim().min(1).max(120), webhooks: z.array(z.string().regex(/^[\w-]{1,128}$/u)).max(500),
    place: z.string().trim().min(1).max(120).optional() });
/** False when the path is not this route. */
export async function arrivedRoute(deps, { req, res, path, method, auth, json, readBody }) {
    if (path !== "/api/cloud-send/arrived")
        return false;
    const refuse = (status, error) => { json(res, status, { error }); return true; };
    if (method !== "POST")
        return refuse(405, "method not allowed");
    const owner = deps.owner(auth);
    if (!owner)
        return refuse(403, "Only My Cloud's owner can finish a move into it.");
    const body = arrivedBody.safeParse(await readBody(req, 64 * 1024));
    if (!body.success)
        return refuse(400, "send { v: 1, computer, webhooks }");
    const kept = movedFrom(deps.dataDir);
    const told = new Set(kept?.told ?? []);
    const hooks = deps.webhooks()?.list() ?? [];
    const telling = body.data.webhooks.flatMap((id) => {
        const hook = hooks.find((candidate) => candidate.id === id);
        const bot = hook && !told.has(id) ? deps.store.bot(hook.botId) : null;
        return hook && bot ? [{ id, name: hook.name, threadId: bot.threadId }] : [];
    });
    for (const { id } of telling)
        told.add(id);
    // Recorded before the lines go: a move cut short here never has a bot say it twice.
    writeFileAtomic(join(deps.dataDir, FILE), JSON.stringify({ computer: body.data.computer, at: kept?.at ?? Date.now(), told: [...told] }), { mode: 0o600 });
    for (const line of telling)
        deps.store.appendMessage(line.threadId, { role: "bot", kind: "text", text: webhookMovedLine(line.name, body.data.place, deps.lineLanguage?.(owner.person)) });
    deps.stayed?.(deps.lineLanguage?.(owner.person));
    json(res, 200, { v: 1, told: telling.length });
    return true;
}
const webhookIds = z.array(z.string().regex(/^[\w-]{1,128}$/u)).max(500);
const homeBody = z.object({ v: z.literal(1), webhooks: webhookIds.optional() });
/** POST /api/cloud-send/home, on this computer once the bots came home with what they did on My Cloud: each bot that said
 * on My Cloud that its webhook had a new address says once that it has an address here again; `webhooks`: only these, the
 * ones this computer brought, when My Cloud goes on with other computers' bots. The record of where the bots came from
 * came home with them and goes now. False when the path is not this route. */
export async function homeRoute(deps, { req, res, path, method, json, readBody }) {
    if (path !== "/api/cloud-send/home")
        return false;
    if (method !== "POST") {
        req.resume();
        json(res, 405, { error: "method not allowed" });
        return true;
    }
    const body = homeBody.safeParse(await readBody(req, 64 * 1024));
    if (!body.success) {
        json(res, 400, { error: "send { v: 1 }" });
        return true;
    }
    const only = body.data.webhooks ? new Set(body.data.webhooks) : null;
    const told = (movedFrom(deps.dataDir)?.told ?? []).filter((id) => !only || only.has(id));
    const hooks = deps.webhooks()?.list() ?? [];
    const telling = told.flatMap((id) => {
        const hook = hooks.find((candidate) => candidate.id === id);
        const bot = hook ? deps.store.bot(hook.botId) : null;
        return hook && bot ? [{ name: hook.name, threadId: bot.threadId }] : [];
    });
    // Gone before the lines go: coming home again after a crash here never has a bot say it twice.
    rmSync(join(deps.dataDir, FILE), { force: true });
    for (const line of telling)
        deps.store.appendMessage(line.threadId, botLine("chat.notice.webhookHome", line.name));
    json(res, 200, { v: 1, told: telling.length });
    return true;
}
const KEY = /^(?:routine|call|webhook|app-event):[\w-]{1,128}$/u;
const offBody = z.object({ v: z.literal(1), keys: z.array(z.string().regex(KEY)).max(2_000) });
/** POST /api/cloud-send/automations-off on My Cloud, over its owner's own session, as a computer's bots go home to it while
 * My Cloud goes on: the automations that computer brought, by key, stop here, so none of them runs on both. `off`: those
 * that were on. False when the path is not this route. */
export async function automationsOffRoute(deps, { req, res, path, method, auth, json, readBody }) {
    if (path !== "/api/cloud-send/automations-off")
        return false;
    const refuse = (status, error) => { json(res, status, { error }); return true; };
    if (method !== "POST") {
        req.resume();
        return refuse(405, "method not allowed");
    }
    if (!deps.owner(auth)) {
        req.resume();
        return refuse(403, "Only My Cloud's owner can stop its automations.");
    }
    const body = offBody.safeParse(await readBody(req, 256 * 1024));
    if (!body.success)
        return refuse(400, "send { v: 1, keys }");
    json(res, 200, { v: 1, off: await switchAutomationsOff(deps.automations, new Set(body.data.keys)) });
    return true;
}
