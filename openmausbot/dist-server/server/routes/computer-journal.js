import { hostScope, parseJournalEntry } from "../saved-steps/journal.js";
import { COMPUTER_JOURNAL_PATH } from "../saved-steps/journal-tap.js";
import { PASS } from "./table.js";
export function createComputerJournalRoutes(deps) {
    // Known open risk: the bearer reaches the engine with the bridge's environment, so an engine that reads it can add
    // entries. The gate-check count and the saveability rules bound what a forged entry can make a replay do.
    return async ({ res, path, method, json }) => {
        if (path !== COMPUTER_JOURNAL_PATH || method !== "POST")
            return PASS;
        const scope = hostScope(deps.capability);
        if (!scope)
            return json(res, 403, { error: "only a host computer turn journals" });
        if (!deps.enabled())
            return json(res, 200, { ok: true, recorded: false });
        const entry = parseJournalEntry(await deps.readBody());
        if (!entry)
            return json(res, 400, { error: "malformed journal entry" });
        deps.record(scope, entry);
        return json(res, 200, { ok: true });
    };
}
