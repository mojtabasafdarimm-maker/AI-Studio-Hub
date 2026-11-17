/** MausBot: every person's built-in helper. A new install's first bot (its Chief of Staff too); an existing place or
 * person without one is given one once. It can be renamed and recoloured, hidden from the sidebar, never deleted. */
export const DEFAULT_BOT_NAME = "MausBot";
export const DEFAULT_BOT_COLOR = "chrome";
export const defaultBotPerson = (bot) => bot.defaultBot?.person?.trim().toLowerCase() ?? "";
/** The MausBot a viewer sees as theirs: their own on a Team Cloud (by email), else the place's. */
export function viewersDefaultBot(bots, email) {
    const person = email?.trim().toLowerCase() ?? "";
    return (person ? bots.find((bot) => bot.defaultBot && defaultBotPerson(bot) === person) : undefined)
        ?? bots.find((bot) => bot.defaultBot && !defaultBotPerson(bot));
}
/** A MausBot hidden from the sidebar comes back when it is renamed or moved to another department, unless the same
 * change says whether to show it. Returns the patch to save. */
export function reshowWhenMoved(bot, patch) {
    if (!bot.defaultBot || !bot.sidebarHidden || Object.hasOwn(patch, "sidebarHidden"))
        return patch;
    const renamed = patch.name !== undefined && patch.name.trim() !== bot.name.trim();
    const moved = Object.hasOwn(patch, "section") && (patch.section?.trim() ?? "") !== (bot.section?.trim() ?? "");
    return renamed || moved ? { ...patch, sidebarHidden: false } : patch;
}
