// The agents server on one turn of a conversation. Providers cache a prompt from its start, tool definitions first, so a
// tool that came or went between two turns of one conversation would re-bill the whole conversation at the uncached
// price: what the server lists comes from the conversation alone, and a turn that may not use a listed tool is told why
// when it calls it.
import { AGENTS_PROXY_ENV } from "./agents-bridge-switch.js";
import { roleToolEnv } from "./chief-level.js";
import { TOOLS_OFF_ENV } from "../shared/tool-groups.js";
const flag = (on) => (on ? "1" : "0");
export function agentsServerEnv(conversation, turn, bearer, harnessUrl) {
    const { bot, host } = conversation;
    return {
        ...AGENTS_PROXY_ENV,
        OMB_HARNESS_URL: harnessUrl,
        OMB_BOT_ID: bot.id,
        OMB_THREAD_ID: conversation.threadId,
        OMB_COMMS_TOKEN: bearer(turn),
        OMB_SKILL_AUTHORING_ENABLED: flag(host.skillAuthoring),
        OMB_MEMORY_ENABLED: flag(bot.memoryEnabled !== false),
        OMB_SHARED_COMPUTERS_ENABLED: flag(host.sharedComputers),
        OMB_CLOUD_HOME: flag(host.cloudHome), OMB_TEAM_PEOPLE: flag(host.team), OMB_ROOM: flag(conversation.room),
        OMB_VOICE_NOTES: flag(host.voiceNotes),
        OMB_X_RESEARCH: flag(host.x && bot.xResearch !== false),
        OMB_RESEARCH: flag(host.x && host.research && bot.xResearch !== false),
        ...roleToolEnv(bot),
        OMB_IMAGE_GENERATION: flag(host.imageGeneration),
        OMB_MEETINGS: flag(host.meetings === true && !conversation.room),
        OMB_APP_HOSTING: flag(host.appHosting === true),
        OMB_COMPUTER_SELECTION: flag(!conversation.room && bot.computer !== "off" && !conversation.teamComputer && !conversation.botDriven),
        [TOOLS_OFF_ENV]: (bot.toolsOff ?? []).join(","),
    };
}
/** A conversation a bot opened, the Bot API's, or a routine's run: a fact of the conversation, so its tool list stays the same turn to turn. */
export function botDrivenConversation(task) {
    return Boolean(task && (task.openedBy || task.botApi || task.routineRunId));
}
export function directTurnKind(turn) {
    if (turn.automationSource === "webhook")
        return "webhook";
    if (turn.automationSource === "api")
        return "api";
    if (turn.automationSource !== undefined)
        return "routine";
    if (turn.commsDepth || turn.coordination || turn.peerAsk)
        return "handoff";
    if (turn.cardContinuation || turn.computerSelectionContinuation || turn.unattended || turn.compactOnly)
        return "continuation";
    return "person";
}
const THIS_TURN = {
    routine: "This turn is a routine run",
    webhook: "This turn was started by a webhook",
    api: "This turn came in through the Bot API",
    handoff: "This turn is a teammate's hand-off",
    continuation: "This turn continues earlier work",
};
export const COMPUTER_OFF_REFUSAL = "This bot's Works on setting is Off, so it has no computer to pick. Work without one, or ask the person to choose a place in this bot's settings.";
/** select_computer on a turn that may not pick, `kind` being what started it. */
export function computerPickRefusal(kind) {
    if (kind === undefined || kind === "person")
        return "Picking a computer works only once per request, on a person's own message. Carry on with the computer already in use.";
    return `Picking a computer works only on a person's own message. ${THIS_TURN[kind]}, so carry on with the computer already in use.`;
}
/** skills_list or skill_manage on a room turn that is not the first answer to a person's message. */
export function roomSkillsRefusal(handoff) {
    return `In a room, only the first bot answering a person's message can list or write skills. ${handoff ? THIS_TURN.handoff : "This turn is a follow-up"}, so carry on without changing skills.`;
}
