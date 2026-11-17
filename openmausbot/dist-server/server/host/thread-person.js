export function linePersonKey(message) {
    return message?.role === "user" && !message.peerAsk ? message.sender?.id : undefined;
}
export function createCardRequester(store) {
    return function cardRequesterKey(threadId, requestId) {
        const thread = store().messagesFor(threadId);
        const index = thread.findIndex((message) => message.card?.requestId === requestId);
        if (index < 0)
            return undefined;
        const card = thread[index];
        return linePersonKey(card.requestMessageId
            ? thread.find((message) => message.id === card.requestMessageId)
            : thread.slice(0, index).findLast((message) => message.role === "user"));
    };
}
