import { randomUUID } from "node:crypto";
import { botFolder } from "../bot-folder.js";
import { createComputerJournalRoutes } from "../routes/computer-journal.js";
import { createSavedStepsRoutes } from "../routes/saved-steps.js";
import { openComputerCaller } from "./computer-client.js";
import { SavedStepsDispatch } from "./dispatch.js";
import { ComputerJournal, hostScope } from "./journal.js";
import { buildRecipe, otherToolsHarmless, personTextRequest } from "./rules.js";
import { RecipeStore } from "./store.js";
export { COMPUTER_JOURNAL_PATH } from "./journal-tap.js";
export const personRequest = (owner) => owner.automation === undefined && owner.origin?.kind === "user";
export function savedStepsEnabled(cfg) {
    return cfg.features?.savedSteps !== false;
}
const keepsFromSaving = (event) => (event.type === "request.resolved" && event.behavior !== "allow") || (event.type === "turn.completed" && (event.denials?.length ?? 0) > 0);
export function createSavedSteps(deps) {
    const platform = deps.platform ?? process.platform;
    // Linux and Windows ship the cua-driver 0.41.3 Rust build; neither has been shown to answer list_windows and elements_complete as replay needs.
    const enabled = () => platform === "darwin" && deps.enabled();
    const journal = new ComputerJournal();
    const now = deps.now ?? Date.now;
    const recipes = new RecipeStore({ folder: deps.folder ?? botFolder, now: deps.now });
    const taint = (threadId) => {
        const generation = deps.generation(threadId);
        if (generation === undefined)
            return false;
        journal.taint({ threadId, generation });
        return true;
    };
    const dispatch = new SavedStepsDispatch({
        recipes,
        enabled,
        publish: deps.publish,
        engines: deps.engines,
        stopped: deps.stopped,
        openCaller: openComputerCaller,
        taint,
        withholdHandoff: deps.withholdHandoff,
        contextChanged: deps.contextChanged,
    });
    const markOrSave = ({ botId, threadId, request, reply, after, automated }, taken) => {
        const replayed = reply.turnId === undefined ? undefined : dispatch.replayed(threadId, reply.turnId);
        if (replayed !== undefined) {
            recipes.touch(botId, replayed);
            if (request.quickModel !== undefined)
                deps.patchMessage(threadId, request.id, { quickModel: undefined });
            deps.patchMessage(threadId, reply.id, { savedSteps: { recipeId: replayed, replayed: true } });
            return;
        }
        if (!enabled() || automated || !taken?.calls.length || !personTextRequest(request) || after.some((line) => line.role === "user") || !otherToolsHarmless(after))
            return;
        const built = buildRecipe({ request: request.text ?? "", journal: taken, id: randomUUID(), now: now() });
        if (!built.ok || !dispatch.wouldReplay(threadId, built.recipe))
            return;
        recipes.save(botId, built.recipe);
        deps.patchMessage(threadId, reply.id, { savedSteps: { recipeId: built.recipe.id, learned: true } });
    };
    return {
        journal,
        recipes,
        dispatch,
        routes: createSavedStepsRoutes({ bot: deps.bot, forget: (botId, id) => recipes.forget(botId, id) }),
        gateChecked(capability) {
            const scope = hostScope(capability);
            if (scope)
                journal.gateChecked(scope);
            else if (capability.kind === "computer")
                journal.taint({ threadId: capability.threadId, generation: capability.generation });
        },
        journals: (owner) => owner?.personLine === true && personRequest(owner) && enabled(),
        here: () => platform === "darwin",
        journalRoutes: (internal) => createComputerJournalRoutes({ ...internal, enabled, record: (scope, entry) => journal.record(scope, entry) }),
        requestSettled(settled) {
            const taken = journal.take(settled.threadId, settled.generations);
            const unmarked = dispatch.takeUnmarked(settled.threadId);
            try {
                markOrSave(settled, unmarked ? null : taken);
            }
            catch (error) {
                console.warn(`saved steps for ${settled.botId} on ${settled.threadId} not saved: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
        requestEnded(threadId, generations) {
            journal.take(threadId, generations);
            dispatch.takeUnmarked(threadId);
        },
        observe(event) {
            if (keepsFromSaving(event))
                taint(event.threadId);
        },
    };
}
