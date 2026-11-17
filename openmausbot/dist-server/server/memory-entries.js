// MEMORY.md entry grammar: `- YYYY-MM-DD · from <source> · text[ · until YYYY-MM-DD]`, struck through when superseded.
export const UNTIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATED = /^(- (\d{4}-\d{2}-\d{2}) · (?:from [^·\n]* · )?)(.*)$/;
const UNTIL_MARK = / · until (\d{4}-\d{2}-\d{2})(?= · |$)/;
const TRAILING_MARKS = /(?: · (?:updated|confirmed|until|expired|superseded|moved) \d{4}-\d{2}-\d{2})+$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
/** A safety or health fact always loads: neither organize nor the size rule moves one out of MEMORY.md. */
const ALWAYS_CORE = /\b(?:allerg\w*|anaphyla\w*|intoleran\w*|vegetarian|vegan|halal|kosher|gluten|lactose|diet\w*|diabet\w*|asthma\w*|epilep\w*|pregnan\w*|medicat\w*|medicine|medical|disabilit\w*|wheelchair|blind|deaf|health)\b/i;
export function alwaysCore(body) {
    return ALWAYS_CORE.test(body);
}
export function isMemoryDate(value) {
    if (typeof value !== "string" || !UNTIL_DATE.test(value))
        return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function untilMark(until) {
    return until ? ` · until ${until}` : "";
}
const togglesFence = (line) => (line.match(/```/g)?.length ?? 0) % 2 === 1;
/** Undated hand-written lines are not entries and upkeep never touches them. */
export function parseMemoryEntries(text) {
    const out = [];
    const lines = text.split("\n");
    for (let line = 0; line < lines.length;) {
        const raw = lines[line];
        const m = DATED.exec(raw);
        if (!m) {
            line += 1;
            continue;
        }
        let open = togglesFence(raw);
        let end = line + 1;
        for (let next = line + 1; next < lines.length && !DATED.test(lines[next]); next += 1) {
            if (!open && !/^[ \t]/.test(lines[next]) && !lines[next].startsWith("```"))
                break;
            if (togglesFence(lines[next]))
                open = !open;
            if (!open)
                end = next + 1;
        }
        const rest = m[3];
        const struck = rest.startsWith("~~");
        const until = UNTIL_MARK.exec(rest)?.[1] ?? null;
        const body = rest.replace(TRAILING_MARKS, "").replace(/^~~/, "").replace(/~~$/, "").trim();
        out.push({ line, end, raw, prefix: m[1], body, date: m[2], until, struck });
        line = end;
    }
    return out;
}
export function isExpired(entry, today) {
    return !entry.struck && entry.until !== null && entry.until < today;
}
export function withoutExpired(text, today) {
    const expired = parseMemoryEntries(text).filter((e) => isExpired(e, today));
    if (!expired.length)
        return { text, hidden: 0 };
    const dropped = new Set();
    for (const entry of expired)
        for (let line = entry.line; line < entry.end; line++)
            dropped.add(line);
    return { text: text.split("\n").filter((_, index) => !dropped.has(index)).join("\n"), hidden: expired.length };
}
/** Deliberately narrow: `-10` and `10`, `C++` and `C`, `API_KEY` and `api_key` stay different facts. */
export function factIdentity(text) {
    return text
        .normalize("NFC")
        .replace(BULLET, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\.$/, "")
        .trim();
}
export function lineFactIdentity(line) {
    const entry = parseMemoryEntries(line)[0];
    if (entry)
        return entry.struck ? "" : factIdentity(entry.body);
    return factIdentity(line.replace(/~~/g, ""));
}
export function notebookIdentities(text) {
    return new Set(text.split("\n").map(lineFactIdentity).filter(Boolean));
}
export function withoutSuperseded(text) {
    const dropped = new Set();
    for (const entry of parseMemoryEntries(text)) {
        if (entry.struck)
            for (let line = entry.line; line < entry.end; line++)
                dropped.add(line);
    }
    return text.split("\n").filter((_, index) => !dropped.has(index)).join("\n");
}
/** Case, width, curly quotes and spacing aside, so a passage matches however the note was typed. */
export function foldForMatch(text) {
    return text.normalize("NFKC").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();
}
/** Whether a note mentions `passage` as whole words ("IST" is not in "dentist"); null for a passage too short to name anything. */
export function passageMatcher(passage) {
    const folded = foldForMatch(passage);
    if ((folded.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3)
        return null;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${folded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
    return (text) => pattern.test(foldForMatch(text));
}
