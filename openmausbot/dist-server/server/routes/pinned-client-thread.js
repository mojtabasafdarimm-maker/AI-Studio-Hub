export function pinnedClientThreadGuard(store) {
    return (auth, req) => {
        // The companion marker may only narrow behavior: it never grants authority or replaces the request gate.
        const requirePinnedClientThread = (botId, threadId) => {
            if (threadId === undefined &&
                (auth.kind === "session" || req.headers["x-openmausbot-companion"] === "1") &&
                store.tasks(botId).length > 1) {
                throw Object.assign(new Error("This bot has more than one thread. Update the OpenMausBot app on this device, then choose a thread and try again."), { status: 409 });
            }
        };
        return requirePinnedClientThread;
    };
}
