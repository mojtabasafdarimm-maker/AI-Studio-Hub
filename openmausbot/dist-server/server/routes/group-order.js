import { PASS } from "./table.js";
const INVALID = "groupIds must be a non-empty array of distinct room ids";
/** The order rooms are listed in the sidebar, the same on every client. A reorder names only the rooms it moves
 * (shared/bot-order.ts): they take the places they already hold together, and every other room keeps its place. */
export function createGroupOrderRoutes(deps) {
    const { store, visibleFor } = deps;
    return async ({ req, res, path, method, auth, json, readBody }) => {
        if (path !== "/api/groups/order" || method !== "PUT")
            return PASS;
        const body = await readBody(req);
        const groupIds = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => key === "groupIds")
            ? body.groupIds : undefined;
        if (!Array.isArray(groupIds) || !groupIds.length || groupIds.some((id) => typeof id !== "string" || !id) || new Set(groupIds).size !== groupIds.length) {
            return json(res, 400, { error: INVALID });
        }
        // A hidden room gets the same answer as a missing one, so the id list cannot probe the workspace.
        const visible = visibleFor(auth);
        for (const id of groupIds) {
            if (!store.group(id) || !visible.group(id))
                return json(res, 400, { error: `unknown room: ${id}` });
        }
        const groups = store.reorderGroups(groupIds);
        if (!groups)
            return json(res, 400, { error: INVALID });
        return json(res, 200, { groupIds: groups.filter((group) => visible.group(group.id)).map((group) => group.id) });
    };
}
