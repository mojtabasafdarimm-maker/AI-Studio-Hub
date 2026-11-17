import { z } from "zod";
import { INSTRUCTIONS_MAX, ITEM_MAX } from "../burst/manager.js";
import { refusalText } from "../user-errors.js";
import { PASS } from "./table.js";
const LIST_MAX = 1_000;
const itemsSchema = z.array(z.string().min(1).max(ITEM_MAX)).max(LIST_MAX);
const editSchema = z.object({ instructions: z.string().max(INSTRUCTIONS_MAX).optional(), items: itemsSchema.optional() }).strict();
/** A burst's card reads its rows here and acts here. Run is reachable only from a person's press: no bot tool can call it. */
export function createBurstRoutes(deps) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        const match = /^\/api\/bursts\/([\w-]+)(?:\/(run|cancel|retry|edit))?$/.exec(path);
        if (!match)
            return PASS;
        const [, id, action] = match;
        const owner = deps.owner(id);
        if (!owner || !deps.sees(auth, owner.threadId))
            return json(res, 404, { error: "That burst is gone." });
        if (!action) {
            if (method !== "GET")
                return json(res, 405, { error: "method not allowed" });
            return json(res, 200, deps.view(id));
        }
        if (method !== "POST")
            return json(res, 405, { error: "method not allowed" });
        const refused = deps.refusal(auth, owner.threadId, id);
        if (refused)
            return json(res, 403, refusalText(refused));
        let result;
        if (action === "edit") {
            const parsed = editSchema.safeParse(await readBody(req));
            if (!parsed.success)
                return json(res, 400, { error: "That edit doesn't fit." });
            result = deps.edit(id, parsed.data);
        }
        else {
            result = deps[action](id);
        }
        return "refused" in result ? json(res, 409, { error: result.refused }) : json(res, 200, result);
    };
}
const proposalSchema = z.object({
    task: z.string().min(1).max(4_000),
    instructions: z.string().max(INSTRUCTIONS_MAX),
    items: itemsSchema.min(1),
}).strict();
/** The burst tool: a preview card and nothing more. */
export function createBurstProposalRoutes(deps) {
    return async ({ res, path, method, json }) => {
        if (path !== "/api/internal/bursts")
            return PASS;
        if (method !== "POST")
            return json(res, 405, { error: "method not allowed" });
        deps.requireActive();
        const refused = deps.refusal();
        if (refused)
            return json(res, 403, { error: refused });
        const parsed = proposalSchema.safeParse(await deps.readBody());
        if (!parsed.success)
            return json(res, 400, { error: "A burst needs a task, instructions and a list of items." });
        const model = deps.model();
        const card = deps.propose({ ...parsed.data, model: model.selection, modelName: model.name });
        return "refused" in card ? json(res, 400, { error: card.refused }) : json(res, 201, card);
    };
}
