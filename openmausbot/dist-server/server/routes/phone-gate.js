import { CONTROL_WAIT_MS } from "../control-client.js";
import { PASS } from "./table.js";
const PHONE = "computer:phone";
export function createPhoneGate(deps) {
    let handedBackTo;
    const takeHandBack = (turn) => {
        if (handedBackTo?.threadId !== turn.threadId || handedBackTo.generation !== turn.generation)
            return false;
        handedBackTo = undefined;
        return true;
    };
    return {
        /** For the hold's `onChange`: the turn that has the phone when a person's hold ends must read the screen again before it acts. */
        holdChanged(held) {
            if (held)
                return;
            const holder = deps.resources.holder(PHONE);
            handedBackTo = holder && { threadId: holder.threadId, generation: holder.generation };
        },
        async internal(ctx) {
            if (ctx.method !== "POST" || ctx.path !== "/api/internal/phone/claim")
                return PASS;
            ctx.requireActive();
            if (deps.enabled()) {
                const midCall = (await ctx.readBody())?.wait === false;
                const waited = midCall && deps.hold.held ? "held" : await deps.hold.wait(ctx.signal, CONTROL_WAIT_MS);
                if (waited === "held")
                    return ctx.json(ctx.res, 423, { reason: "person" });
                if (waited === "handed-back") {
                    takeHandBack(ctx.turn);
                    return ctx.json(ctx.res, 423, { reason: "handed-back" });
                }
                ctx.requireActive();
                if (takeHandBack(ctx.turn))
                    return ctx.json(ctx.res, 423, { reason: "handed-back" });
            }
            if (!deps.claim(ctx.turn, PHONE))
                return ctx.json(ctx.res, 409, { error: "another thread is using the phone" });
            return ctx.json(ctx.res, 200, { claimed: true });
        },
    };
}
