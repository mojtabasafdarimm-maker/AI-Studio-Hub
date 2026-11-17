// Why every routine waits now (routine-holds.ts), on a Cloud home, read from three places: whether any AI of the owner's
// own can still run here (cloud-credit-moves.ts `away`, read with the engines), whether the owner removed every connected
// app and MCP server (marked when the last one goes, cleared when one comes back), and whether the plan was cancelled (the
// Admin's signed request, routes/cloud-signed.ts). What was last read is kept in routine-holds.json, so a restart neither
// frees nor pauses anything before the engines are read again. A cause that begins and pauses routines writes one quiet
// line in the owner's Chief's chat; nothing else is sent, so nobody who left is messaged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { conversationLanguage, serverLine } from "../server-lines.js";
/** While every connection is gone, whether one came back elsewhere (an app connected from another device) is read again at
 * most this often. */
const RECHECK_MS = 15 * 60_000;
/** The owner's one line when a cause begins and pauses routines. */
export const ROUTINE_HOLD_KEYS = {
    plan_cancelled: "server.routines.held.planCancelled",
    no_engine: "server.routines.held.noEngine",
    no_connections: "server.routines.held.noConnections",
};
export function createRoutineHoldsHost(deps) {
    const file = join(deps.dataDir, "routine-holds.json");
    const now = deps.now ?? Date.now;
    let saved = {};
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        saved = { ...(raw.away === true ? { away: true } : {}), ...(raw.planCancelled === true ? { planCancelled: true } : {}), ...(raw.connectionsGone === true ? { connectionsGone: true } : {}) };
    }
    catch { /* none kept yet */ }
    let rechecked = 0;
    let rechecking = false;
    /** The routines, once index.ts has made them (`attach`): what is read before then waits for them. */
    let routines = null;
    function save(next) {
        if (JSON.stringify(next) === JSON.stringify(saved))
            return false;
        saved = next;
        try {
            writeFileAtomic(file, JSON.stringify(saved), { mode: 0o600 });
        }
        catch (error) {
            deps.log?.(`[routines] could not keep why routines wait (${error instanceof Error ? error.name : "error"})`);
        }
        return true;
    }
    function causes() {
        return [...(saved.planCancelled ? ["plan_cancelled"] : []), ...(saved.away ? ["no_engine"] : []), ...(saved.connectionsGone ? ["no_connections"] : [])];
    }
    /** The owner's Chief: the place's own one, else the first made (a Team Cloud's founder's). */
    function tell(cause) {
        const chief = deps.store.bots.filter((bot) => !bot.hidden && bot.chiefOfStaff)
            .sort((a, b) => Number(Boolean(b.defaultBot)) - Number(Boolean(a.defaultBot)) || a.createdAt - b.createdAt)[0];
        if (chief) {
            const line = serverLine(conversationLanguage(chief.threadId), ROUTINE_HOLD_KEYS[cause]);
            deps.store.appendMessage(chief.threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${line}`, ok: true } });
        }
    }
    /** Never throws: it runs inside reading the engines, which must not fail for it. */
    function review() {
        if (!routines)
            return;
        try {
            for (const cause of routines.holdFor(causes()))
                tell(cause);
        }
        catch (error) {
            deps.log?.(`[routines] could not pause or resume routines (${error instanceof Error ? error.message : "error"})`);
        }
        if (saved.connectionsGone && !rechecking && now() - rechecked >= RECHECK_MS)
            void connections("recheck");
    }
    /** A connection removed (the hold begins when none is left), added (it ends), or read again while none was left. */
    async function connections(change) {
        if (change === "added") {
            if (save({ ...saved, connectionsGone: undefined }))
                review();
            return;
        }
        if (change === "removed" && saved.connectionsGone)
            return;
        rechecking = true;
        try {
            const left = deps.mcpServers() > 0 ? true : await deps.appsConnected().catch(() => null);
            rechecked = now();
            // Unreadable: nothing changes on a guess.
            if (left === null)
                return;
            if (save({ ...saved, connectionsGone: left ? undefined : true }))
                review();
        }
        finally {
            rechecking = false;
        }
    }
    return {
        /** The routines are made: what was last read applies to them now. */
        attach(manager) {
            routines = manager;
            review();
        },
        review,
        /** The engines were read: whether no AI of the owner's own can run here, for sure. */
        engines(away) {
            save({ ...saved, away: away ? true : undefined });
            review();
        },
        /** The Admin's word on the plan: cancelled (routines pause), or renewing again (they turn back on). */
        plan(cancelled) {
            save({ ...saved, planCancelled: cancelled ? true : undefined });
            review();
        },
        connections,
        /** The causes holding routines now. */
        causes,
    };
}
