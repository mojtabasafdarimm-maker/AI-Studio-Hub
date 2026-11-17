import { parentPort, workerData } from "node:worker_threads";
import { userErrorFields } from "./user-errors.js";
import { createWorkspaceBackupSnapshot } from "./workspace-backup.js";
const { dataDir, options, jobId } = workerData;
try {
    // Never send the password or options back.
    parentPort.postMessage({ result: await createWorkspaceBackupSnapshot(dataDir, options, jobId) });
}
catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : "The workspace backup could not finish.", ...userErrorFields(error) });
}
