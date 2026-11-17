// Local pages for the driver's real-Chrome suites. The server answers on
// 127.0.0.1 and on localhost (::1 too), two sites, so a frame from the other
// one runs out of process.
import { createServer } from "node:http";
export class FixtureServer {
    #routes = new Map();
    #servers = [];
    requests = [];
    port = 0;
    static async start() {
        const fixtures = new FixtureServer();
        await fixtures.#listen();
        return fixtures;
    }
    async #listen() {
        const first = createServer((request, response) => this.#handle(request, response));
        await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
        this.port = first.address().port;
        this.#servers.push(first);
        const second = createServer((request, response) => this.#handle(request, response));
        await new Promise((resolve) => {
            second.once("error", () => resolve());
            second.listen(this.port, "::1", () => resolve());
        });
        if (second.listening)
            this.#servers.push(second);
    }
    /** http://127.0.0.1:<port><path> */
    url(path) {
        return `http://127.0.0.1:${this.port}${path}`;
    }
    /** The same path on the other site. */
    crossSiteUrl(path) {
        return `http://localhost:${this.port}${path}`;
    }
    route(path, route) {
        this.#routes.set(path, route);
        return this.url(path);
    }
    page(path, html) {
        return this.route(path, { body: html });
    }
    #handle(request, response) {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        this.requests.push(`${request.method} ${url.host}${url.pathname}`);
        const route = this.#routes.get(url.pathname);
        if (!route) {
            response.writeHead(404, { "content-type": "text/plain" });
            response.end("not here");
            return;
        }
        const answer = typeof route === "function" ? route(request, url) : route;
        const send = () => {
            response.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "text/html; charset=utf-8", "cache-control": "no-store", ...answer.headers });
            response.end(answer.body);
        };
        if (answer.delayMs)
            setTimeout(send, answer.delayMs);
        else
            send();
    }
    async close() {
        await Promise.all(this.#servers.map((server) => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        })));
    }
}
