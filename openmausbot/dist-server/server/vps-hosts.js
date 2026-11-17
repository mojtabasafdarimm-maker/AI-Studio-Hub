// Which VPS host a bot's computer lives on: the app-wide SSH alias, or the bot's own.
import { isValidSshAlias, vpsSshAlias } from "./config.js";
/** A bot's own SSH alias wins over the default; both are validated the same way. */
export function vpsSshAliasForBot(cfg, bot) {
    return isValidSshAlias(bot?.vpsAlias) ? bot.vpsAlias : vpsSshAlias(cfg);
}
/** A config scoped to one bot's VPS alias, shaped for the vps-computer calls. */
export function vpsConfigForBot(cfg, bot) {
    const sshAlias = vpsSshAliasForBot(cfg, bot);
    return sshAlias ? { vps: { sshAlias } } : {};
}
/** Every alias this installation can hold VPS computers on: the default first, then each bot's own. */
export function vpsAliasesInPlay(cfg, bots) {
    const aliases = new Set();
    const primary = vpsSshAlias(cfg);
    if (primary)
        aliases.add(primary);
    for (const bot of bots) {
        if (isValidSshAlias(bot.vpsAlias))
            aliases.add(bot.vpsAlias);
    }
    return [...aliases];
}
