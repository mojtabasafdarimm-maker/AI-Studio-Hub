import { readStartupModelCacheEntry, unconfirmedModelCatalog, writeStartupModelCache } from "../../startup-model-catalog.js";
export function acpModelCatalog(input) {
    const { instanceId, resolve } = input;
    const saved = resolve ? readStartupModelCacheEntry(instanceId) : null;
    let models = input.startFromSaved ? saved?.catalog ?? input.fixed : input.fixed;
    // A previous run's checkedAt only lets the file stand in. This process confirms the ids when its own read returns them.
    let readFromEngine = false;
    let accountModels = saved?.checkedAt ? idsOf(saved.catalog) : null;
    let current = null;
    const read = async (fresh) => {
        if (!resolve)
            return;
        try {
            const resolved = await resolve(fresh);
            if (resolved.options.length) {
                models = resolved;
                readFromEngine = true;
                accountModels = idsOf(resolved);
            }
            else
                unconfirmedModelCatalog(models);
        }
        catch {
            unconfirmedModelCatalog(models);
        }
        try {
            writeStartupModelCache(instanceId, models);
        }
        catch { }
    };
    return {
        get models() { return models; },
        set models(catalog) { models = catalog; },
        get accountModels() { return accountModels; },
        set accountModels(ids) { accountModels = ids; },
        get unconfirmed() { return Boolean(resolve) && !readFromEngine; },
        refresh(fresh = false) {
            if (current && (current.fresh || !fresh))
                return current.done;
            const next = { fresh, done: (current?.done ?? Promise.resolve()).then(() => read(fresh)) };
            current = next;
            void next.done.finally(() => { if (current === next)
                current = null; });
            return next.done;
        },
    };
}
function idsOf(catalog) {
    return new Set(catalog.options.map((option) => option.id));
}
