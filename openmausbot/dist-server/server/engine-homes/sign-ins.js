// The team's engine sign-ins in an audience's home. Each audience keeps a copy where its engine looks; inside a bot box the
// team's file itself is bound over that copy, so a refreshed token lands in the team's file. Outside a box the engine
// writes its copy, and the next spawn in any audience takes the newest settled copy back into the team's file.
import { closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
/** A copy written this recently may be half-written by its engine. */
export const SETTLED_MS = 2_000;
const stat = (path, follow) => {
    try {
        return follow ? statSync(path) : lstatSync(path);
    }
    catch {
        return null;
    }
};
const whole = (path, bytes) => {
    if (!path.endsWith(".json"))
        return bytes.length > 0;
    try {
        JSON.parse(bytes.toString("utf8"));
        return true;
    }
    catch {
        return false;
    }
};
function copyInto(target, bytes, from) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.omb`);
    writeFileSync(temporary, bytes, { mode: 0o600 });
    utimesSync(temporary, from.atime, from.mtime);
    renameSync(temporary, target);
}
/** In place, so a box that has the team's file bound keeps seeing it. */
function writeInPlace(source, bytes, from) {
    const fd = openSync(source, "r+");
    try {
        if (!fstatSync(fd).isFile())
            return;
        writeFileSync(fd, bytes);
        ftruncateSync(fd, bytes.length);
    }
    finally {
        closeSync(fd);
    }
    utimesSync(source, from.atime, from.mtime);
}
/** A copy an engine wrote outside a box after the team's file changed, once it has settled and reads whole. */
function newerCopy(path, team, now) {
    const copy = stat(path, false);
    if (!copy?.isFile() || Math.floor(copy.mtimeMs) <= Math.floor(team.mtimeMs) || now - copy.mtimeMs < SETTLED_MS)
        return null;
    const bytes = readFileSync(path);
    return whole(path, bytes) ? { bytes, stats: copy } : null;
}
/** `peers` are the same file in the other audiences' homes: the newest refresh any of them made becomes the team's. */
export function syncSignIn(file, peers = [], now = Date.now()) {
    let team = stat(file.source, true);
    let copy = stat(file.target, false);
    if (copy && !copy.isFile()) {
        rmSync(file.target, { recursive: true, force: true });
        copy = null;
    }
    if (!team?.isFile()) {
        if (!copy)
            return "same";
        rmSync(file.target, { force: true });
        return "removed";
    }
    let taken = "same";
    const newest = [file.target, ...peers].map((path) => newerCopy(path, team, now)).filter((found) => found !== null)
        .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)[0];
    if (newest) {
        writeInPlace(file.source, newest.bytes, newest.stats);
        team = stat(file.source, true);
        taken = "taken back";
    }
    const at = (stats) => Math.floor(stats.mtimeMs);
    if (copy && at(copy) > at(team) && now - copy.mtimeMs < SETTLED_MS)
        return taken;
    const bytes = readFileSync(file.source);
    if (copy && at(copy) === at(team) && copy.size === team.size && readFileSync(file.target).equals(bytes))
        return taken;
    copyInto(file.target, bytes, team);
    return taken === "same" ? "copied" : taken;
}
export function syncSignIns(files, peers = () => [], now = Date.now()) {
    for (const file of files) {
        try {
            syncSignIn(file, peers(file.target), now);
        }
        catch { }
    }
}
