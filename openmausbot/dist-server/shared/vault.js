/**
 * The Vault: saved logins (shared/logins.ts) and saved secrets, kept
 * encrypted on the computer OpenMausBot runs on. A bot uses a saved secret
 * through a one-use reference or a private file and never sees it. Clients
 * see a saved secret as a list row, never its value.
 */
import { CUSTOM_SECRET_LABEL_MAX } from "./credential-request.js";
export const VAULT_SECRET_NAME_MAX = CUSTOM_SECRET_LABEL_MAX;
export const SECRET_VALUE_MAX_BYTES = 4_096;
/** The form two secret names are compared in: "Stripe secret key" and "stripe-secret-key" are one name. */
export function vaultNameKey(name) {
    return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
