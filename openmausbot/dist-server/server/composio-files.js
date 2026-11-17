// Where to put one file's bytes so a connected-app tool can read it by `s3key`: Composio's one-time upload link, asked
// for with the project key, or through the managed connection service, which holds the key
// (cloudflare/composio-broker/src/files.ts). Chosen the way relayMcp chooses: a member's own installation, else the
// project key, else the service.
import { z } from "zod";
import { brokerAccess } from "./composio-broker-access.js";
import { apiBase, projectHeaders, responseError } from "./composio-project.js";
import { projectApiKey } from "./composio-session.js";
import { composioUploadLink } from "../shared/composio-storage.js";
/** A service run on this computer for development or tests hands out links on this computer too. */
function loopback(link) {
    try {
        const url = new URL(link ?? "");
        return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    }
    catch {
        return false;
    }
}
function sameOrigin(link, other) {
    try {
        return Boolean(link && other) && new URL(link).origin === new URL(other).origin;
    }
    catch {
        return false;
    }
}
function hostOf(link) {
    try {
        return new URL(link ?? "").host || "no host";
    }
    catch {
        return "no link";
    }
}
const projectAnswerSchema = z.object({ key: z.string().min(1), new_presigned_url: z.string().optional(), newPresignedUrl: z.string().optional() });
const serviceAnswerSchema = z.object({ key: z.string().min(1), url: z.string().min(1) });
export async function requestFileUpload(cfg, request, as) {
    const apiKey = as ? null : projectApiKey(cfg);
    const broker = apiKey ? null : as ?? brokerAccess();
    if (!apiKey && !broker)
        throw new Error("connected apps are unavailable");
    const response = await fetch(apiKey ? `${apiBase()}/files/upload/request` : `${broker.url}/v1/files/upload`, {
        method: "POST",
        headers: apiKey ? projectHeaders(apiKey, true) : { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
        throw new Error(await responseError(response, `the upload service answered HTTP ${response.status}`));
    const body = await response.json();
    const answer = apiKey ? projectAnswerSchema.parse(body) : serviceAnswerSchema.parse(body);
    const link = "url" in answer ? answer.url : answer.new_presigned_url ?? answer.newPresignedUrl;
    // Composio's storage; or, from a service on this computer, a link on this computer; or, with the project key, a link
    // on the origin of an explicitly named Composio backend (OMB_COMPOSIO_API), as trustedSessionMcpUrl allows its Sessions.
    const url = composioUploadLink(link)
        ?? (broker && loopback(broker.url) && loopback(link) ? new URL(link) : null)
        ?? (apiKey && sameOrigin(link, process.env.OMB_COMPOSIO_API) && (link.startsWith("https:") || loopback(link)) ? new URL(link) : null);
    if (!url)
        throw new Error(`Composio returned an upload link that is not on its storage (${hostOf(link)})`);
    return { key: answer.key, url: url.toString() };
}
