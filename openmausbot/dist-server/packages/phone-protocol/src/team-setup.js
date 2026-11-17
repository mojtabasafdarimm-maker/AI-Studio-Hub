/** A new bot gets no cloud computer until the person writes in its chat, unless it is set to work on one (it then starts one on its first turn), uses a VPS or the team's computer. */
export function startsWithoutCloudComputer(bot, place) {
    return place.cloudOn && !place.teamComputer && bot.cloudBackend !== "vps" && bot.computer !== "cloud";
}
/** Told to a Chief about a bot it just made that has no cloud computer of its own yet. */
export function noCloudComputerNote(name) {
    return ` @${name} has no cloud computer yet: work you hand it runs without one until the person writes to it in its own chat, which sets one up. If its first job needs a computer, tell the person that in one line.`;
}
/** The Chief's resumed turn once its team setup card is decided. `lacksComputer` names newly created bots with no cloud computer yet. */
export function teamSetupDecisionText(request, lacksComputer) {
    const bare = request.result?.state === "applied" ? request.result.bots.filter((bot) => bot.action === "created" && lacksComputer(bot.id)) : [];
    return `OpenMausBot team setup decision ${request.requestId}: ${JSON.stringify(request.result)}. Report this exact result and continue the user's already requested work. Do not ask for confirmation again or repeat this setup/deletion. A denied or cancelled operation did not authorize any substitute action. Existing thread models were not changed.${bare.map((bot) => noCloudComputerNote(bot.name)).join("")}`;
}
