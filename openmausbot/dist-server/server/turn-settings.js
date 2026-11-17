import { lstatSync, mkdirSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeUserMcpEnabled, mcpCallTimeoutMinutes } from "./config.js";
import { correctiveRounds } from "./host/loop-guard.js";
export function claudeUserSkillsEnabled(cfg) {
    return cfg.features?.claudeUserSkills === true;
}
/** A folder whose `.claude/skills` links to the person's own `~/.claude/skills`, for Claude Code's `--add-dir`: each skill
 * loads as it is on disk, scripts and references included, and edits arrive live. Null when there is nothing to link. */
export function claudeUserSkillsDir(dataDir, home = homedir()) {
    const source = join(home, ".claude", "skills");
    try {
        if (!statSync(source).isDirectory())
            return null;
    }
    catch {
        return null;
    }
    const root = join(dataDir, "claude-user-skills");
    const link = join(root, ".claude", "skills");
    try {
        if (resolve(readlinkSync(link)) === resolve(source))
            return root;
    }
    catch { }
    try {
        mkdirSync(join(root, ".claude"), { recursive: true, mode: 0o700 });
        try {
            if (lstatSync(link).isSymbolicLink())
                unlinkSync(link);
        }
        catch { }
        symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
        return root;
    }
    catch {
        return null;
    }
}
/** The link and its folders, once the switch is off; only the link itself, never what it points to. */
export function forgetClaudeUserSkillsDir(dataDir) {
    const root = join(dataDir, "claude-user-skills");
    const link = join(root, ".claude", "skills");
    try {
        if (lstatSync(link).isSymbolicLink()) {
            try {
                unlinkSync(link);
            }
            catch {
                // A Windows junction is removed as a folder.
                rmdirSync(link);
            }
        }
    }
    catch { }
    for (const folder of [join(root, ".claude"), root]) {
        try {
            rmdirSync(folder);
        }
        catch { }
    }
}
/** The fields of an engine turn that come from Settings. */
export function settingsTurnFields(cfg, dataDir, restrictsMcp, home = homedir()) {
    const userSkillsDir = claudeUserSkillsEnabled(cfg) ? claudeUserSkillsDir(dataDir, home) : null;
    if (!claudeUserSkillsEnabled(cfg))
        forgetClaudeUserSkillsDir(dataDir);
    return {
        mcpFromUserConfig: claudeUserMcpEnabled(cfg) && !restrictsMcp,
        ...(userSkillsDir ? { userSkillsDir } : {}),
        mcpCallTimeoutMs: mcpCallTimeoutMinutes(cfg) * 60_000,
        toolErrorCorrectiveRounds: correctiveRounds(cfg),
    };
}
