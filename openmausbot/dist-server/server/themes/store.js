// Each person's themes on this workspace: <dataDir>/themes/<person>/<theme id>/theme.json with its files beside it in
// assets/, active.json naming the one their windows wear, and history.json with their last look changes.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOOK_HISTORY_LIMIT, rehomeThemeCss, THEME_ASSET_NAME, THEME_EXPORT_VERSION, THEME_ID, THEME_LIMITS, themeAssetType, themeAssetUrl, themeCssProblem, themeFileSchema, } from "../../shared/theme.js";
import { writeFileAtomic } from "../atomic.js";
import { appendHistory, lookAfter, readHistory } from "./history.js";
const refused = (refusal) => ({ refusal });
export const isRefusal = (value) => typeof value === "object" && value !== null && "refusal" in value;
/** A person's folder name: the key itself when it is plain, a hash otherwise, so no key can name a path. */
const personFolder = (person) => (/^[\w-]{1,64}$/.test(person) ? person : `h_${createHash("sha256").update(person).digest("hex").slice(0, 32)}`);
/** Route words under /api/themes/, and the tool's word for no theme. */
const RESERVED_IDS = new Set(["active", "history", "import", "none"]);
export const slugFor = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "theme";
/** Security: a file's first bytes must match its extension, so a theme file is only ever the image or font it claims. */
function looksLike(name, bytes) {
    const ext = name.slice(name.lastIndexOf(".") + 1);
    const starts = (...values) => values.every((value, index) => bytes[index] === value);
    const ascii = (at, text) => bytes.subarray(at, at + text.length).toString("latin1") === text;
    switch (ext) {
        case "png": return starts(0x89, 0x50, 0x4e, 0x47);
        case "jpg":
        case "jpeg": return starts(0xff, 0xd8, 0xff);
        case "gif": return ascii(0, "GIF8");
        case "webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
        case "avif": return ascii(4, "ftyp");
        case "woff": return ascii(0, "wOFF");
        case "woff2": return ascii(0, "wOF2");
        case "ttf": return starts(0x00, 0x01, 0x00, 0x00) || ascii(0, "true");
        case "otf": return ascii(0, "OTTO");
        case "svg": {
            const head = bytes.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
            return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head);
        }
        default: return false;
    }
}
export function createThemeStore(deps) {
    const root = join(deps.dataDir, "themes");
    const home = (person) => join(root, personFolder(person));
    const folder = (person, id) => join(home(person), id);
    const assetsDir = (person, id) => join(folder(person, id), "assets");
    const validId = (id) => THEME_ID.test(id) && !RESERVED_IDS.has(id);
    function read(person, id) {
        if (!validId(id))
            return null;
        try {
            const parsed = themeFileSchema.safeParse(JSON.parse(readFileSync(join(folder(person, id), "theme.json"), "utf8")));
            return parsed.success ? parsed.data : null;
        }
        catch {
            return null;
        }
    }
    function ids(person) {
        try {
            return readdirSync(home(person), { withFileTypes: true }).filter((entry) => entry.isDirectory() && validId(entry.name)).map((entry) => entry.name).sort();
        }
        catch {
            return [];
        }
    }
    function assets(person, id) {
        try {
            return readdirSync(assetsDir(person, id)).filter((name) => THEME_ASSET_NAME.test(name)).sort();
        }
        catch {
            return [];
        }
    }
    function active(person) {
        try {
            const value = JSON.parse(readFileSync(join(home(person), "active.json"), "utf8")).id;
            return typeof value === "string" && read(person, value) ? value : null;
        }
        catch {
            return null;
        }
    }
    function setActive(person, id) {
        if (id !== null && !read(person, id))
            return refused(`No saved theme has the id ${id}.`);
        mkdirSync(home(person), { recursive: true });
        writeFileAtomic(join(home(person), "active.json"), JSON.stringify({ id }));
        return null;
    }
    function saveProblem(person, id, file) {
        if (!validId(id))
            return refused("A theme id is lowercase letters, digits and dashes, up to 48 characters.");
        const problem = file.css ? themeCssProblem(file.css) : null;
        if (problem)
            return refused(problem);
        if (!read(person, id) && ids(person).length >= THEME_LIMITS.themesPerPerson)
            return refused(`You can keep up to ${THEME_LIMITS.themesPerPerson} themes. Delete one first.`);
        return null;
    }
    function writeTheme(person, id, file) {
        mkdirSync(folder(person, id), { recursive: true });
        writeFileAtomic(join(folder(person, id), "theme.json"), `${JSON.stringify(file, null, 2)}\n`);
    }
    /** Saves a theme without recording a look change: a copy, an import or a new name. */
    function save(person, id, file) {
        const problem = saveProblem(person, id, file);
        if (problem)
            return problem;
        writeTheme(person, id, file);
        return null;
    }
    const nameOf = (person, id) => read(person, id)?.name ?? id;
    function describe(person, before, after, edited, skin) {
        if (edited.length)
            return { kind: edited[0].was.file ? "edited" : "made", name: edited[0].file.name };
        if (after.id && after.id !== before.id)
            return { kind: "wore", name: nameOf(person, after.id) };
        if (after.id === before.id && after.skin === before.skin)
            return null;
        return skin && skin !== "system" ? { kind: "skin", name: skin } : { kind: "default" };
    }
    /** Saves themes and changes what is worn as one entry in the person's look history; answers the skin to put on. */
    function change(person, write) {
        const saves = write.saves ?? [];
        for (const { id, file } of saves) {
            const problem = saveProblem(person, id, file);
            if (problem)
                return problem;
        }
        if (write.wear && !read(person, write.wear) && !saves.some((save) => save.id === write.wear))
            return refused(`No saved theme has the id ${write.wear}.`);
        const known = readHistory(home(person)).at(-1)?.after.skin;
        const before = { id: active(person), ...(known ? { skin: known } : {}) };
        const themes = Object.fromEntries([...saves.map((save) => save.id), ...(write.keep ?? [])].map((id) => [id, { file: read(person, id), assets: assets(person, id) }]));
        for (const { id, file } of saves)
            writeTheme(person, id, file);
        if (write.wear !== undefined)
            setActive(person, write.wear);
        const skin = write.skin ?? known;
        const after = { id: active(person), ...(skin ? { skin } : {}) };
        const edited = saves.flatMap((save) => (JSON.stringify(themes[save.id].file) === JSON.stringify(save.file) ? [] : [{ ...save, was: themes[save.id] }]));
        const said = write.change ?? describe(person, before, after, edited, write.skin);
        if (said)
            appendHistory(home(person), { change: said, before, after, ...(Object.keys(themes).length ? { themes } : {}) });
        return write.skin ? { skin: write.skin } : {};
    }
    /** The person's kept look changes, newest first, each with the look right after it. */
    function history(person) {
        const since = {};
        return readHistory(home(person)).reverse().map((entry, index) => {
            const id = entry.after.id;
            const file = id ? (id in since ? since[id].file : read(person, id)) : null;
            Object.assign(since, entry.themes);
            return { index: index + 1, at: entry.at, ...entry.change, seq: entry.seq, look: entry.after, file };
        });
    }
    /** Goes back to how things looked right after change `seq`, as a new change, so going back on it is a redo. */
    function restore(person, seq) {
        const plan = lookAfter(readHistory(home(person)), seq);
        if (!plan)
            return refused(`Only the last ${LOOK_HISTORY_LIMIT} look changes are kept.`);
        if (!plan.undone.length)
            return refused("That is how it looks now.");
        const saves = Object.entries(plan.themes).flatMap(([id, snapshot]) => (snapshot.file ? [{ id, file: snapshot.file }] : []));
        const skin = plan.look.skin ?? (plan.undone.some((entry) => entry.before.skin !== entry.after.skin) ? "system" : undefined);
        return change(person, { saves, wear: plan.look.id, ...(skin ? { skin } : {}), change: { kind: "undid", count: plan.undone.length } });
    }
    /** The files a theme had at change `seq` that are gone from its folder now. */
    function missingAssets(person, seq) {
        const plan = lookAfter(readHistory(home(person)), seq);
        return Object.entries(plan?.themes ?? {}).flatMap(([id, snapshot]) => snapshot.assets.filter((name) => !asset(person, id, name)));
    }
    function addAsset(person, id, name, bytes) {
        const clean = name.toLowerCase();
        if (!read(person, id))
            return refused(`Save the theme ${id} first, then add files to it.`);
        if (!THEME_ASSET_NAME.test(clean))
            return refused("A theme file name is lowercase letters, digits, - and _, ending in .png, .jpg, .webp, .gif, .avif, .svg, .woff2, .woff, .ttf or .otf.");
        if (bytes.byteLength === 0)
            return refused("The file is empty.");
        if (bytes.byteLength > THEME_LIMITS.assetBytes)
            return refused(`A theme file may be up to ${THEME_LIMITS.assetBytes / 1024 / 1024} MB.`);
        if (!looksLike(clean, bytes))
            return refused(`${clean} is not the kind of file its name says.`);
        const others = assets(person, id).filter((existing) => existing !== clean);
        if (others.length >= THEME_LIMITS.assetsPerTheme)
            return refused(`A theme holds up to ${THEME_LIMITS.assetsPerTheme} files.`);
        const kept = others.reduce((sum, existing) => sum + statSync(join(assetsDir(person, id), existing)).size, 0);
        if (kept + bytes.byteLength > THEME_LIMITS.themeBytes)
            return refused(`A theme's files may total up to ${THEME_LIMITS.themeBytes / 1024 / 1024} MB.`);
        mkdirSync(assetsDir(person, id), { recursive: true });
        writeFileAtomic(join(assetsDir(person, id), clean), bytes);
        return { url: themeAssetUrl(id, clean) };
    }
    /** A theme file to serve, or null; the name is checked before it nears the disk. */
    function asset(person, id, name) {
        if (!validId(id) || !THEME_ASSET_NAME.test(name))
            return null;
        const path = join(assetsDir(person, id), name);
        const type = themeAssetType(name);
        try {
            const stat = statSync(path);
            return stat.isFile() && type ? { path, type, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
        }
        catch {
            return null;
        }
    }
    function freeId(person, wanted) {
        const base = slugFor(wanted);
        let id = base;
        for (let n = 2; existsSync(folder(person, id)) || RESERVED_IDS.has(id); n++)
            id = `${base}-${n}`;
        return id;
    }
    function duplicate(person, id, name) {
        const file = read(person, id);
        if (!file)
            return refused(`No saved theme has the id ${id}.`);
        if (ids(person).length >= THEME_LIMITS.themesPerPerson)
            return refused(`You can keep up to ${THEME_LIMITS.themesPerPerson} themes. Delete one first.`);
        const copy = freeId(person, name);
        if (existsSync(assetsDir(person, id)))
            cpSync(assetsDir(person, id), assetsDir(person, copy), { recursive: true });
        const saved = save(person, copy, { ...file, name, ...(file.css ? { css: rehomeThemeCss(file.css, id, copy) } : {}) });
        return saved ?? { id: copy };
    }
    function remove(person, id) {
        if (!validId(id))
            return;
        if (active(person) === id)
            change(person, { wear: null, keep: [id], change: { kind: "deleted", name: nameOf(person, id) } });
        rmSync(folder(person, id), { recursive: true, force: true });
    }
    function exportTheme(person, id) {
        const theme = read(person, id);
        if (!theme)
            return null;
        const files = Object.fromEntries(assets(person, id).map((name) => [name, `data:${themeAssetType(name)};base64,${readFileSync(join(assetsDir(person, id), name)).toString("base64")}`]));
        return { mausbotTheme: THEME_EXPORT_VERSION, id, theme, ...(Object.keys(files).length ? { assets: files } : {}) };
    }
    /** Saves an exported theme under a new id, with its files stored again and its CSS pointed at them. */
    function importTheme(person, data) {
        const id = freeId(person, data.id ?? data.theme.name);
        const theme = data.id && data.theme.css ? { ...data.theme, css: rehomeThemeCss(data.theme.css, data.id, id) } : data.theme;
        const saved = save(person, id, theme);
        if (saved)
            return saved;
        for (const [name, address] of Object.entries(data.assets ?? {})) {
            const added = addAsset(person, id, name, Buffer.from(address.slice(address.indexOf(",") + 1), "base64"));
            if (isRefusal(added)) {
                remove(person, id);
                return added;
            }
        }
        return { id };
    }
    return {
        read, save, active, setActive, change, history, restore, missingAssets, addAsset, asset, duplicate, remove, exportTheme, importTheme, freeId,
        list(person) {
            const themes = ids(person).flatMap((id) => {
                const file = read(person, id);
                return file ? [{ id, name: file.name, hasCss: Boolean(file.css), assets: assets(person, id) }] : [];
            });
            return { active: active(person), themes };
        },
    };
}
