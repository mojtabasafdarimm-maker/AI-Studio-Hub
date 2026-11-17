const REMEMBERED_TURNS = 5_000;
export function createUsageAttribution(deps) {
    const turnPerson = new Map();
    const remember = (turnId, email) => {
        if (!turnId || !email)
            return;
        turnPerson.delete(turnId);
        turnPerson.set(turnId, email);
        if (turnPerson.size > REMEMBERED_TURNS)
            turnPerson.delete(turnPerson.keys().next().value);
    };
    return (row) => {
        const section = deps.section(row.botId)?.trim();
        let trigger = row.trigger;
        if (trigger.kind === "routine" && !trigger.email && trigger.routineId) {
            const email = deps.routineWriter(trigger.routineId);
            if (email)
                trigger = { ...trigger, email };
        }
        else if (trigger.kind !== "user" && trigger.kind !== "routine" && !trigger.email && row.parent) {
            // A teammate can finish before the turn that delegated to it is booked.
            const parentTrigger = deps.threadTrigger?.(row.parent.threadId);
            const email = turnPerson.get(row.parent.turnId) ?? (parentTrigger ? personOf(parentTrigger) : undefined);
            if (email)
                trigger = { ...trigger, email };
        }
        remember(row.turnId, personOf(trigger));
        return { ...row, trigger, ...(section ? { section } : {}) };
    };
}
/** The person a row was spent for, if any. */
export function personOf(trigger) {
    return trigger.email;
}
