// Node's fetch (undici 7.29 in Electron 43, 8.9 in Node 26) fails a request after 300 s without response headers
// or body bytes, whatever its signal allows. A local model sends nothing until its first token.
export const FETCH_LIMIT_MS = 300_000;
let unlimitedAgent;
export async function fetchPastLimit(url, init) {
    const { Agent: UndiciAgent, fetch: fetchWithoutLimits } = await import("undici");
    unlimitedAgent ??= new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });
    return fetchWithoutLimits(url, { ...init, dispatcher: unlimitedAgent });
}
