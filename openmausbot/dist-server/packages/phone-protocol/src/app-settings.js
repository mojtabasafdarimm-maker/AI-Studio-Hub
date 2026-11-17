// The app_settings tool's wire shapes: a setting's tier (the whole policy), the applied card a change rides on, and the
// preferences that live in the window's localStorage, which the server reaches through an SSE frame.
import { z } from "zod";
/** Settings a bot can ask the app to show in chat as the real control. Adding one here, in the server's SETTINGS_CARDS
 * and in the window's card list is the whole registration. */
export const SETTINGS_CARD_IDS = ["other-computers", "ai-sign-in"];
export const isSettingsCardId = (id) => typeof id === "string" && SETTINGS_CARD_IDS.includes(id);
export const SKIN_IDS = [
    "midnight",
    "atelier",
    "foundry",
    "lagoon",
    "graphite",
    "linen",
    "dusk",
    "daylight",
    "meadow",
    "pop",
    "halloween",
    "diwali",
    "aurora",
];
export const FONT_IDS = ["skin", "system", "inter", "poppins", "serif"];
export const CHAT_WIDTH_IDS = ["standard", "wide", "full"];
/** The Enter-adds-a-line modes are for input methods that confirm a conversion with Enter (Japanese). */
export const SEND_KEYS = ["enter", "shift-enter", "mod-enter"];
export const PLACE_SWATCHES = ["blue", "green", "amber", "rose", "violet", "slate"];
export const TALK_KEYS = ["ctrl-opt-space", "ctrl-shift-space", "opt-shift-space"];
const pinnedPage = z.object({ name: z.string().trim().min(1).max(40), url: z.string().trim().max(2048).regex(/^https?:\/\/\S+$/, "an http(s) address") }).strict();
/** Preferences kept in the window or behind the desktop app's own bridge, by setting id; the renderer applies a frame with
 * the matching setter. */
export const WINDOW_PREFS = {
    "appearance.skin": z.enum([...SKIN_IDS, "system"]),
    "appearance.advanced": z.boolean(),
    "appearance.font": z.enum(FONT_IDS),
    "appearance.chatWidth": z.enum(CHAT_WIDTH_IDS),
    "general.sendKey": z.enum(SEND_KEYS),
    "general.notificationSounds": z.boolean(),
    "appearance.userBubbles": z.boolean(),
    "appearance.runCard": z.boolean(),
    "appearance.showThreads": z.boolean(),
    "appearance.toolsLayout": z.enum(["rows", "toolbar"]),
    "appearance.pinnedCircles": z.boolean(),
    "appearance.universalPins": z.boolean(),
    "appearance.pinnedPages": z.array(pinnedPage).max(6),
    "appearance.showComputers": z.boolean(),
    "appearance.windowFrame": z.boolean(),
    "appearance.sidebarColor": z.enum([...PLACE_SWATCHES, "none"]),
    "general.followUp": z.enum(["steer", "queue"]),
    "general.finishedNotifications": z.boolean(),
    "general.notificationFeed": z.boolean(),
    "general.analytics": z.boolean(),
    "general.openAtLogin": z.boolean(),
    "general.talkShortcut": z.object({ enabled: z.boolean(), key: z.enum(TALK_KEYS) }).strict(),
    "account.productEmails": z.boolean(),
    "remote.wifi": z.boolean(),
    "remote.relay": z.boolean(),
    "remote.tailscale": z.boolean(),
    "remote.keepAwake": z.boolean(),
};
export const WINDOW_PREF_IDS = Object.keys(WINDOW_PREFS);
export const isWindowPrefId = (id) => Object.hasOwn(WINDOW_PREFS, id);
/** What the window reports as its current values (PUT /api/window-prefs). */
export const windowPrefReportSchema = z.object({ values: z.record(z.string(), z.unknown()) }).strict();
