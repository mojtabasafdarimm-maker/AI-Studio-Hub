import { execCli } from "../procs.js";
/** Whether `claude` is signed in, per the CLI's own `auth status`: credential storage varies by
 * platform (Keychain, a JSON file) and presence checks accept stale credentials. Only `loggedIn: false`
 * means signed out. A check that timed out (a Keychain prompt left open) or gave no readable status
 * says nothing, so `authenticated` is left out. */
export function claudeAuthStatus(cli, env, run = execCli) {
    return new Promise((resolve) => {
        run(cli, ["auth", "status", "--json"], { timeout: 8000, maxBuffer: 65_536, env }, (error, stdout) => {
            if (error?.killed)
                return resolve({});
            try {
                const status = JSON.parse(stdout);
                const loggedIn = status && typeof status === "object" && "loggedIn" in status ? status.loggedIn : undefined;
                if (loggedIn !== true)
                    return resolve(loggedIn === false ? { authenticated: false } : {});
                const identity = status;
                const boundedText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)
                    ? value.trim() : undefined;
                const candidateEmail = boundedText(identity.email, 254);
                const email = candidateEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail) ? candidateEmail : undefined;
                const organization = boundedText(identity.orgName, 160);
                const account = {
                    ...(email ? { email } : {}),
                    ...(organization ? { organization } : {}),
                    ...(identity.authMethod === "api_key" ? { method: "api-key" } : {}),
                };
                resolve({ authenticated: true, ...(Object.keys(account).length ? { account } : {}) });
            }
            catch {
                resolve({});
            }
        });
    });
}
export async function claudeSignedIn(cli, env, run = execCli) {
    return (await claudeAuthStatus(cli, env, run)).authenticated === true;
}
