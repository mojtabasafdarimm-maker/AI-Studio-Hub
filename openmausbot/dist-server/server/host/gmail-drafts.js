export function createGmailDrafts(deps) {
    const byGeneration = new Map();
    const byNode = new Map();
    function forNode(id) {
        for (const cachedId of byNode.keys()) {
            const node = deps.node(cachedId);
            if (!node || deps.ended(node.status))
                byNode.delete(cachedId);
        }
        const node = deps.node(id);
        if (!node)
            return undefined;
        const cached = byNode.get(id);
        if (cached)
            return cached;
        const owner = deps.owner(node.threadId);
        const reserved = owner?.generations.has(id) && owner.gmailDrafts ? owner.gmailDrafts :
            (node.parentId ? forNode(node.parentId) : undefined) ?? new Set();
        byNode.set(id, reserved);
        return reserved;
    }
    return {
        forNode,
        forTurn(threadId, generation, handoffId) {
            const cached = byGeneration.get(generation);
            if (cached)
                return cached;
            const owner = deps.owner(threadId);
            const reserved = owner?.generation === generation && owner.gmailDrafts ? owner.gmailDrafts :
                forNode(handoffId ?? generation) ?? new Set();
            byGeneration.set(generation, reserved);
            return reserved;
        },
        forRoomTurn(generation, handoffId) {
            byGeneration.set(generation, forNode(handoffId) ?? new Set());
        },
        endTurn(generation) {
            byGeneration.delete(generation);
        },
    };
}
