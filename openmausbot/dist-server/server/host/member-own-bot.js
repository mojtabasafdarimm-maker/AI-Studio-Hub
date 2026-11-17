export function createMemberOwnBot(deps) {
    return {
        /** Stops every turn of a bot: its chats, its routine run and the room turn it is in. */
        async stopWork(botId, cause) {
            const bot = deps.store().bot(botId);
            if (!bot)
                return;
            const routines = deps.routines();
            const run = routines?.activeRunForBot(botId);
            const groupTurn = deps.activeGroupTurnForBot(botId);
            if (groupTurn) {
                deps.cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
                deps.revokeInternalCapabilitiesForThread(groupTurn.threadId);
            }
            await Promise.allSettled([
                deps.interruptAllDirectThreads(botId),
                run ? routines.cancelRun(run.id, cause) : undefined,
                groupTurn ? deps.interruptTurn(bot, groupTurn.threadId) : undefined,
            ]);
            if (groupTurn)
                deps.closeOpenApprovals(groupTurn.threadId);
        },
        /** Deletes a member's own MausBot, which stops being their default bot first; it is theirs again if that fails. */
        async remove(botId) {
            const store = deps.store();
            const bot = store.bot(botId);
            if (!bot)
                return false;
            store.patchBot(botId, { defaultBot: undefined, sidebarHidden: undefined });
            const result = await deps.deleteBot(botId).catch((error) => ({ status: 500, body: { error: error instanceof Error ? error.message : String(error) } }));
            if (result.status < 400)
                return true;
            console.warn(`team member left: could not delete their MausBot ${botId}: ${result.body.error ?? result.status}`);
            if (store.bot(botId))
                store.patchBot(botId, { defaultBot: bot.defaultBot, sidebarHidden: bot.sidebarHidden });
            return false;
        },
    };
}
