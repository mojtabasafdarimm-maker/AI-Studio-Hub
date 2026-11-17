import { readyToRun, signedOut } from "./default-model-selection.js";
import { sameModelSelection } from "../shared/thread-model.js";
function canRunOn(engine, selection, context) {
    return Boolean(engine?.enabled) && engine.snapshot.state === "available" && context.refusal?.(engine) === undefined &&
        context.allows?.(selection) !== false;
}
export function threadModelFallback(own, botModel, engine, context = {}) {
    if (sameModelSelection(own, botModel))
        return null;
    const mine = engine(own.instanceId);
    if (!canRunOn(mine, own, context))
        return "unavailable";
    if (!signedOut(mine))
        return null;
    // On the same engine the bot's model is signed out too, so it never stands in.
    const theirs = engine(botModel.instanceId);
    return canRunOn(theirs, botModel, context) && readyToRun(theirs, context) ? "signed-out" : null;
}
