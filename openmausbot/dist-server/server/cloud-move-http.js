export const CLOUD_MOVE_PREFIX = "/api/cloud-move";
export const COPY_REFUSAL = "Update OpenMausBot to bring your bots here by itself.";
export function createCloudMoveRoutes() {
    return (res, path) => {
        if (path !== CLOUD_MOVE_PREFIX && !path.startsWith(`${CLOUD_MOVE_PREFIX}/`))
            return false;
        res.writeHead(410, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: COPY_REFUSAL }));
        return true;
    };
}
