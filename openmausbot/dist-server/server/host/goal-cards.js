import { fittedLine } from "../routine-lines.js";
import { redactSecretsInText } from "../../shared/redact.js";
import { GROUP_GOAL_MAX_TURNS } from "../group-goal-run.js";
import { buildNotification } from "../notify.js";
import { conversationLanguage, serverLine } from "../server-lines.js";
function detailFields(detail, text) {
    const { text: safe, codes } = fittedLine("attention", detail, text);
    return { detail: safe, detailCode: codes.attentionCode, detailParams: codes.attentionParams };
}
/** A goal card's text for clients that show no cards, by how the goal stands. */
const GOAL_STATE = {
    working: "server.teammates.goal.working",
    completed: "server.teammates.goal.completed",
    "needs-input": "server.teammates.goal.needsInput",
    blocked: "server.teammates.goal.blocked",
    "limit-reached": "server.teammates.goal.limitReached",
    paused: "server.teammates.goal.paused",
    stopped: "server.teammates.goal.stopped",
    failed: "server.teammates.goal.failed",
};
export function createGoalCards(deps) {
    const { store } = deps;
    function start(threadId, coordinator, goal, runId) {
        const startedAt = Date.now(), language = conversationLanguage(threadId);
        const detail = serverLine(language, "server.teammates.goalCoordinating", { bot: coordinator.name });
        const card = store.appendMessage(threadId, {
            role: "bot",
            kind: "goal.run",
            text: serverLine(language, "server.teammates.goal.working", { detail }),
            from: { botId: coordinator.id, name: coordinator.name, color: coordinator.color },
            goalRun: {
                runId,
                goal,
                status: "working",
                coordinatorBotId: coordinator.id,
                coordinatorName: coordinator.name,
                turnCount: 0,
                maxTurns: GROUP_GOAL_MAX_TURNS,
                detail,
                startedAt,
            },
        });
        return {
            runId,
            cardMessageId: card.id,
            goal,
            coordinatorBotId: coordinator.id,
            coordinatorName: coordinator.name,
            turnCount: 0,
            maxTurns: GROUP_GOAL_MAX_TURNS,
            startedAt,
            finished: false,
        };
    }
    /** `stillHere` is false once the conversation is gone: the routine still settles, the card is not touched. */
    function finish(threadId, run, status, detail, stillHere, text) {
        if (!run || run.finished)
            return;
        run.finished = true;
        const finishedAt = Date.now();
        const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
        const card = {
            runId: run.runId,
            goal: redactSecretsInText(run.goal),
            status,
            coordinatorBotId: run.coordinatorBotId,
            coordinatorName: redactSecretsInText(run.coordinatorName),
            turnCount: run.turnCount,
            maxTurns: run.maxTurns,
            ...detailFields(safeDetail, text),
            startedAt: run.startedAt,
            finishedAt,
        };
        const routineRun = deps.routines()?.finishGoalRun(run.runId, status, safeDetail);
        // A scheduled team goal that stops to ask must never be filed as a quiet completion.
        if (routineRun?.status === "waiting") {
            const coordinator = store.bot(routineRun.botId);
            if (coordinator) {
                const notificationBot = deps.routineSourceOwner(routineRun)?.bot ?? coordinator;
                deps.notify(buildNotification("question", notificationBot, deps.routineSourceThread(routineRun) ?? routineRun.threadId ?? threadId, safeDetail || `${routineRun.routineName} needs your input`, { avatarUrl: notificationBot.avatarUrl }));
            }
        }
        if (routineRun?.status === "completed") {
            const coordinator = store.bot(routineRun.botId);
            if (coordinator) {
                const notificationBot = deps.routineSourceOwner(routineRun)?.bot ?? coordinator;
                deps.notify(buildNotification("done", notificationBot, deps.routineSourceThread(routineRun) ?? routineRun.threadId ?? threadId, safeDetail || routineRun.routineName, { avatarUrl: notificationBot.avatarUrl }));
            }
        }
        if (!stillHere())
            return;
        store.patchMessage(threadId, run.cardMessageId, {
            text: serverLine(conversationLanguage(threadId), GOAL_STATE[status] ?? "server.teammates.goal.failed", { detail: card.detail || card.goal }),
            goalRun: card,
        });
    }
    function progress(threadId, run, detail, text) {
        if (!run || run.finished)
            return;
        const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
        const current = store.messagesFor(threadId).find((message) => message.id === run.cardMessageId);
        const fields = detailFields(safeDetail, text);
        if (current?.goalRun?.status === "working" && current.goalRun.detail === safeDetail && current.goalRun.detailCode === fields.detailCode
            && JSON.stringify(current.goalRun.detailParams) === JSON.stringify(fields.detailParams))
            return;
        store.patchMessage(threadId, run.cardMessageId, {
            text: serverLine(conversationLanguage(threadId), "server.teammates.goal.working", { detail: safeDetail || redactSecretsInText(run.goal) }),
            goalRun: {
                runId: run.runId,
                goal: redactSecretsInText(run.goal),
                status: "working",
                coordinatorBotId: run.coordinatorBotId,
                coordinatorName: redactSecretsInText(run.coordinatorName),
                turnCount: run.turnCount,
                maxTurns: run.maxTurns,
                ...fields,
                startedAt: run.startedAt,
            },
        });
    }
    return { start, finish, progress };
}
