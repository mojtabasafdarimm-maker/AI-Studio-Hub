// A bot's own threads: list_models, start_thread and the thread's turn start share one check, so a model the list offers
// always opens, and a second opinion never quietly comes from the opener's own model.
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode.js";
import { modelMenu } from "../routes/internal-models.js";
export function createOwnThreads(deps) {
    const { store } = deps;
    const own = (requester, child) => requester.botId === child.botId && !requester.groupId && !child.groupId;
    const cannotRun = (selection, bot) => {
        const givesWay = deps.givesWay(selection, bot.modelSelection);
        return givesWay && `${deps.modelName(selection)} can't run now: ${givesWay === "signed-out" ? "it is signed out" : "its engine is unavailable"}.`;
    };
    const refusal = (selection, bot) => deps.proposalRefusal(selection, bot) ?? cannotRun(selection, bot);
    return {
        own,
        refusal,
        /** A report-back thread whose model can no longer run fails with this reason instead of running on the bot's own model. */
        swapRefusal(bot, threadId) {
            const chosen = store.taskByThread(bot.id, threadId)?.modelSelection;
            const reason = chosen && cannotRun(chosen, bot);
            return reason ? `${reason} Nothing ran on another model in its place; open it again on a model list_models offers.` : null;
        },
        /** `thread` is a report-back thread `botId` opened from `fromThreadId`: its opener may steer it or send it follow-ups. */
        steersOwn(thread, botId, fromThreadId) {
            const openedBy = thread === "new" || thread === "standing" ? undefined : store.taskByThread(botId, thread)?.openedBy;
            return openedBy?.botId === botId && openedBy.threadId === fromThreadId && openedBy.kind === undefined && !openedBy.roomLane;
        },
        /** `answers` names a question one of `botId`'s own threads waits on: with steersOwn, the only messages a bot may address to itself. */
        answersOwn(answers, botId) {
            const asked = answers === undefined ? undefined : deps.node(answers);
            const requester = asked?.parentId === undefined ? undefined : deps.node(asked.parentId);
            return Boolean(asked && requester && requester.botId === botId && own(requester, asked));
        },
        /** "ask" when running on `selection` crosses to an engine where this bot's permission level does not carry over. */
        approvalFor(bot, selection) {
            return modelSwitchNeedsAsk(approvalModeFor(bot), deps.registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, deps.registry.cliTarget(selection.instanceId)?.driverKind) ? "ask" : undefined;
        },
        inherited(botId, parentThreadId) {
            const bot = store.bot(botId);
            const modelSelection = bot && store.taskByThread(bot.id, parentThreadId)?.modelSelection;
            if (!bot || !modelSelection)
                return {};
            const needsAsk = modelSwitchNeedsAsk(approvalModeFor(bot), deps.registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, deps.registry.cliTarget(modelSelection.instanceId)?.driverKind);
            return { modelSelection, ...(needsAsk ? { approvalMode: "ask" } : {}) };
        },
        name(requester, child) {
            return own(requester, child) ? `#${store.taskByThread(child.botId, child.threadId)?.title ?? "Thread"}` : undefined;
        },
        label(child) {
            const task = store.taskByThread(child.botId, child.threadId);
            return ` (your thread #${task?.title ?? "Thread"}${task?.modelSelection ? `, on ${task.modelSelection.model}` : ""})`;
        },
        menu(botId, threadId, search) {
            const bot = store.bot(botId);
            if (!bot)
                return null;
            const current = deps.current(botId, threadId) ?? bot.modelSelection;
            return modelMenu({ engines: deps.registry.instances(), current, pinned: [bot.modelSelection], refusal: (selection) => refusal(selection, bot),
                down: (engine) => deps.givesWay({ instanceId: engine.instanceId, model: engine.models.default }, bot.modelSelection) === "unavailable", search });
        },
    };
}
