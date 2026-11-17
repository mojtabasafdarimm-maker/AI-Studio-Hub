import { containerComputerExists, perBotLocalVmTarget, poolLocalVmTarget, } from "./container-computer.js";
/** Idle cleanup is destructive: a derived name alone is not ownership without OpenMausBot's verified labels. */
export function shouldArmLocalVmIdle(status) {
    return status?.container === "running" && status.managed;
}
/** Bot destination is deliberately irrelevant: a VM stays visible after its bot moves elsewhere. */
export async function discoverExistingPerBotLocalVms(bots, runtime, exists = containerComputerExists) {
    const candidates = [...new Map(bots.map((bot) => {
            const target = perBotLocalVmTarget(bot.id);
            return [target.key, { bot, target }];
        })).values()];
    const existing = await Promise.all(candidates.map(({ target }) => exists(runtime, target)));
    return candidates.filter((_, index) => existing[index]);
}
export async function discoverExistingPoolLocalVms(seatCount, runtime, exists = containerComputerExists) {
    const seats = Math.max(1, Math.floor(seatCount));
    const targets = Array.from({ length: seats }, (_, seat) => poolLocalVmTarget(seat));
    const existing = await Promise.all(targets.map((target) => exists(runtime, target)));
    return targets.filter((_, index) => existing[index]);
}
/** An explicit allow-list: never viewer passwords or URLs, host paths, runtime commands or target hashes. */
export function localVmInventoryEntry(bot, status, inUse) {
    if (status.container === "missing")
        return null;
    return {
        botId: bot.id,
        name: bot.name,
        destination: bot.computer ?? "auto",
        container: status.container,
        managed: status.managed,
        ready: status.ready,
        problem: status.problem,
        inUse,
    };
}
