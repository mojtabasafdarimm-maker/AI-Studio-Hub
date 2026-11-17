// My Cloud's end of each lent computer's device link: while that computer is online and lends its internet
// connection, the bots' browsers here reach the web through it, so sites see the person's own connection.
import { isIP } from "node:net";
import { WebSocketServer } from "ws";
import { createLinkMux, LINK_ASLEEP, LINK_ENDED, MAX_CHUNK } from "../electron/device-link-protocol.mjs";
const PING_MS = 10_000;
/** A page opens many connections: the computer is marked used at most this often. */
const USED_EVERY_MS = 60_000;
export class DeviceLinks {
    #server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_CHUNK + 4 });
    #links = new Map();
    #pingMs;
    #closed = false;
    constructor(options = {}) {
        this.#pingMs = options.pingMs ?? PING_MS;
    }
    /** Answers the handshake for a computer the route has authorized. A Cloud going to sleep closes it as asleep, so the
     * computer waits for it to wake instead of dialling it; a newer link for the same computer replaces this one. */
    accept(upgrade, computer, power) {
        this.#server.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
            if (this.#closed) {
                ws.close(1001, "restarting");
                return;
            }
            if (power?.sleeping()) {
                ws.close(LINK_ASLEEP, "asleep");
                return;
            }
            this.drop(computer.key, 1000);
            const mux = createLinkMux({ send: (frame) => { if (ws.readyState === ws.OPEN)
                    ws.send(frame); } });
            const link = { ws, mux, computer: { ...computer, seenAs: computer.seenAs && isIP(computer.seenAs) ? computer.seenAs : null }, since: Date.now(), heard: true, usedAt: 0, ping: setInterval(() => {
                    if (!link.computer.live()) {
                        ws.close(LINK_ENDED, "lending ended");
                        return;
                    }
                    if (!link.heard) {
                        ws.terminate();
                        return;
                    }
                    link.heard = false;
                    try {
                        ws.ping();
                    }
                    catch { }
                }, this.#pingMs) };
            link.ping.unref();
            this.#links.set(computer.key, link);
            ws.send(JSON.stringify({ t: "hello", ...(link.computer.seenAs ? { seenAs: link.computer.seenAs } : {}) }));
            ws.on("pong", () => { link.heard = true; });
            ws.on("message", (data, binary) => {
                link.heard = true;
                const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
                if (binary)
                    return mux.receive(frame);
                const text = frame.toString("utf8");
                if (text === JSON.stringify({ t: "ping" })) {
                    ws.send(JSON.stringify({ t: "pong" }));
                    return;
                }
                mux.receive(text);
            });
            ws.on("error", () => ws.terminate());
            const sleep = power?.sleepSignal();
            const asleep = () => ws.close(LINK_ASLEEP, "asleep");
            sleep?.addEventListener("abort", asleep, { once: true });
            ws.once("close", () => {
                clearInterval(link.ping);
                sleep?.removeEventListener("abort", asleep);
                mux.close();
                if (this.#links.get(computer.key) === link)
                    this.#links.delete(computer.key);
            });
        });
    }
    /** The newest open link of `person`'s computers that lends its internet connection, or null. */
    route(person) {
        let newest = null;
        for (const link of this.#links.values()) {
            if (link.computer.person !== person || !link.computer.internet || link.ws.readyState !== link.ws.OPEN || !link.computer.live())
                continue;
            if (!newest || link.since > newest.since)
                newest = link;
        }
        const chosen = newest;
        return chosen ? { open: async (target) => {
                const opened = await chosen.mux.open(target);
                if ("join" in opened && Date.now() - chosen.usedAt >= USED_EVERY_MS) {
                    chosen.usedAt = Date.now();
                    chosen.computer.used?.();
                }
                return opened;
            } } : null;
    }
    /** The newest open link of `person`'s computers that lends its Chrome, or null. */
    chromeRoute(person) {
        let newest = null;
        for (const link of this.#links.values()) {
            if (link.computer.person !== person || !link.computer.chrome || link.ws.readyState !== link.ws.OPEN || !link.computer.live())
                continue;
            if (!newest || link.since > newest.since)
                newest = link;
        }
        const chosen = newest;
        return chosen ? { open: async () => {
                const opened = await chosen.mux.open({ chrome: true });
                if ("join" in opened && Date.now() - chosen.usedAt >= USED_EVERY_MS) {
                    chosen.usedAt = Date.now();
                    chosen.computer.used?.();
                }
                return opened;
            } } : null;
    }
    /** Lending from that computer ended or changed: its link ends with it. */
    drop(key, code = LINK_ENDED) {
        const link = this.#links.get(key);
        if (!link)
            return;
        this.#links.delete(key);
        link.ws.close(code, code === LINK_ENDED ? "lending ended" : "replaced");
    }
    close() {
        this.#closed = true;
        for (const link of this.#links.values())
            link.ws.close(1001, "restarting");
        this.#links.clear();
    }
}
