import { codexTierOf } from "./drivers/codex-tier.js";
import { currentPrices } from "./model-manifest/manifest.js";
import { billableFor } from "./prices.js";
export function listPrices() {
    return currentPrices().prices;
}
export function listPriceFor(model, at = new Date()) {
    const { prices, aliases } = currentPrices();
    const key = model.trim().toLowerCase();
    const entry = prices[aliases.get(key) ?? key];
    if (!entry)
        return null;
    const day = at.toISOString().slice(0, 10);
    const change = entry.changes?.filter((candidate) => candidate.from <= day).at(-1);
    const current = change ?? entry;
    return {
        inputPerMillion: current.inputPerMillion,
        outputPerMillion: current.outputPerMillion,
        ...(current.cachedInputPerMillion !== undefined ? { cachedInputPerMillion: current.cachedInputPerMillion } : {}),
    };
}
export function estimatePriceFor(turn, operatorPrices, at = new Date()) {
    // A Codex Fast row (`gpt-5.5+priority`) costs what its base model costs; the usage row keeps the full id.
    const model = turn.driverKind === "codex" ? codexTierOf(turn.model)?.model ?? turn.model : turn.model;
    return operatorPrices?.[`${turn.driverKind}/${turn.model}`] ?? operatorPrices?.[turn.model] ??
        operatorPrices?.[`${turn.driverKind}/${model}`] ?? operatorPrices?.[model] ??
        listPriceFor(model, at) ?? operatorPrices?.default ?? null;
}
export function ledgerCost(turn, operatorPrices, at = new Date()) {
    if (typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) && turn.costUsd >= 0) {
        return { costUsd: turn.costUsd, costSource: "reported" };
    }
    const unit = estimatePriceFor(turn, operatorPrices, at);
    if (!unit)
        return { costUsd: null };
    return { costUsd: billableFor(turn, { [turn.model]: unit }), costSource: "estimated" };
}
