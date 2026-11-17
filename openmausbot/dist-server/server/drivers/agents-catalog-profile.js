import { toolsOffFromEnv } from "../../shared/tool-groups.js";
/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env) {
    return {
        skillAuthoring: env.OMB_SKILL_AUTHORING_ENABLED === "1",
        sharedComputers: env.OMB_SHARED_COMPUTERS_ENABLED === "1",
        voiceNotes: env.OMB_VOICE_NOTES === "1",
        xResearch: env.OMB_X_RESEARCH === "1",
        research: env.OMB_RESEARCH === "1",
        cloudHome: env.OMB_CLOUD_HOME === "1",
        memoryEnabled: env.OMB_MEMORY_ENABLED !== "0",
        chief: env.OMB_CHIEF_OF_STAFF === "1",
        botId: env.OMB_BOT_ID ?? "",
        team: env.OMB_TEAM_PEOPLE === "1",
        mausbot: env.OMB_MAUSBOT === "1",
        computerSelection: env.OMB_COMPUTER_SELECTION === "1",
        room: env.OMB_ROOM === "1",
        imageGeneration: env.OMB_IMAGE_GENERATION === "1",
        meetings: env.OMB_MEETINGS === "1",
        appHosting: env.OMB_APP_HOSTING === "1",
        toolsOff: toolsOffFromEnv(env.OMB_TOOLS_OFF),
    };
}
