import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { validateAntigravityRuntime } from "./drivers/antigravity-acp.js";
import { antigravityManagedInstallAvailable, antigravityOlderRuntime, installAntigravityRuntime } from "./drivers/antigravity-runtime.js";
import { antigravityRuntimesRoot } from "./engine-roots.js";
import { createEngineUpdater, enginePlans } from "./engine-updates.js";
function managedRuntimes() {
    if (!antigravityManagedInstallAvailable())
        return {};
    return {
        antigravityAgent: {
            older: () => antigravityOlderRuntime(),
            install: () => installAntigravityRuntime({ validate: validateAntigravityRuntime }).then(() => { }),
            folder: antigravityRuntimesRoot(DATA_DIR),
        },
    };
}
/** The server's engine updater; `start()` it once the server is up. */
export function engineUpdatesFor(deps) {
    return createEngineUpdater({
        plans: enginePlans(deps.drivers, managedRuntimes()),
        statePath: join(DATA_DIR, "providers", "engine-updates.json"),
        turnRunning: deps.turnRunning,
        configuredClis: deps.configuredClis,
        updated: deps.updated,
    });
}
