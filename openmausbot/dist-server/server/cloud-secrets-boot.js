// Must stay the server's first import: on a Cloud home the secret pipe is read and closed before any other module loads,
// so no process the server starts can inherit it.
import { takeCloudSecrets } from "./cloud-secrets.js";
export const BOOT_CLOUD_SECRETS = takeCloudSecrets();
