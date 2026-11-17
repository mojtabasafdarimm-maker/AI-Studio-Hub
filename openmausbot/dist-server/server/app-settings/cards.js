export const SETTINGS_CARDS = {
    "other-computers": {
        label: "Your other computers",
        where: "Settings → Phone & devices",
        when: "when the person asks how to connect or open this computer from another computer",
        text: "Your other computers: this is turned on in MausBot on the computer itself, in Settings → Phone & devices.",
        guide: "Tell the user in two or three plain sentences: if the card shows a switch, turn it on there; otherwise open MausBot on that computer, Settings → Phone & devices (both computers need Tailscale, signed in to the same Tailscale account). Then choose Pair a computer and Copy link, and on the other computer open Connect to a server in MausBot and paste the link.",
    },
    "ai-sign-in": {
        label: "AI sign-in",
        where: "Settings → AI",
        when: "when the person wants to sign in to an AI account (Claude, ChatGPT or Codex, Antigravity), or one is signed out",
        text: "AI sign-in: the person signs in to their AI accounts in Settings → AI → Providers.",
        guide: "Tell the user in one plain sentence to sign in on the AI they want in the card; their account never passes through you. Once it shows signed in, they can send their message again.",
        action: true,
        path: "Settings → AI → Providers",
    },
};
/** Fixed words only, never the address. `on`: true when the setting is known to be on; null when the server cannot
 * tell (off, or on with nothing answering yet), so the bot never calls something off that is on. */
export function cardShownStatus(card, on) {
    const state = card.action ? "" : on ? ` ${card.label} is on now.` : ` Whether ${card.label} is on is not known to you: it may be off, or on but not reachable yet, so do not say it is off; the card shows the user which.`;
    return `Card shown: ${card.label}.${state} Only the user can change it; you cannot, and you never see what the card shows. ${card.guide}`;
}
/** A room draws no settings control: the bot is told so, and where the person finds it. */
export function cardNotInRoom(card) {
    return `No card shown: a settings control is not drawn in a room. Tell the user in one line to open ${card.path ?? `${card.where} → ${card.label}`} in MausBot on the computer itself, or to ask you in your own chat, where you can show it.`;
}
export function cardElsewhere(card) {
    return `No card shown: ${card.label} is set in the MausBot desktop app on the computer itself, in ${card.where}. Tell the user that in one line.`;
}
