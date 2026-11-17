export function priceFor(turn, prices) {
    const driverKey = `${turn.driverKind}/${turn.model}`;
    const forDriver = Object.hasOwn(prices, driverKey) ? prices[driverKey] : undefined;
    const forModel = Object.hasOwn(prices, turn.model) ? prices[turn.model] : undefined;
    const fallback = Object.hasOwn(prices, "default") ? prices.default : undefined;
    return forDriver ?? forModel ?? fallback ?? null;
}
const clean = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);
export function billableFor(turn, prices) {
    const price = priceFor(turn, prices);
    if (!price)
        return null;
    const input = clean(turn.input);
    const cached = Math.min(clean(turn.cachedInput), input);
    const fresh = input - cached;
    const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion;
    return (fresh * price.inputPerMillion + cached * cachedRate + clean(turn.output) * price.outputPerMillion) / 1_000_000;
}
