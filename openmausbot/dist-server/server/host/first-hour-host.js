// Wires a new Cloud's first hour into the server (server/host/README.md): the counts every personal Cloud keeps, the
// hooks the brief and the read-and-draft fence call before the first hour exists, and the first hour itself once its
// Chief and services are up.
import { CLOUD_WELCOME_DONE } from "../../shared/cloud-hints.js";
import { createFirstHour, LOOK_APPS } from "./first-hour.js";
import { proactiveOwner } from "./proactive-owner.js";
import { createValueLedger, valueReport } from "./value-ledger.js";
/** Made before the proactive Chief, on a personal Cloud: the first hour attaches to it later. */
export function createFirstHourHooks(options) {
    const ledger = options.personal ? createValueLedger({ dataDir: options.dataDir }) : null;
    let current = null;
    return {
        ledger,
        /** For createProactive: the counts, the first look's fence and the morning brief. */
        proactive: {
            counted: (kind, count) => ledger?.add(kind, count),
            look: (threadId) => current?.look(threadId) ?? null,
            morning: {
                at: () => current?.morningAt(),
                push: (summary) => current?.morningPush(summary) ?? summary,
                overnight: (since) => (ledger ? current?.overnight(ledger.since(since)) : undefined),
            },
        },
        attach(firstHour) { current = firstHour; },
        /** The first day's words for the Chief's own chat, or nothing. */
        prompt: (botId, threadId) => current?.prompt(botId, threadId) ?? "",
        arrived: () => current?.arrived(),
        health: () => ({
            ...(current?.health() ? { firstHour: current.health() } : {}),
            ...(ledger ? { value: valueReport(current?.tally() ?? { ...ledger.totals(), routines: 0 }) } : {}),
        }),
    };
}
/** Null where there is no first hour: anything but a personal Cloud, or one made before it existed. */
export function startFirstHour(deps) {
    if (!deps.hooks.ledger)
        return null;
    const { store, cfg, composio } = deps;
    const firstHour = createFirstHour({
        store, dataDir: deps.dataDir,
        chief: () => proactiveOwner(store),
        mainThread: deps.mainThread, threadBusy: deps.threadBusy,
        person: () => {
            const name = cfg.profile?.name?.trim();
            const email = deps.sessions.list().find((session) => session.scopes.includes("admin") && session.owner)?.owner;
            return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
        },
        language: () => deps.proactive.brief.language(),
        timeZone: () => deps.proactive.brief.timeZone(),
        apps: {
            reachable: (bot) => composio.configured(cfg) && bot.composio !== false,
            connected: async () => {
                if (!composio.configured(cfg))
                    return null;
                const services = await composio.connectedServices(cfg);
                return Object.fromEntries(LOOK_APPS.map((app) => [app, services[app]?.connected === true]));
            },
            card: async (slug) => {
                const card = await composio.toolkitCard(cfg, slug);
                return { label: card.label, description: card.blurb ?? "" };
            },
        },
        briefOn: deps.briefOn,
        ensureBrief: deps.ensureBrief,
        phones: deps.phones,
        startTurn: deps.startTurn,
        notify: (bot, threadId, body) => deps.notify(bot.notifications === false ? null : { kind: "brief", botId: bot.id, botName: bot.name, threadId, title: bot.name, body, ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) }),
        wrote: deps.wrote,
        welcomeDone: deps.welcomeDone,
        runs: () => deps.routines()?.listRuns() ?? [],
        ledger: deps.hooks.ledger,
    });
    if (deps.fresh)
        firstHour.begin();
    if (!firstHour.active())
        return null;
    deps.hooks.attach(firstHour);
    store.onChange((change) => {
        if (change.type === "message")
            firstHour.message(change.threadId, change.message);
        else if (change.type === "message.patch")
            firstHour.patched(change.threadId, change.message);
    });
    deps.bus.subscribe((event) => {
        if (event.type === "turn.completed" && !deps.stale(event))
            firstHour.turnCompleted(event.threadId, event.ok);
    });
    firstHour.start();
    return firstHour;
}
/** The config patch that ends a new Cloud's welcome steps: it opens on its Chief's chat. */
export function welcomeDonePatch(onboarding) {
    return { onboarding: { hintsSeen: [...new Set([...(onboarding?.hintsSeen ?? []), CLOUD_WELCOME_DONE])] } };
}
