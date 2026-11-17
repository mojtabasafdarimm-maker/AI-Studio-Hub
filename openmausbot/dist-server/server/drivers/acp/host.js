import { engineMemory } from "../../engine-memory.js";
import { appendNative } from "../native.js";
import { StderrTail } from "./exit-report.js";
import { acpRpcError } from "./rpc-error.js";
/** A catalog can contain credential-bearing native configuration, including late replies. */
export function acpNativeIncomingLogMessage(message, privateResponses) {
    if (!privateResponses.has(message?.id))
        return message;
    return { jsonrpc: message.jsonrpc, id: message.id, ...(message.error !== undefined ? { error: "[MCP catalog error omitted]" } : { result: "[MCP catalog omitted]" }) };
}
export class AcpLink {
    sessionId = null;
    inbound = null;
    closed = false;
    #lastInboundAt = Date.now();
    host;
    threadId;
    constructor(host, threadId) {
        this.host = host;
        this.threadId = threadId;
    }
    get lastInboundAt() { return this.#lastInboundAt; }
    heard() {
        this.#lastInboundAt = Date.now();
        this.touch();
    }
    send(obj) {
        const message = obj;
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined))
            this.touch();
        this.host.write(obj, this.threadId);
    }
    request(method, params, timeoutMs, receive, idleMs, idleMessage) {
        return this.host.request(this, method, params, timeoutMs, receive, idleMs, idleMessage);
    }
    touch() { this.host.touch(this); }
    failAll(error) { this.host.failAll(this, error); }
    close() {
        if (this.closed)
            return;
        this.failAll(new Error("session closed"));
        this.closed = true;
        this.host.unlink(this);
    }
}
export class AcpHost {
    links = new Set();
    /** The last thread to leave still hears the process end: its stopped turn settles on it. */
    #lastOut = null;
    initResult = null;
    authenticated = false;
    /** The last stderr lines, masked, for the exit message. */
    stderrTail = new StderrTail();
    dead = false;
    /** Takes no new sessions; it ends when its last one closes. */
    draining = false;
    /** Sessions ever linked, and those closed while others went on: an agent may keep a closed session's memory and MCP
     * servers until its process exits (OpenCode 1.19.3 does). */
    opened = 0;
    retired = 0;
    recycle = null;
    /** Security: the thread each folder belongs to, for the process's life. An agent may keep MCP servers per folder and
     * name, not per session (OpenCode 1.18.27: session/new and session/load call mcp.add({ directory, name })), so a
     * second thread in a folder would call through the first one's servers and act on that thread's turn capability. */
    #folders = new Map();
    #nextId = 1;
    #pending = new Map();
    #privateResponses = new Set();
    #once = new Map();
    child;
    key;
    options;
    constructor(child, key, options) {
        this.child = child;
        this.key = key;
        this.options = options;
        let buf = "";
        // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
        // multibyte characters that straddle two reads and corrupts the text
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim())
                    continue;
                let msg;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    continue;
                }
                this.#receive(msg);
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => this.stderrTail.write(chunk));
        child.on("error", (error) => {
            this.dead = true;
            for (const link of this.#listening())
                link.inbound?.error(error);
        });
        child.on("close", (code, signal) => {
            this.dead = true;
            this.stderrTail.flush();
            for (const link of this.#listening())
                link.inbound?.exit(code, signal);
        });
    }
    /** Room for `threadId` in `folder`: alive, not draining, under `limit` sessions open and `lifetime` ever opened, and
     * no other thread has had a session in that folder here. */
    accepts(limit, lifetime, threadId, folder) {
        const owner = this.#folders.get(folder);
        return !this.dead && !this.draining && this.child.exitCode === null && this.links.size < limit && this.opened < lifetime &&
            (owner === undefined || owner === threadId);
    }
    link(threadId, folder) {
        this.#folders.set(folder, threadId);
        const link = new AcpLink(this, threadId);
        this.links.add(link);
        this.opened += 1;
        engineMemory.attach(this.child, threadId);
        return link;
    }
    unlink(link) {
        if (!this.links.delete(link))
            return;
        if (!this.links.size)
            this.#lastOut = link;
        if (![...this.links].some((other) => other.threadId === link.threadId))
            engineMemory.detach(this.child, link.threadId);
    }
    #listening() {
        return this.#lastOut ? [...this.links, this.#lastOut] : [...this.links];
    }
    /** Runs `start` once per process (initialize, authenticate): later sessions reuse its answer. A failure lets the next
     * session try again. */
    once(name, start) {
        let running = this.#once.get(name);
        if (!running) {
            running = start();
            this.#once.set(name, running);
            running.catch(() => { if (this.#once.get(name) === running)
                this.#once.delete(name); });
        }
        return running;
    }
    write(obj, threadId) {
        try {
            this.child.stdin.write(JSON.stringify(obj) + "\n");
        }
        catch { }
        if (threadId !== null)
            appendNative(threadId, { dir: "out", source: this.options.source, msg: this.options.logMessage(obj) });
    }
    request(link, method, params, timeoutMs, receive, idleMs, idleMessage) {
        return new Promise((resolve, reject) => {
            const id = this.#nextId++;
            if (method === "_x.ai/mcp/list")
                this.#privateResponses.add(id);
            let timer = null;
            if (timeoutMs) {
                timer = setTimeout(() => {
                    this.#pending.delete(id);
                    reject(Object.assign(new Error(`${method} timed out`), { acpSessionFailure: true }));
                }, timeoutMs);
                timer.unref?.();
            }
            let idleTimer = null;
            const armIdle = () => {
                if (!(idleMs && idleMs > 0))
                    return;
                if (idleTimer)
                    clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (link?.inbound?.busy()) {
                        armIdle();
                        return;
                    }
                    this.#pending.delete(id);
                    const error = new Error((typeof idleMessage === "function" ? idleMessage() : idleMessage) ?? `${method} stopped responding`);
                    Object.assign(error, { acpPromptStall: true });
                    reject(error);
                }, idleMs);
                idleTimer.unref?.();
            };
            armIdle();
            this.#pending.set(id, {
                link,
                method,
                // Wire order: an update following this response may arrive before the awaiting continuation resumes.
                resolve: (result) => { receive?.(result); resolve(result); },
                reject,
                timer,
                get idleTimer() { return idleTimer; },
                armIdle,
            });
            this.write({ jsonrpc: "2.0", id, method, params }, link?.threadId ?? null);
        });
    }
    touch(link) {
        for (const pending of this.#pending.values())
            if (pending.link === link)
                pending.armIdle();
    }
    failAll(link, error) {
        for (const [id, pending] of this.#pending) {
            if (pending.link !== link)
                continue;
            this.#pending.delete(id);
            if (pending.timer)
                clearTimeout(pending.timer);
            if (pending.idleTimer)
                clearTimeout(pending.idleTimer);
            pending.reject(error);
        }
    }
    /** The session's own traffic goes to the thread holding it; with one thread linked, everything does. */
    #route(msg) {
        const only = this.links.size === 1 ? this.links.values().next().value : null;
        if (msg.id !== undefined && msg.method === undefined)
            return this.#pending.get(msg.id)?.link ?? only;
        const sessionId = msg.params?.sessionId;
        if (typeof sessionId === "string") {
            for (const link of this.links)
                if (link.sessionId === sessionId)
                    return link;
            // A shared process never hands one session's traffic to another thread, such as a closed session's late update.
            if (this.key !== null)
                return only?.sessionId === null ? only : null;
        }
        return only;
    }
    #receive(msg) {
        const link = this.#route(msg);
        if (link) {
            appendNative(link.threadId, { dir: "in", source: this.options.source,
                msg: this.options.logMessage(acpNativeIncomingLogMessage(msg, this.#privateResponses)) });
            // Inbound traffic proves the session is alive and making progress, so its idle deadlines restart; only its
            // own silence trips one.
            link.heard();
        }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.#pending.get(msg.id);
            if (!pending)
                return;
            this.#pending.delete(msg.id);
            if (pending.timer)
                clearTimeout(pending.timer);
            if (pending.idleTimer)
                clearTimeout(pending.idleTimer);
            if (msg.error)
                pending.reject(acpRpcError(msg.error, pending.method));
            else
                pending.resolve(msg.result);
        }
        else if (msg.id !== undefined && msg.method) {
            if (link?.inbound && !link.closed)
                link.inbound.request(msg);
            else
                this.options.unrouted(msg, (obj) => this.write(obj, link?.threadId ?? null));
        }
        else if (msg.method && link && !link.closed) {
            link.inbound?.notification(msg);
        }
    }
}
