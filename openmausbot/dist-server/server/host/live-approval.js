/** A running turn's approval decisions use the conversation's saved level at the moment each one is made, never a copy
 * taken when the turn started, judged on the engine the turn runs on. */
export function createLiveApprovalMode(deps) {
    return (running, threadId, peerInitiated) => {
        const saved = deps.store.projectBotForTask(running.id, threadId);
        return deps.turnLevel(saved ? { ...saved, modelSelection: running.modelSelection } : running, peerInitiated, threadId);
    };
}
