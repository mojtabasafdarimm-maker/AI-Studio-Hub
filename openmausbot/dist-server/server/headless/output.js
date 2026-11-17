// With --json, stdout carries exactly one JSON document, errors included ({ ok: false, error, hint, exitCode }); progress
// goes to stderr, dropped by --quiet. Every printed string passes through the transcript's secret redaction.
import { redactSecretsInText } from "../../shared/redact.js";
export function processIo() {
    return {
        out: (text) => { process.stdout.write(`${text}\n`); },
        err: (text) => { process.stderr.write(`${text}\n`); },
        readStdin: async () => {
            const chunks = [];
            for await (const chunk of process.stdin)
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            return Buffer.concat(chunks).toString("utf8");
        },
    };
}
export function redactDeep(value) {
    if (typeof value === "string")
        return redactSecretsInText(value);
    if (Array.isArray(value))
        return value.map(redactDeep);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
    }
    return value;
}
export class Output {
    json;
    quiet;
    io;
    constructor(io, mode) {
        this.io = io;
        this.json = mode.json === true;
        this.quiet = mode.quiet === true;
    }
    progress(event) {
        if (!this.quiet)
            this.io.err(JSON.stringify(redactDeep(event)));
    }
    result(value, human) {
        if (this.json)
            this.io.out(JSON.stringify(redactDeep(value), null, 2));
        else
            for (const line of human)
                this.io.out(redactSecretsInText(line));
    }
    error(error) {
        const body = { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}), exitCode: error.exitCode };
        if (this.json)
            this.io.out(JSON.stringify(redactDeep(body), null, 2));
        else {
            this.io.err(redactSecretsInText(`error: ${error.message}`));
            if (error.hint)
                this.io.err(redactSecretsInText(`hint: ${error.hint}`));
        }
    }
}
export const shortId = (id) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
export const oneLine = (text, max = 120) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
