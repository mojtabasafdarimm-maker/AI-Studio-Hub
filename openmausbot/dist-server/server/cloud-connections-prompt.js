import { toolkitName } from "./activity.js";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.js";
import { stayedConnectors, stayedWhyText } from "./cloud-connections-stayed.js";
const COMPOSIO_TTL_MS = 20_000;
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,80}$/u;
/** `origin`: My Cloud's public address, where `/?connect=<id>` opens the page that connects it. `lent`, in a turn: by
 * name, why each of the bot's servers that runs on the person's computer can't be reached now; one left out reaches the
 * turn through that computer. */
export function createConnectionPrompt(sources, origin) {
    const known = new Map();
    let reading = null;
    let failedAt = 0;
    /** What is known of these apps now; any not read in the last 20 seconds is read in the background, for the next turn.
     * A read that failed waits 20 seconds too. */
    function connected(slugs) {
        const stale = slugs.filter((slug) => Date.now() - (known.get(slug)?.at ?? 0) > COMPOSIO_TTL_MS);
        if (stale.length && !reading && Date.now() - failedAt > COMPOSIO_TTL_MS) {
            reading = sources.composioConnected(stale)
                .then((answer) => { const at = Date.now(); for (const slug of stale)
                known.set(slug, { at, connected: answer[slug] === true }); })
                .catch(() => { failedAt = Date.now(); })
                .finally(() => { reading = null; });
        }
        return slugs.flatMap((slug) => { const entry = known.get(slug); return entry ? [[slug, entry.connected]] : []; });
    }
    const link = (id) => `${origin}/?connect=${encodeURIComponent(id)}`;
    return (bot, lent) => {
        const toConnect = [];
        const elsewhere = new Map();
        for (const stayed of stayedConnectors(sources.mcpServers(), sources.programs?.() ?? [])) {
            if (bot.mcpServers !== undefined && !bot.mcpServers.includes(stayed.name))
                continue;
            elsewhere.set(stayed.computer, [...elsewhere.get(stayed.computer) ?? [], `${stayed.name} (${stayedWhyText(stayed)})`]);
        }
        for (const [name, raw] of Object.entries(sources.mcpServers() ?? {})) {
            if (bot.mcpServers !== undefined && !bot.mcpServers.includes(name))
                continue;
            const parsed = parseStoredMcpServer(name, raw);
            if (!parsed.ok || !parsed.server.enabled)
                continue;
            const server = parsed.server;
            if (!server.runsOn && isRemoteMcpServer(server)) {
                const auth = sources.mcpAuth(name, server.url);
                if (auth === "needs-sign-in" || (auth === "none" && server.oauth))
                    toConnect.push(`${name} (sign in here: ${link(`mcp:${name}`)})`);
            }
        }
        const granted = bot.composio === false ? [] : Object.keys(bot.connectorTools ?? {});
        const apps = connected(granted.filter((slug) => SLUG.test(slug))).filter(([, on]) => !on).map(([slug]) => toolkitName(slug.toUpperCase()));
        const from = sources.movedFrom?.() ?? null;
        return [
            from ? ` You moved to My Cloud from the person's computer ${from}, with everything in OpenMausBot. What lives outside OpenMausBot stayed on ${from}: its other folders and files, passkeys, the person's own browser sessions and apps, Local VM disks and model servers on its home network. When a task needs one, use ${from} if it is lent to My Cloud and online; otherwise say in plain words that it stayed there.` : "",
            toConnect.length ? ` Not connected on My Cloud yet: ${toConnect.join("; ")}. When a task needs one, say in plain words that it needs the person once on My Cloud and give its link; do not try another way.` : "",
            apps.length ? ` Assigned to this bot but not connected on My Cloud yet: ${apps.join(", ")}. When a task needs one, call COMPOSIO_MANAGE_CONNECTIONS for it, which shows the person a card to connect it, and end the turn.` : "",
            ...(lent
                ? (lent.size ? [` Runs on the person's own computer and can't be reached now: ${[...lent.values()].join(" ")} If a task needs one, tell the person that in plain words, and do not write your own replacement.`] : [])
                : [...elsewhere].map(([computer, names]) => ` Runs only on the person's computer ${computer}, not on My Cloud: ${names.join("; ")}. It worked there before the bots moved here. If a task needs one, tell the person in plain words that it stayed on ${computer} and why, not that it was never set up, and do not write your own replacement.`)),
        ].join("");
    };
}
