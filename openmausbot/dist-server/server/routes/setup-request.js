// The setup card under a new bot's greeting (server/setup-request.ts): POST is a pick (with its words) or "Something
// else" (without), DELETE the x on the card or its chip. Open to anyone who may write in that conversation (client
// scope, like sending a message): a pick does nothing a typed /setup could not.
import { ownerOrAdmin } from "../request-auth.js";
import { askForSetup, cancelSetupRequest } from "../setup-request.js";
import { PASS } from "./table.js";
import { refusalBody, userError } from "../user-errors.js";
const PATH = /^\/api\/bots\/([\w-]+)\/setup-request$/;
const ID = /^[\w-]{1,128}$/;
const PICK_LIMIT = 500;
export function createSetupRequestRoutes(deps) {
    /** Conversations whose pick is on its way: a second tap, a letter key or another tab must not send it twice. */
    const picking = new Set();
    return async ({ req, res, path, method, auth, json, readBody }) => {
        const m = path.match(PATH);
        if (!m || (method !== "POST" && method !== "DELETE"))
            return PASS;
        const botId = m[1];
        const body = await readBody(req, 2048);
        const threadId = typeof body?.threadId === "string" ? body.threadId : "";
        if (!ID.test(threadId))
            return json(res, 400, { error: "threadId is required" });
        if (!deps.store.bot(botId))
            return json(res, 404, { error: "no such bot" });
        const refused = deps.sendRefusal(auth, threadId);
        if (refused)
            return json(res, 403, { error: refused });
        if (method === "DELETE") {
            // An owner or admin may clear someone else's, so one never strands the chat.
            const outcome = cancelSetupRequest(deps.store, botId, threadId, deps.presser(auth), { admin: ownerOrAdmin(auth) });
            if (outcome === "unknown")
                return json(res, 404, userError("serverError.setup.missingConversation"));
            if (outcome === "refused")
                return json(res, 403, userError("serverError.setup.stopOwner"));
            return json(res, 200, { ok: true });
        }
        const picked = body?.text === undefined ? undefined : typeof body.text === "string" ? body.text.trim() : "";
        if (picked !== undefined && (!picked || picked.length > PICK_LIMIT)) {
            return json(res, 400, { error: `text must be the words of a choice, at most ${PICK_LIMIT} characters` });
        }
        if (deps.store.taskByThread(botId, threadId) && !deps.canSetUp(botId, threadId))
            return json(res, 409, userError("serverError.setup.noTools"));
        const key = `${botId}:${threadId}`;
        if (picking.has(key))
            return json(res, 409, { ...userError("serverError.chat.answerSent") });
        const asked = askForSetup(deps.store, botId, threadId, deps.language(), deps.presser(auth), picked !== undefined);
        if (!asked.ok)
            return json(res, asked.status, refusalBody(asked));
        if (picked === undefined)
            return json(res, 200, asked);
        picking.add(key);
        try {
            const sent = await deps.send(auth, botId, threadId, picked);
            return json(res, 200, { ok: true, ...(sent.message ? { message: sent.message } : {}) });
        }
        catch (error) {
            const status = error?.status;
            if (typeof status !== "number")
                throw error;
            deps.store.patchTask(botId, threadId, { setupRequest: undefined });
            return json(res, status, { error: error instanceof Error ? error.message : String(error) });
        }
        finally {
            picking.delete(key);
        }
    };
}
