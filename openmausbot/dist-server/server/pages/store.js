import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PAGE_ID } from "../../shared/published-page.js";
import { writeFileAtomic } from "../atomic.js";
const MAX_RECORDS = 5_000, MAX_CARDS = 50;
/** The pages this server published, kept in one small JSON file in the data dir. Unpublished pages are dropped. */
export class PublishedPagesStore {
    records;
    file;
    constructor(file) {
        this.file = file;
        this.records = PublishedPagesStore.read(file);
    }
    static read(file) {
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            return parsed.version === 1 && Array.isArray(parsed.pages)
                ? parsed.pages.filter((page) => typeof page?.pageId === "string" && PAGE_ID.test(page.pageId) && typeof page.url === "string" && typeof page.botId === "string")
                : [];
        }
        catch {
            return [];
        }
    }
    save() {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileAtomic(this.file, JSON.stringify({ version: 1, pages: this.records }), { mode: 0o600 });
    }
    get(pageId) {
        return this.records.find((record) => record.pageId === pageId) ?? null;
    }
    /** The bot's own page from this file or folder, so publishing it again keeps its link. */
    fromSource(botId, source) {
        return this.records.find((record) => record.botId === botId && record.source === source) ?? null;
    }
    list() {
        return this.records;
    }
    /** Records a publish (a new page or an update) and the card that shows it. */
    published(input, now = Date.now()) {
        const existing = this.get(input.pageId);
        const cards = [...(existing?.cards ?? []), ...(input.card ? [input.card] : [])].slice(-MAX_CARDS);
        const record = { pageId: input.pageId, url: input.url, title: input.title, botId: input.botId, source: input.source, cards,
            createdAt: existing?.createdAt ?? now, updatedAt: now,
            ...(input.live ? { live: true, ...(input.signature ? { signature: input.signature } : {}) } : {}), ...(input.uncertain ? { uncertain: true } : {}) };
        this.records = [...this.records.filter((each) => each.pageId !== input.pageId), record].slice(-MAX_RECORDS);
        this.save();
        return record;
    }
    forget(pageId) {
        const existing = this.get(pageId);
        if (!existing)
            return null;
        this.records = this.records.filter((record) => record.pageId !== pageId);
        this.save();
        return existing;
    }
}
