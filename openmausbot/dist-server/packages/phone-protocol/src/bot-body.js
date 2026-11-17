/** Every body a bot can wear: the gradient catalog plus the festival bodies. */
import { z } from "zod";
import { DEFAULT_MASCOT_BODY, MASCOT_BODY_IDS } from "./mascot-bodies.js";
import { CARVED_BODY_IDS, DIWALI_BODY_IDS, HALLOWEEN_BODY_IDS } from "./carved-bodies.js";
export const BOT_BODY_IDS = [...MASCOT_BODY_IDS, ...CARVED_BODY_IDS];
export const botBodySchema = z.enum(BOT_BODY_IDS);
/** Runtime-safe read of an untrusted persisted or streamed body id. */
export function botBodyId(value) {
    return botBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;
}
export function isCarvedBody(value) {
    return CARVED_BODY_IDS.includes(value);
}
/** A festival skin's own bodies, and the costume each bot colour wears while "Dress my bots up" is on with it. */
const festival = (bodies, costumes) => ({ bodies, costumes });
/** Keyed by the skin id that turns each festival on. */
export const FESTIVALS = {
    halloween: festival(HALLOWEEN_BODY_IDS, {
        orange: "pumpkin",
        purple: "ghost",
        teal: "witch",
        red: "bat",
        blue: "cat",
        cyan: "skull",
        green: "monster",
        yellow: "mummy",
        coral: "vampire",
        pink: "spider",
    }),
    diwali: festival(DIWALI_BODY_IDS, {
        orange: "laddu",
        purple: "chakri",
        teal: "karanji",
        red: "rocket",
        blue: "bomb",
        cyan: "chakli",
        green: "anaar",
        yellow: "katli",
        coral: "jalebi",
        pink: "sparkler",
    }),
};
export const FESTIVAL_IDS = Object.keys(FESTIVALS);
export function isFestival(value) {
    return typeof value === "string" && Object.hasOwn(FESTIVALS, value);
}
