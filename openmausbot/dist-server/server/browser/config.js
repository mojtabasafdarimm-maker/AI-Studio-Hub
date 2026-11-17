// `browserEngine` in config.json.
import { z } from "zod";
import { browserEgressConfigSchema } from "./egress/policy.js";
const CDP_PORT = /^[0-9]{1,5}$/;
const CDP_URL = /^(https?|wss?):\/\/\S+$/i;
/** agent-browser's `--cdp` takes a bare port or an http(s)/ws(s) DevTools URL. */
export function isValidCdpTarget(value) {
    if (typeof value !== "string" || value === "")
        return false;
    if (CDP_PORT.test(value)) {
        const port = Number(value);
        return port >= 1 && port <= 65535;
    }
    return CDP_URL.test(value);
}
/** `attachCdpUrl`: a running Chrome that My Chrome profiles attach to. Config only, never env: the ambient environment must not redirect a bot's browser. */
export const browserEngineConfigSchema = z.object({
    attachCdpUrl: z.string().trim().max(2048).refine((value) => value === "" || isValidCdpTarget(value), { message: "browserEngine.attachCdpUrl must be a CDP port (1-65535) or an http(s)/ws(s) URL" }).optional(),
    idleTimeoutMinutes: z.number().int().min(1).max(60).optional(), // an unused browser closes after this; 10 when unset, 3 on MausBot Cloud
    egress: browserEgressConfigSchema.optional(),
    /** "chrome" runs the bots' browsers on OpenMausBot's own Chrome driver, an early test; agent-browser is the default. */
    engine: z.enum(["agent-browser", "chrome"]).optional(),
});
export function browserEngineKind(cfg) {
    return cfg.browserEngine?.engine === "chrome" ? "chrome" : "agent-browser";
}
