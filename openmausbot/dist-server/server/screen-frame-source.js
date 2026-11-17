import { captureOutsideHumanControl } from "./private-screen-capture.js";
const TURN_FRAME_LIMIT = 64;
const turnFrames = new Map();
/** The newest desktop frame a turn captured, keyed by the computer resource it held (`computer:box:<id>`), so viewers
 * outside the turn, such as the Team map, reuse it instead of asking the machine again. */
export function rememberTurnFrame(resource, frame, at = Date.now()) {
    if (!resource)
        return;
    turnFrames.delete(resource);
    turnFrames.set(resource, { frame, at });
    if (turnFrames.size > TURN_FRAME_LIMIT)
        turnFrames.delete(turnFrames.keys().next().value);
}
export function latestTurnFrame(resource) {
    return turnFrames.get(resource);
}
/** A cached or in-flight desktop frame must never become the browser's settled picture after a surface switch. */
export function createScreenFrameSource(input) {
    let current = null;
    let lastAt = 0;
    let attemptedSurface;
    let last = null;
    let lastSurface;
    const selectedSurface = () => input.captures[source.surface]
        ? source.surface
        : input.captures.computer ? "computer" : "browser";
    const source = {
        surface: (input.captures.computer ? "computer" : "browser"),
        get last() {
            return lastSurface === selectedSurface() ? last : null;
        },
        async capture(fresh = false) {
            while (current)
                await current;
            if (input.control().held)
                return;
            const surface = selectedSurface();
            if (!fresh && attemptedSurface === surface && Date.now() - lastAt < input.minGapMs)
                return;
            attemptedSurface = surface;
            current = (async () => {
                try {
                    const capture = input.captures[surface];
                    if (!capture)
                        return;
                    const frame = await captureOutsideHumanControl(input.control, capture);
                    if (!frame || surface !== selectedSurface())
                        return;
                    last = frame;
                    lastSurface = surface;
                    input.onFrame(frame, surface);
                }
                catch {
                }
                finally {
                    lastAt = Date.now();
                }
            })();
            try {
                await current;
            }
            finally {
                current = null;
            }
        },
    };
    return source;
}
