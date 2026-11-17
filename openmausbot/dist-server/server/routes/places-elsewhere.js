import { elsewhereSchema } from "../places-elsewhere.js";
import { PASS } from "./table.js";
const PATH = "/api/places/elsewhere";
export function createPlacesElsewhereRoutes({ elsewhere, owner }) {
    return async ({ req, res, path, method, auth, json, readBody }) => {
        if (path !== PATH)
            return PASS;
        res.setHeader("cache-control", "no-store");
        if (!owner(auth)) {
            req.resume();
            return json(res, 403, { error: "Only this place's owner can say where their other bots live." });
        }
        if (method === "GET")
            return json(res, 200, elsewhere.read() ?? { v: 1, places: [] });
        if (method !== "PUT")
            return json(res, 405, { error: "method not allowed" });
        const body = elsewhereSchema.safeParse(await readBody(req, 256 * 1024));
        if (!body.success)
            return json(res, 400, { error: "send { v: 1, self: { name, kind }, places: [{ name, kind, bots }] }" });
        elsewhere.write(body.data);
        return json(res, 200, { ok: true });
    };
}
