import { botMayWatchApp } from "../shared/app-triggers.js";
import { appEventCatalog, appLabel } from "./app-event-catalog.js";
import { brokerClient } from "./app-trigger-broker.js";
import { AppTriggerRequestService } from "./app-trigger-requests.js";
import { AppTriggerError, AppTriggerManager } from "./app-triggers.js";
import { managedComposioBrokerOff } from "./composio-broker-access.js";
import { PASS } from "./routes/table.js";
import { listTriggers, triggerTarget } from "./trigger-tools.js";
import { addressFor } from "./webhook-address.js";
const GUEST_REFUSAL = "Only the Cloud's owner can make a bot watch their connected apps. Tell the person to ask from their own conversation.";
function status(error) {
    return error instanceof AppTriggerError ? error.status : typeof error.status === "number" ? error.status : 400;
}
export function createAppTriggerHost(deps) {
    const broker = deps.broker ?? brokerClient(deps.access);
    const service = () => {
        const mode = deps.connectionMode();
        if (mode === "self-hosted")
            return { available: false, reason: "self-hosted" };
        if (managedComposioBrokerOff())
            return { available: false, reason: "off" };
        return mode === "managed" && deps.access() ? { available: true } : { available: false, reason: "unavailable" };
    };
    const manager = new AppTriggerManager({
        file: deps.file,
        broker,
        service,
        connectedApps: deps.connectedApps,
        botState: deps.botState,
        runs: {
            enqueue: (input) => deps.routines().enqueueWebhook(input),
            merge: (triggerId, eventId, sameConversation, merge) => deps.routines().mergeIntoQueuedRun(triggerId, eventId, sameConversation, merge),
            receipt: (triggerId, eventId) => deps.routines().webhookRunReceipt(triggerId, eventId),
            pending: (triggerId) => deps.routines().activeWebhookRunCount(triggerId),
            cancelQueued: (triggerId, message) => deps.routines().cancelQueuedWebhook(triggerId, message),
        },
        emit: deps.emit,
    });
    const requests = new AppTriggerRequestService({ store: deps.store, triggers: manager, botName: (botId) => deps.store.bot(botId)?.name ?? "the bot" });
    const unavailableText = (reason) => reason === "self-hosted"
        ? "App events need OpenMausBot's connected apps. This server uses its own Composio key, so a bot cannot watch apps here yet: use a schedule that checks the app, or a webhook."
        : "Connected apps are not set up here, so a bot cannot watch apps yet.";
    async function catalog(bot, app, search) {
        const current = service();
        if (!current.available)
            return { apps: [], notConnected: [], unavailable: unavailableText(current.reason) };
        const connected = await deps.connectedApps();
        const result = await appEventCatalog({ broker, connected, bot, app, search });
        const wanted = app?.trim().toLowerCase();
        if (wanted && !result.apps.length && connected[wanted]?.connected && !botMayWatchApp(bot, wanted)) {
            return { ...result, unavailable: `${bot.name} has not been given access to ${appLabel(wanted)}. Ask the person to allow it under the bot's Access settings.` };
        }
        return result;
    }
    /** The person's side: /api/app-triggers. Reads follow what this viewer may see; changes need the owner. */
    const routes = async ({ req, res, url, path, method, auth, json, readBody }) => {
        if (!path.startsWith("/api/app-triggers"))
            return PASS;
        try {
            if (path === "/api/app-triggers" && method === "GET") {
                const snapshot = manager.snapshot();
                const shown = snapshot.triggers.filter((trigger) => deps.visibleBot(auth, trigger.botId));
                const ids = new Set(shown.map((trigger) => trigger.id));
                return json(res, 200, { ...snapshot, triggers: shown, attempts: snapshot.attempts.filter((attempt) => ids.has(attempt.triggerId)) });
            }
            if (path === "/api/app-triggers/events" && method === "GET") {
                const bot = deps.store.bot(url.searchParams.get("botId") ?? "");
                if (!bot)
                    return json(res, 404, { error: "no such bot" });
                return json(res, 200, await catalog(bot));
            }
            if (path === "/api/app-triggers/sync" && method === "POST") {
                await manager.reconcile();
                return json(res, 200, manager.snapshot());
            }
            if (path === "/api/app-triggers" && method === "POST") {
                const body = (await readBody(req));
                const bot = deps.store.bot(typeof body.botId === "string" ? body.botId : "");
                if (!bot)
                    return json(res, 404, { error: "no such bot" });
                const app = typeof body.app === "string" ? body.app.trim().toLowerCase() : "";
                if (!botMayWatchApp(bot, app))
                    return json(res, 403, { error: `${bot.name} has not been given access to ${appLabel(app)}. Allow it in the bot's Access settings first.` });
                const trigger = await manager.create({
                    botId: bot.id, name: String(body.name ?? ""), prompt: String(body.prompt ?? ""), app, event: String(body.event ?? ""),
                    ...(typeof body.account === "string" ? { account: body.account } : {}),
                    ...(body.filter && typeof body.filter === "object" ? { filter: body.filter } : {}),
                    ...(body.config && typeof body.config === "object" ? { config: body.config } : {}),
                    ...(body.runOn === "cloud" ? { runOn: "cloud" } : {}),
                    ...(body.sameConversation === true ? { sameConversation: true } : {}),
                });
                return json(res, 201, { trigger });
            }
            const match = path.match(/^\/api\/app-triggers\/([\w-]+)(?:\/(test))?$/);
            if (!match)
                return PASS;
            const id = match[1];
            if (match[2] === "test" && method === "POST") {
                const result = await manager.runNow(id);
                return result ? json(res, 202, result) : json(res, 404, { error: "no such automation" });
            }
            if (!match[2] && method === "PATCH") {
                const body = (await readBody(req));
                const patch = {
                    ...(typeof body.name === "string" ? { name: body.name } : {}),
                    ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
                    ...(body.runOn === "maus" || body.runOn === "cloud" ? { runOn: body.runOn } : {}),
                    ...(body.filter === null || (body.filter && typeof body.filter === "object") ? { filter: body.filter } : {}),
                    ...(body.config && typeof body.config === "object" ? { config: body.config } : {}),
                    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
                    ...(typeof body.sameConversation === "boolean" ? { sameConversation: body.sameConversation } : {}),
                };
                const trigger = await manager.update(id, patch);
                return trigger ? json(res, 200, { trigger }) : json(res, 404, { error: "no such automation" });
            }
            if (!match[2] && method === "DELETE") {
                return await manager.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such automation" });
            }
            return PASS;
        }
        catch (error) {
            return json(res, status(error), { error: error instanceof Error ? error.message : String(error) });
        }
    };
    /** The bot's side: trigger_info list and events, for the bot whose turn holds the capability. */
    const internalRoutes = (context) => async ({ res, url, path, method, json }) => {
        if (method !== "GET" || (path !== "/api/internal/triggers" && path !== "/api/internal/trigger-events"))
            return PASS;
        if (!context.ownsThread(context.from.id, context.threadId))
            return json(res, 403, { error: "source conversation does not belong to sender" });
        if (path === "/api/internal/trigger-events") {
            if (context.guestDriven)
                return json(res, 403, { error: GUEST_REFUSAL });
            try {
                return json(res, 200, await catalog(context.from, url.searchParams.get("app") ?? undefined, url.searchParams.get("search") ?? undefined));
            }
            catch (error) {
                return json(res, 200, { error: `The events could not be listed: ${error instanceof Error ? error.message : String(error)}` });
            }
        }
        const target = triggerTarget(context.from, url.searchParams.get("forBotId") ?? undefined, (id) => deps.store.bot(id));
        if ("error" in target)
            return json(res, target.status, { error: target.error });
        const ownerId = target.forBot?.botId ?? context.from.id;
        const listing = listTriggers({
            botId: ownerId, triggerId: url.searchParams.get("triggerId") ?? undefined, routines: deps.routines().listRoutines().filter((routine) => context.routineShown?.(routine) ?? true),
            webhooks: deps.webhooks.list(), appTriggers: manager.list(), runs: deps.routines().listRuns(), timeZone: deps.timeZone(), now: Date.now(),
        });
        const shown = listing.trigger;
        if (url.searchParams.get("includeAddress") !== "1" || !shown)
            return json(res, 200, listing);
        if (shown.kind !== "webhook")
            return json(res, 200, { ...listing, trigger: { ...shown, addressRefused: "Only an automation another app sends to (a webhook) has an address." } });
        const owner = deps.store.bot(ownerId);
        const address = owner ? addressFor({ from: context.from, owner, guestDriven: context.guestDriven, outsideDriven: context.outsideDriven() }, deps.webhooks, shown.id, deps.webhookBase()) : {};
        return json(res, 200, { ...listing, trigger: { ...shown, ...address } });
    };
    /** trigger create (when=app_event) and every change to one: applies at once and leaves the receipt card. */
    async function submit(res, json, input) {
        // Its events would stream the owner's app data into a conversation someone else drives.
        if (input.guestDriven)
            return json(res, 403, { error: GUEST_REFUSAL });
        const owner = deps.store.bot(input.forBot?.botId ?? input.from.id);
        const app = input.operation.action === "create" && input.operation.trigger && typeof input.operation.trigger === "object"
            ? String(input.operation.trigger.app ?? "").toLowerCase() : "";
        if (owner && app && !botMayWatchApp(owner, app)) {
            return json(res, 403, { error: `${owner.name} has not been given access to ${appLabel(app)}. Ask the person to allow it under the bot's Access settings; do not retry until they have.` });
        }
        try {
            const applied = await requests.submit({ botId: input.from.id, threadId: input.threadId, operation: { ...input.operation, forBot: input.forBot }, from: input.sender, canCommit: input.canCommit });
            deps.audit({ threadId: input.threadId, requestId: applied.requestId, botId: input.from.id, botName: input.from.name,
                tool: applied.action === "create" ? "create_trigger" : "manage_trigger", summary: applied.summary });
            return json(res, 201, applied);
        }
        catch (error) {
            return json(res, status(error), { error: error instanceof Error ? error.message : String(error) });
        }
    }
    return {
        manager,
        routes,
        internalRoutes,
        submit,
        undo: (args) => requests.undo(args),
        isApp: (id) => manager.get(id) !== null,
        start: () => manager.start(),
        stop: () => manager.stop(),
        /** Access to the service changed (the desktop handed its token over, or a Cloud registered). */
        wake: () => manager.wake(),
    };
}
