// Whether a turn that failed to start may go to automatic recovery, which closes it and lets the
// backup engine answer instead (createAcpDriver's session/prompt catch). core.ts still checks that
// the turn did nothing: no account or sign-in failure, no activity, text, tool or question.
import { classifyError } from "../retry.js";
const DENIED = /\b(?:(?:permission|access) denied|(?:approval|permission) (?:required|denied|rejected)|requires? (?:approval|permission)|policy (?:restriction|violation)|(?:blocked|denied|restricted) by (?:the )?policy)\b/i;
/** Before the prompt went out: a transient failure or an unconfirmed approval. After it: the harness
 * says the prompt never reached its model (AcpSupport.promptUnreachedModel); a prompt stall does not
 * count, since the model may still be working. A policy or permission refusal never recovers. */
export function startupFailureRecoverable(error, message, code, turn) {
    const failure = classifyError({ text: message });
    const transientStartup = failure.transient || (failure.reason === "unknown" && code === "upstream_outage");
    const retryableStartup = turn.approvalUnconfirmed || (transientStartup && (!code || code === "upstream_outage")
        && ![-32700, -32600, -32601, -32602].includes(error?.code));
    return ((retryableStartup && !turn.promptSent) || (turn.promptUnreachedModel && error?.acpPromptStall !== true))
        && !DENIED.test(message);
}
