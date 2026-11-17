import { DEFAULT_MASCOT_BODY } from "../shared/mascot-bodies.js";
import { MAUS_COLOR_NAMES } from "../shared/wire.js";
export const STARTER_COLORS = MAUS_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome");
const ROTATION = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];
/** The colour of the bot made `index`-th when nothing else picks one. */
export const rotationColor = (index) => ROTATION[index % ROTATION.length];
/** A new bot's first look: always the mascot's own shape, in a random colour no bot here wears yet when one is left. */
export function freshLook(bots, random = Math.random) {
    const unworn = STARTER_COLORS.filter((color) => !bots.some((bot) => bot.color === color));
    const pool = unworn.length ? unworn : STARTER_COLORS;
    return { color: pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))], mascotBody: DEFAULT_MASCOT_BODY };
}
