const MAX_BOTS = 1_000;
const budgets = new Map();
/** Each bot's last chat-engine turn, kept until the server restarts; past MAX_BOTS the longest-quiet bot goes first. */
export function noteToolBudget(botId, budget) {
    if (!botId)
        return;
    budgets.delete(botId);
    budgets.set(botId, budget);
    if (budgets.size > MAX_BOTS)
        budgets.delete(budgets.keys().next().value);
}
export function toolBudgetOf(botId) {
    return budgets.get(botId);
}
export function forgetToolBudgets() {
    budgets.clear();
}
