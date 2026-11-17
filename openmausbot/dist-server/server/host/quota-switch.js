import { createQuotaSwitch } from "../quota-switch.js";
import { resolveYourComputerAsk } from "../your-computer-consent.js";
export function createQuotaSwitchHost(deps) {
    const { store, coordinator, registry, turnStops, hostedModels, providerConfigs, policyModelRefusal, checkedTaskModelSwitch, threadBusy, directRequestOwners, startOrQueueDirectMessage, takeover, } = deps;
    const quotaSwitch = createQuotaSwitch({
        store, coordinator, registry, turnStops, takeover,
        access: instanceId => providerConfigs()[instanceId]?.access ?? registry.access(instanceId),
        refusal: policyModelRefusal,
        gate: (thread, selection) => checkedTaskModelSwitch(thread, selection, false, false, true),
        reset: (from, to) => hostedModels?.resetTask(from, to),
        busy: threadBusy,
        request: threadId => directRequestOwners.get(threadId),
        resend: (botId, threadId, message, replyTo, spoken) => startOrQueueDirectMessage(botId, threadId, message.text ?? "", replyTo, undefined, message.sender, undefined, spoken.via, spoken.callId, message.dataContext),
    });
    /** Settles a card the harness raised itself (a use-your-computer ask or a quota-switch offer); undefined for any other card. */
    async function harnessCardOutcome(threadId, requestId, behavior, message) {
        if (!store.messagesFor(threadId).some(candidate => candidate.card?.requestId === requestId))
            return undefined;
        if (resolveYourComputerAsk(requestId, behavior) || deps.ownCards?.(requestId, behavior))
            return behavior === "allow" ? "allowed-once" : "rejected";
        return await quotaSwitch.answer(threadId, requestId, behavior, message) ?? undefined;
    }
    return { quotaSwitch, harnessCardOutcome };
}
