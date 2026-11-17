const GMAIL = { slug: "gmail", label: "Gmail" };
const CALENDAR = { slug: "googlecalendar", label: "Google Calendar" };
const BY_HOST = { "gmailmcp.googleapis.com": GMAIL, "calendarmcp.googleapis.com": CALENDAR };
/** At any other address, only a name that is the app's own: "gmail-filters" or "gcal2notion" is another tool. */
const BY_NAME = [
    [/^gmail(?:[-_]mcp)?$/i, GMAIL],
    [/^(?:google[-_]?calendar|gcal(?:endar)?)(?:[-_]mcp)?$/i, CALENDAR],
];
export function knownMcpServerApp(name, url) {
    const host = URL.canParse(url) ? new URL(url).hostname.toLowerCase() : "";
    return (Object.hasOwn(BY_HOST, host) ? BY_HOST[host] : undefined) ?? BY_NAME.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}
