/** The "team" a bot moving from this computer to My Cloud goes to. */
export const MY_CLOUD_TEAM = "my-cloud";
/** Why this bot takes no turn here, or null. */
export function botMoveRefusal(bot) {
    if (bot?.home)
        return `${bot.name} lives on ${bot.home.placeName}: its turns run there, not here.`;
    const moved = bot?.movedTo;
    if (!moved)
        return null;
    return moved.state === "moved" ? `${bot.name} lives in ${moved.team.name} now.` : `${bot.name} is moving to ${moved.team.name}. It's ready there in a moment.`;
}
/** A turn of this bot starts here only while it is not moving or moved. */
export function assertBotHere(bot) {
    const said = botMoveRefusal(bot);
    if (said)
        throw Object.assign(new Error(said), { status: 409, code: "moved" });
}
export function createBotMoves(deps) {
    const now = deps.now ?? Date.now;
    const automations = (botId) => [
        ...(deps.routines()?.listRoutines() ?? []).filter((routine) => routine.botId === botId).map((routine) => ({ key: `routine:${routine.id}`, on: routine.enabled })),
        ...(deps.webhooks()?.list() ?? []).filter((hook) => hook.botId === botId).map((hook) => ({ key: `webhook:${hook.id}`, on: hook.enabled })),
        ...(deps.appEvents()?.list() ?? []).filter((trigger) => trigger.botId === botId).map((trigger) => ({ key: `app-event:${trigger.id}`, on: trigger.enabled })),
    ];
    async function switchTo(key, on) {
        const [kind, id] = key.split(":");
        if (kind === "routine")
            deps.routines()?.update(id, { enabled: on });
        else if (kind === "webhook")
            deps.webhooks()?.update(id, { enabled: on });
        else if (kind === "app-event")
            await deps.appEvents()?.update(id, { enabled: on });
    }
    const movedOf = (bot) => bot?.movedTo;
    const cancelWaits = (botId) => {
        const waits = deps.waits();
        for (const wait of waits?.all() ?? [])
            if (wait.botId === botId)
                waits.cancel(wait.id, botId);
    };
    /** A room some of whose bots stay goes on here without this one; one all of whose bots left is kept as it was. */
    const leaveRooms = (botId) => {
        for (const room of deps.store.groups ?? []) {
            if (room.dm || !room.memberIds.includes(botId))
                continue;
            if (room.memberIds.every((id) => id === botId || deps.store.bot(id)?.movedTo || deps.store.bot(id)?.defaultBot))
                continue;
            deps.store.patchGroup?.(room.id, { memberIds: room.memberIds.filter((id) => id !== botId) });
        }
    };
    return {
        /** The bot stops here for the move: no turns, its automations off and its waits cancelled. Busy while it answers; a
         * bot already moved stays moved. Holding it again keeps what the first hold switched off. */
        async hold(botId, team) {
            const bot = deps.store.bot(botId);
            if (!bot)
                return { refused: "This bot is no longer here." };
            if (bot.defaultBot)
                return { refused: `${bot.name} stays here: everyone on a team gets their own.` };
            const held = movedOf(bot);
            if (held?.state === "moved")
                return held.team.id === team.id ? { movedTo: held } : { refused: botMoveRefusal(bot) };
            if (held && held.team.id !== team.id)
                return { refused: botMoveRefusal(bot) };
            if (!held && deps.busy(botId))
                return { busy: bot.name };
            const off = held?.held ?? [];
            const next = { team, state: "moving", at: held?.at ?? now(), held: off };
            deps.store.patchBot(botId, { movedTo: next });
            for (const automation of automations(botId)) {
                if (!automation.on)
                    continue;
                // Kept before it is switched off, so a stop half-way still switches it back on.
                if (!off.includes(automation.key))
                    off.push(automation.key);
                deps.store.patchBot(botId, { movedTo: { ...next, held: [...off] } });
                await switchTo(automation.key, false);
            }
            cancelWaits(botId);
            return { movedTo: movedOf(deps.store.bot(botId)) };
        },
        /** The move stopped before the bot arrived: it is here again as it was, its automations back on. */
        async release(botId) {
            const bot = deps.store.bot(botId);
            const held = movedOf(bot);
            if (!bot || !held)
                return { released: true };
            if (held.state === "moved")
                return { refused: botMoveRefusal(bot) };
            for (const key of held.held ?? [])
                await switchTo(key, true);
            deps.store.patchBot(botId, { movedTo: undefined });
            return { released: true };
        },
        /** The bot lives in the team now: archived here as the line that opens it there, its routines and waits gone from here. */
        moved(botId, team) {
            const bot = deps.store.bot(botId);
            const held = movedOf(bot);
            if (!bot || !held || held.team.id !== team.id)
                return { refused: "This bot is not moving to that team." };
            if (held.state !== "moved") {
                if (team.id === MY_CLOUD_TEAM)
                    leaveRooms(botId);
                else
                    deps.routines()?.removeForBot(botId);
                cancelWaits(botId);
                deps.store.patchBot(botId, { movedTo: { ...held, state: "moved", at: now() }, hidden: true });
            }
            return { movedTo: movedOf(deps.store.bot(botId)) };
        },
        /** My Cloud ended: a bot that moved there is here again as it was when it went, its automations left off. */
        back(botId) {
            const bot = deps.store.bot(botId);
            const held = movedOf(bot);
            if (!bot || !held)
                return { released: true };
            if (held.team.id !== MY_CLOUD_TEAM)
                return { refused: botMoveRefusal(bot) };
            deps.store.patchBot(botId, { movedTo: undefined, hidden: false });
            return { released: true };
        },
    };
}
