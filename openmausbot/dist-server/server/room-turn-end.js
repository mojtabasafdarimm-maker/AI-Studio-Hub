export function roomTurnEnd(event, orchestrated, claim) {
    if (claim?.parked)
        return { outcome: "parked" };
    if (claim)
        return { outcome: "provider_failed", stopReason: claim.message };
    if (orchestrated && !event.ok)
        return { outcome: "provider_failed", stopReason: event.stopReason ?? null };
    return { outcome: "settled" };
}
