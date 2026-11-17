// Kept apart from config.json so a pasted or exported config never carries a token; a token never follows its entry to another URL.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
const tokensSchema = z.object({
    access: z.string().min(1),
    refresh: z.string().min(1).optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
});
const recordSchema = z.object({
    url: z.string(),
    state: z.enum(["needs-sign-in", "signed-in"]),
    issuer: z.string().optional(),
    clientId: z.string().optional(),
    /** The secret stays in config.json; it is never kept here. */
    tokenAuth: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
    redirectUri: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    revocationEndpoint: z.string().optional(),
    tokens: tokensSchema.optional(),
});
const fileSchema = z.object({
    servers: z.record(z.string(), recordSchema).default({}),
});
/** One sign-in as this store keeps it, from anywhere else (a sign-in moved from the person's own computer); null if not. */
export function parseMcpOAuthRecord(value) {
    const parsed = recordSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
export class McpOAuthStore {
    file;
    constructor(file) {
        this.file = file;
    }
    get(name, url) {
        const record = this.read().servers[name];
        return record && record.url === url ? record : undefined;
    }
    put(name, record) {
        const data = this.read();
        data.servers[name] = recordSchema.parse(record);
        this.write(data);
    }
    delete(name) {
        const data = this.read();
        if (!Object.hasOwn(data.servers, name))
            return;
        delete data.servers[name];
        this.write(data);
    }
    // Read through on every call: another process may have changed the file.
    read() {
        try {
            const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
            if (parsed.success)
                return parsed.data;
        }
        catch {
        }
        return { servers: {} };
    }
    write(data) {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    }
}
