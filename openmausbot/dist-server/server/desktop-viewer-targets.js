import { viewerTargetId } from "../shared/desktop-viewer.js";
import { desktopViewerUrl } from "./routes/desktop-viewer.js";
/** Native owner windows keep the existing direct viewer and cookie isolation. */
export function localVmViewerStatus(status, auth) {
    return auth.kind === "loopback" ? status : {
        ...status,
        viewer_url: status.viewer_url ? desktopViewerUrl(viewerTargetId({ key: status.target_key })) : "",
    };
}
export function localDesktopTarget(target, deps) {
    return {
        key: target.key,
        async resolve() {
            const status = await deps.status(target);
            if (!status.managed || !status.imageMatches || status.network !== "loopback" || status.container !== "running"
                || !status.viewer_url) {
                throw Object.assign(new Error("Local VM unavailable"), { status: 409 });
            }
            return {
                port: status.viewer_port ?? 0,
                password: new URLSearchParams(new URL(status.viewer_url).hash.slice(1)).get("password"),
                touch: () => deps.touch(target),
            };
        },
    };
}
