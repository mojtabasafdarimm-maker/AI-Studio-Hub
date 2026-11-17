import { ComputerAsks } from "../computer-asks.js";
import { PASS } from "../routes/table.js";
import { ASK_FOR_COMPUTER_TOOL, COMPUTER_NEEDS } from "../../shared/computer-ask.js";
export function createComputerAsksHost(deps) {
    const { store } = deps;
    const asks = new ComputerAsks({
        store,
        notify: deps.notify,
        online: () => deps.lending.lendingNow(deps.principal),
        known: () => deps.lending.known(deps.principal),
        carryOn: ({ botId, threadId, requestMessageId }, text) => {
            if (!store.taskByThread(botId, threadId))
                return true;
            if (deps.threadBusy(botId, threadId) || deps.queued(botId, threadId))
                return false;
            // Someone wrote since the bot asked: they lead now.
            if (store.activePath(threadId).findLast((message) => message.role === "user" && message.kind === "text")?.id !== requestMessageId)
                return true;
            void deps.continueRequest(botId, text, { threadId, cardContinuation: true, requestMessageId }).catch((error) => {
                console.warn(`computer asks: the request could not go on: ${error instanceof Error ? error.message : String(error)}`);
            });
            return true;
        },
    });
    deps.lending.changed = () => asks.lendingChanged();
    deps.lending.askTool = ASK_FOR_COMPUTER_TOOL;
    const roomMember = (turn) => store.groupByThread(turn.threadId)?.memberIds.includes(turn.botId) ? store.bot(turn.botId) ?? null : null;
    /** POST /api/internal/computer-asks: { need, why } from a bot's turn. */
    async function call(turn, body) {
        const input = body && typeof body === "object" ? body : {};
        if (!deps.active(turn))
            return { status: 401, body: { error: "This turn has ended." } };
        const need = COMPUTER_NEEDS.find((candidate) => candidate === input.need);
        if (!need)
            return { status: 400, body: { error: `need must be one of ${COMPUTER_NEEDS.join(", ")}` } };
        const bot = store.projectBotForTask(turn.botId, turn.threadId) ?? roomMember(turn);
        if (!bot)
            return { status: 404, body: { error: "This bot no longer exists." } };
        if (need === "screen" && bot.computer === "off") {
            return { status: 403, body: { error: "This bot has no computer. Change its Computer setting to use their computer's apps and screen." } };
        }
        const refused = deps.refusal(turn);
        if (refused)
            return { status: 403, body: { error: refused } };
        const request = deps.request(turn.threadId);
        const requestMessageId = request?.messageId && !request.stopped && request.generations.has(turn.generation) ? request.messageId : undefined;
        const reply = await asks.ask({ threadId: turn.threadId, bot, need, why: input.why, ...(requestMessageId ? { requestMessageId } : {}) });
        return { status: 200, body: { state: reply.state, text: ComputerAsks.say(reply, bot.name) } };
    }
    /** Inside index.ts's /api/internal/ block, after the capability bearer is checked: this route, or PASS. */
    async function internal(ctx) {
        if (ctx.method !== "POST" || ctx.path !== "/api/internal/computer-asks")
            return PASS;
        const answer = await call(ctx.turn, await ctx.readBody());
        ctx.json(ctx.res, answer.status, answer.body);
    }
    return { asks, call, internal };
}
