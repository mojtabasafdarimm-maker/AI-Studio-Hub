import { createHash } from "node:crypto";
export function profileSnapshot(bot) {
    return {
        name: bot.name,
        title: bot.title,
        description: bot.description,
        soul: bot.soul ?? "",
        cwd: bot.cwd ?? "",
        notifications: bot.notifications ?? true,
        speakReplies: bot.speakReplies ?? false,
    };
}
export function profileRevision(bot) {
    // The private receipt stops an older, interrupted card from applying restored identical text twice.
    return createHash("sha256")
        .update(JSON.stringify({ ...profileSnapshot(bot), lastProfileRequestId: bot.lastProfileRequestId ?? "" }), "utf8")
        .digest("hex");
}
