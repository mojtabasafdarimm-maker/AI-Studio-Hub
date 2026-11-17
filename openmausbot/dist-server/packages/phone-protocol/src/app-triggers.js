export const APP_FILTER_MAX = 200;
export const GMAIL_APP = "gmail";
export const GMAIL_NEW_MESSAGE = "GMAIL_NEW_GMAIL_MESSAGE";
const quoted = (value) => {
    const clean = value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
    return /\s/.test(clean) ? `"${clean}"` : clean;
};
/** Gmail search syntax for a plain filter: from:, subject:, label: and free words, so filtering happens at the source. */
export function gmailSearchQuery(filter) {
    if (!filter)
        return "";
    return [
        filter.from && `from:${quoted(filter.from)}`,
        filter.subject && `subject:(${filter.subject.replace(/[()\\]/g, " ").replace(/\s+/g, " ").trim()})`,
        filter.label && `label:${quoted(filter.label).replace(/\s+/g, "-")}`,
        filter.text && quoted(filter.text),
    ].filter(Boolean).join(" ");
}
/** Whether Composio filters this app's events itself from the plain filter (its config), or OpenMausBot does on arrival. */
export function filtersAtSource(app) {
    return app === GMAIL_APP;
}
/** A bot may watch an app its connected-app settings let it use: the same grants and scopes its tool calls meet. */
export function botMayWatchApp(bot, app) {
    if (bot.composio === false)
        return false;
    if (bot.connectorTools !== undefined && !Object.hasOwn(bot.connectorTools, app))
        return false;
    if (bot.connectorScopes !== undefined && !Object.hasOwn(bot.connectorScopes.apps, app))
        return false;
    return true;
}
