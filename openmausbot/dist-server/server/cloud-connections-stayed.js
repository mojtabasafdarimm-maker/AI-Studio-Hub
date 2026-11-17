// What stayed on the person's computer when the bots moved to My Cloud: said to the person in their own words, once when
// the move ends and once in the first conversation they start with each bot that could have used it. A bot's prompt
// says the same (cloud-connections-prompt.ts), but a line from the server is not left to a model.
import { readFileSync } from "node:fs";
import { canUseMcpServer } from "../shared/tool-scope.js";
import { writeFileAtomic } from "./atomic.js";
import { isMailConnector, launcherOf } from "./cloud-connections.js";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.js";
import { serverLine } from "./server-lines.js";
/** The connectors on this Cloud that run on another computer, each with why. One switched off was not working anyway. */
export function stayedConnectors(servers, programs) {
    return Object.entries(servers ?? {}).flatMap(([name, raw]) => {
        const parsed = parseStoredMcpServer(name, raw);
        if (!parsed.ok || !parsed.server.enabled || !parsed.server.runsOn)
            return [];
        const server = parsed.server;
        const remote = isRemoteMcpServer(server);
        const program = remote ? "" : launcherOf(server.command);
        const why = isMailConnector(server) ? { kind: "mail" } : !remote && !/[\\/]/u.test(server.command) && !programs.includes(program) ? { kind: "program", program } : { kind: "here" };
        return [{ name, computer: server.runsOn.label, runsOn: server.runsOn, why, ...(server.bot ? { bot: server.bot } : {}) }];
    });
}
/** Why, as a model reads it: words a bot can pass on. */
export function stayedWhyText(stayed) {
    if (stayed.why.kind === "mail")
        return `a mail connector keeps its accounts on ${stayed.computer}, and a bot here cannot reach a mail server through it; the email tools do that job here, and request_credential with credential_id email connects them`;
    if (stayed.why.kind === "program")
        return `it needs ${stayed.why.program}, which this Cloud does not have`;
    return `it uses files or an address only ${stayed.computer} has`;
}
/** The person's line about one connector. */
export function stayedLine(language, stayed) {
    const { name, computer, why } = stayed;
    if (why.kind === "mail")
        return serverLine(language, "server.moves.connectorStayedMail", { name, computer });
    if (why.kind === "program")
        return serverLine(language, "server.moves.connectorStayedProgram", { name, computer, program: why.program });
    return serverLine(language, "server.moves.connectorStayedHere", { name, computer });
}
export function createStayedNotices(deps) {
    let told = null;
    const record = () => {
        if (told)
            return told;
        try {
            told = JSON.parse(readFileSync(deps.file, "utf8"));
        }
        catch {
            told = {};
        }
        return told;
    };
    const key = (stayed) => `${stayed.computer}\u0000${stayed.name}`;
    const known = (stayed, bot) => record()[key(stayed)]?.includes(bot.id) === true;
    const remember = (stayed, bot) => {
        const all = record();
        (all[key(stayed)] ??= []).push(bot.id);
        try {
            writeFileAtomic(deps.file, JSON.stringify(all), { mode: 0o600 });
        }
        catch (error) {
            console.warn("[connections] could not save what was said about what stayed:", error);
        }
    };
    const stayed = () => stayedConnectors(deps.servers(), deps.programs()).filter((connector) => (connector.why.kind !== "mail" || !deps.mailConnected?.()) && !deps.lent?.(connector.runsOn));
    const serves = (bot, connector) => (connector.bot ? connector.bot === bot.id : !bot.mcpServers || bot.mcpServers.includes(connector.name)) && canUseMcpServer(bot.toolScope, connector.name);
    return {
        /** The move ended: one bot says what stayed, in its own chat, and the person is told outside the chat too. */
        moved(language) {
            const left = stayed().filter((connector) => !deps.bots().some((bot) => known(connector, bot)));
            if (!left.length)
                return;
            const bots = deps.bots();
            const speaker = bots.find((bot) => bot.chiefOfStaff && left.some((connector) => serves(bot, connector))) ?? bots.find((bot) => left.some((connector) => serves(bot, connector)));
            if (!speaker)
                return;
            const lines = left.filter((connector) => serves(speaker, connector));
            // In a chat line a link can be followed; `/?connect=email` opens where a mailbox connects.
            const link = lines.some((connector) => connector.why.kind === "mail") ? `\n\n${deps.origin}/?connect=email` : "";
            const text = `${lines.map((connector) => stayedLine(language ?? deps.language(speaker.threadId), connector)).join("\n\n")}${link}`;
            for (const connector of lines)
                remember(connector, speaker);
            deps.say(speaker.threadId, text, "line");
            deps.notify(text, speaker, speaker.threadId);
        },
        /** A person started a turn with this bot: what it could have used and has not been said here yet, once per bot. */
        personTurn(bot, threadId) {
            for (const connector of stayed()) {
                if (!serves(bot, connector) || known(connector, bot))
                    continue;
                remember(connector, bot);
                deps.say(threadId, stayedLine(deps.language(threadId), connector), "row");
            }
        },
    };
}
