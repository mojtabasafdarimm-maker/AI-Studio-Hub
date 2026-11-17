const MAX_LINE_CHARS = 64 * 1024;
export class SignInRequests {
    #asked = new WeakSet();
    #support;
    #instanceId;
    constructor(support, instanceId) {
        this.#support = support;
        this.#instanceId = instanceId;
    }
    #error() {
        return Object.assign(new Error(this.#support.loginNote), { acpSignInRequired: true });
    }
    watch(host) {
        this.#support.processStarted?.(host.child, this.#instanceId);
        const request = this.#support.signInRequest;
        if (!request)
            return;
        let partial = "";
        host.child.stderr.on("data", (chunk) => {
            const lines = (partial + String(chunk)).split("\n");
            partial = lines.pop() ?? "";
            if (partial.length > MAX_LINE_CHARS)
                partial = "";
            if (this.#asked.has(host) || !lines.some((line) => request.stderrLine(line.replace(/\r$/u, ""))))
                return;
            this.#asked.add(host);
            host.draining = true;
            request.required(this.#instanceId);
            for (const link of host.links)
                link.failAll(this.#error());
        });
    }
    /** A rejection for any further request to a process that asked; null for every other process. */
    refused(host) {
        return this.#asked.has(host) ? Promise.reject(this.#error()) : null;
    }
    is(error) {
        return error?.acpSignInRequired === true;
    }
    /** The sign-in failure `error` stands for, or null when it is some other failure. */
    asked(error) {
        if (this.is(error))
            return error;
        if (!this.#support.signInRequest?.rpcError(error))
            return null;
        this.#support.signInRequest.required(this.#instanceId);
        return this.#error();
    }
}
