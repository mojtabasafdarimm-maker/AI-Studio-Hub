// FTS5's unicode61 tokenizer has no CJK dictionary and indexes a whole Han or kana run as one token, so a word in the
// middle of a sentence can never match. Each CJK character becomes its own token instead (split by U+200B, which
// unicode61 treats as a separator and a reader never sees), and a query asks for its characters as phrases.
// Unicode puts the long vowel mark (ー, ｰ) and the half-width voicing marks (ﾞ, ﾟ) in the Common script, not kana.
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30fc\\uff70\\uff9e\\uff9f";
const CJK_CHAR = new RegExp(`[${CJK}]`, "u");
const HAN = /\p{Script=Han}/u;
const CJK_RUNS = new RegExp(`[${CJK}]+|[^${CJK}]+`, "gu");
const CJK_BOUNDARY = new RegExp(`(?<=[${CJK}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?=[${CJK}])`, "gu");
/** U+200B ZERO WIDTH SPACE, written escaped so no editor or formatter can drop it unseen. */
export const SEARCH_MARK = "\u200b";
/** Particles, filler words and a stretched vowel (えーーー) say nothing about what a note is about; they also end a run,
 * so no bigram straddles one. */
const FILLER = new RegExp("[ーｰ]{2,}|我们|你们|他们|她们|它们|这个|那个|一下|一个|可以|时候|现在|知道|告诉|记得|还是|就是|不是|没有|已经|因为|所以|但是|如果|然后|还有|请问|帮我|怎样|这样|那样|哪里|哪个|应该|一些|[的了是吗呢吧啊呀哦嗯么]", "gu");
export const hasCjk = (text) => CJK_CHAR.test(text);
/** The indexed form of `text`, or null when it holds no CJK and is indexed as written. */
export function cjkSearchText(text) {
    return text && hasCjk(text) ? text.replace(CJK_BOUNDARY, SEARCH_MARK) : null;
}
export const withoutSearchMarks = (snippet) => snippet.replaceAll(SEARCH_MARK, "");
/** A quoted FTS5 phrase whose tokens line up with the indexed form. */
export const ftsPhrase = (term) => `"${term.replace(/"/g, "").replace(CJK_BOUNDARY, " ")}"`;
/** `token` split into its CJK runs and the rest; each CJK run becomes its overlapping bigrams, so a paraphrase still
 * shares most of them with a note. A run with no bigram asks for its lone Han characters; a lone kana is a particle. */
export function cjkTokenParts(token) {
    const other = [];
    const bigrams = [];
    for (const run of token.match(CJK_RUNS) ?? []) {
        if (!hasCjk(run)) {
            other.push(run);
            continue;
        }
        const segments = run.replace(FILLER, " ").split(" ").map((segment) => [...segment]);
        for (const chars of segments)
            for (let i = 0; i + 1 < chars.length; i++)
                bigrams.push(chars[i] + chars[i + 1]);
        // A run with no bigram at all ("猫", "猫的粮") still asks for its Han characters; a leftover beside bigrams is noise.
        if (segments.every((chars) => chars.length < 2))
            for (const chars of segments)
                if (chars.length === 1 && HAN.test(chars[0]))
                    bigrams.push(chars[0]);
    }
    return { other, bigrams };
}
/** The table's FTS5 index over `coalesce(search_text, text)`, built or migrated from the plain-text index. */
export function ensureSearchIndex(db, { table, fts, view, triggerPrefix: t }) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === "search_text"))
        db.exec(`ALTER TABLE ${table} ADD COLUMN search_text TEXT`);
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(fts);
    const current = Boolean(existing?.sql.includes(`'${view}'`));
    if (!current) {
        db.exec(`DROP TRIGGER IF EXISTS ${t}_ai; DROP TRIGGER IF EXISTS ${t}_ad; DROP TRIGGER IF EXISTS ${t}_au; DROP TABLE IF EXISTS ${fts};`);
        const update = db.prepare(`UPDATE ${table} SET search_text = ? WHERE rowid = ?`);
        db.exec("BEGIN");
        try {
            for (const row of db.prepare(`SELECT rowid, text FROM ${table} WHERE text IS NOT NULL AND search_text IS NULL`).iterate()) {
                const searchText = cjkSearchText(row.text);
                if (searchText)
                    update.run(searchText, row.rowid);
            }
            db.exec("COMMIT");
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
    db.exec(`
    CREATE VIEW IF NOT EXISTS ${view} AS SELECT rowid AS rid, coalesce(search_text, text) AS text FROM ${table};
    CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(
      text, content='${view}', content_rowid='rid', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS ${t}_ai AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${fts}(rowid, text) VALUES (new.rowid, coalesce(new.search_text, new.text));
    END;
    CREATE TRIGGER IF NOT EXISTS ${t}_ad AFTER DELETE ON ${table} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, text) VALUES ('delete', old.rowid, coalesce(old.search_text, old.text));
    END;
    CREATE TRIGGER IF NOT EXISTS ${t}_au AFTER UPDATE ON ${table} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, text) VALUES ('delete', old.rowid, coalesce(old.search_text, old.text));
      INSERT INTO ${fts}(rowid, text) VALUES (new.rowid, coalesce(new.search_text, new.text));
    END;
  `);
    if (!current)
        db.exec(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`);
}
