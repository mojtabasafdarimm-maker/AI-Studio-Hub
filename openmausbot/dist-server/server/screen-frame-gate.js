import { createHash } from "node:crypto";
import { screenSurfaceForTool, screenTouchingTool } from "../shared/tool-surface.js";
export { screenSurfaceForTool, screenTouchingTool };
export function screenFrameHash(png) {
    return createHash("sha256").update(png).digest("hex");
}
export function settledFrameIsNews(shownFrameHash, png) {
    return shownFrameHash === undefined || screenFrameHash(png) !== shownFrameHash;
}
