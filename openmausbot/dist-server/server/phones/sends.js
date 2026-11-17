export function createPhoneSends(limit = 500) {
    const ids = new Set();
    return {
        note(sendId) {
            ids.delete(sendId);
            ids.add(sendId);
            for (const oldest of ids) {
                if (ids.size <= limit)
                    break;
                ids.delete(oldest);
            }
        },
        has: (sendId) => sendId !== undefined && ids.has(sendId),
    };
}
