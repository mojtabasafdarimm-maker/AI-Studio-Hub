const usageCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
/** One pi run's tokens and priced cost, in the app's shape where input includes cached tokens like the other drivers. */
export class PiRunUsage {
    usage;
    /** pi's priced USD. A zero is pi's default for a model without prices, so it stays unknown rather than booked as free. */
    cost;
    // pi sends a model call's usage on its assistant message_end, before any tool runs, and again on turn_end.
    counted = false;
    /** Counts the current model call's usage once, so a stop while a tool runs still books it. */
    add(usage) {
        if (!usage || this.counted)
            return;
        this.counted = true;
        const total = this.usage;
        const cacheRead = usageCount(usage.cacheRead);
        const cachedInput = cacheRead === undefined ? total?.cachedInput : (total?.cachedInput ?? 0) + cacheRead;
        this.usage = {
            input: (total?.input ?? 0) + (usageCount(usage.input) ?? 0) + (cacheRead ?? 0) + (usageCount(usage.cacheWrite) ?? 0),
            output: (total?.output ?? 0) + (usageCount(usage.output) ?? 0),
            ...(cachedInput === undefined ? {} : { cachedInput }),
        };
        const cost = usageCount(usage.cost?.total);
        if (cost)
            this.cost = (this.cost ?? 0) + cost;
    }
    /** turn_end closes a model call; the next call is counted again. */
    endTurn(usage) {
        this.add(usage);
        this.counted = false;
    }
}
