// Words spoken on a Live call are never logged: such a turn shows `text=(spoken)`.
const LOGGED_CHARS = 70;
export function turnStartLogLine(turn) {
    const text = turn.spoken ? "(spoken)" : JSON.stringify(turn.text.slice(0, LOGGED_CHARS));
    return `[omb-turn] bot=${turn.botId} text=${text} images=${turn.images} depth=${turn.depth} card=${turn.card}`;
}
