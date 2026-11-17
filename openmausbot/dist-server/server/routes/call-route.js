import { PASS } from "./table.js";
/** Runs a route handler as the app's own window would call it, so a change made from a chat gets the same checks, side
 * effects and broadcasts as Settings, and the caller reads the reply the route wrote. */
export async function callRoute(route, call) {
    let reply = null;
    const url = new URL(call.path, "http://127.0.0.1");
    const res = { headersSent: false, writableEnded: false };
    const out = await route({
        req: { headers: { "content-type": "application/json" } }, res, url, path: url.pathname, method: call.method, auth: call.auth,
        json: (_res, status, body) => { reply = { status, body: (body ?? {}) }; },
        readBody: async () => call.body,
    });
    if (reply)
        return reply;
    return out === PASS ? { status: 404, body: { error: `no route for ${call.method} ${call.path}` } } : { status: 500, body: { error: "the route sent no reply" } };
}
