export const MAX_BULK_DELETE_THREADS = 500;
/** The distinct thread ids of a bulk delete body, or the 400 error to answer with. */
export function bulkDeleteThreadIds(body) {
    if (!body || typeof body !== "object" || Array.isArray(body))
        return { ok: false, error: "body must be a JSON object" };
    const ids = body.threadIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DELETE_THREADS
        || ids.some((id) => typeof id !== "string" || id === "")) {
        return { ok: false, error: `threadIds must be 1-${MAX_BULK_DELETE_THREADS} thread ids` };
    }
    return { ok: true, threadIds: [...new Set(ids)] };
}
