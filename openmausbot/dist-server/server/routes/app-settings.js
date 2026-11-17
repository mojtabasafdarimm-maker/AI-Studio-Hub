import { isWindowPrefId, WINDOW_PREFS, windowPrefReportSchema } from "../../shared/app-settings.js";
import { PASS } from "./table.js";
export const INTERNAL_APP_SETTINGS_PATH = "/api/internal/app-settings";
export const WINDOW_PREFS_PATH = "/api/window-prefs";
/** Only dispatch inside the internal capability gate, with its guarded body reader; never in the global route table. */
export function createInternalAppSettingsRoutes(deps) {
    return async ({ res, path, method, json }) => {
        if (method !== "POST" || path !== INTERNAL_APP_SETTINGS_PATH)
            return PASS;
        const result = await deps.handle(await deps.readBody());
        return json(res, result.status, result.body);
    };
}
/** The window's own preferences live in its localStorage or behind the desktop app's bridge. The window reports them
 * here; the server keeps the last report and pushes a change back as a `window-pref` frame, which only an open window
 * can apply. One the window never reported is one it can't change (a browser has no desktop bridge). */
export function createWindowPrefs(deps) {
    const values = new Map();
    const routes = async ({ req, res, path, method, auth, json, readBody }) => {
        if (method !== "PUT" || path !== WINDOW_PREFS_PATH)
            return PASS;
        if (!deps.ownerOrAdmin(auth))
            return json(res, 403, { error: "Only the owner's window reports its preferences." });
        const parsed = windowPrefReportSchema.safeParse(await readBody(req));
        if (!parsed.success)
            return json(res, 400, { error: "values must be an object of preference id to value" });
        for (const [id, value] of Object.entries(parsed.data.values)) {
            if (isWindowPrefId(id) && WINDOW_PREFS[id].safeParse(value).success)
                values.set(id, value);
        }
        return json(res, 200, { ok: true });
    };
    return {
        routes,
        read: (id) => values.get(id),
        write(id, value) {
            if (!deps.windowOpen())
                return "Open MausBot on this computer first; this setting lives in the app window.";
            if (!values.has(id))
                return "The open MausBot window can't change this here. It is changed in MausBot's desktop app on this computer.";
            values.set(id, value);
            deps.broadcast({ kind: "window-pref", id, value }, { adminOnly: true });
            return null;
        },
    };
}
