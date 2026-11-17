import { ROUTINE_RUN_LIMIT_MAX_MINUTES, ROUTINE_RUN_LIMIT_MIN_MINUTES } from "../shared/routines.js";
import { z } from "zod";
const MAX_ATTACHMENTS = 50;
const attachmentSchema = z.object({
    id: z.string().trim().min(1).max(200),
    kind: z.enum(["file", "image"]),
    name: z.string().trim().min(1).max(255),
    path: z.string().trim().min(1).max(4_096),
    size: z.number().finite().nonnegative(),
});
export function cleanAttachments(value) {
    if (value == null)
        return [];
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
        throw new Error(`Add no more than ${MAX_ATTACHMENTS} attachments`);
    }
    const ids = new Set();
    return value.map((candidate) => {
        const parsed = attachmentSchema.safeParse(candidate);
        if (!parsed.success || parsed.data.name.includes("\0") || parsed.data.path.includes("\0")) {
            throw new Error("Choose a valid attachment");
        }
        if (ids.has(parsed.data.id))
            throw new Error("Each attachment must be unique");
        ids.add(parsed.data.id);
        return { ...parsed.data };
    });
}
/** The file paths the owners' attachments name; null when any saved list is malformed, so a clear that relies on it refuses. */
export function attachmentPathsOf(owners) {
    const paths = [];
    for (const { attachments } of owners) {
        if (attachments === undefined)
            continue;
        if (!Array.isArray(attachments))
            return null;
        for (const file of attachments) {
            const path = file && typeof file === "object" ? file.path : undefined;
            if (typeof path !== "string")
                return null;
            paths.push(path);
        }
    }
    return paths;
}
/** True when any saved list would not load as it is: loading drops such a list, so its files are no longer named. */
export function attachmentsMalformed(owners) {
    return owners.some(({ attachments }) => {
        try {
            cleanAttachments(attachments);
            return false;
        }
        catch {
            return true;
        }
    });
}
export function cleanTimeoutMinutes(value) {
    if (value == null)
        return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < ROUTINE_RUN_LIMIT_MIN_MINUTES || value > ROUTINE_RUN_LIMIT_MAX_MINUTES) {
        throw new Error(`Run limit must be a whole number from ${ROUTINE_RUN_LIMIT_MIN_MINUTES} to ${ROUTINE_RUN_LIMIT_MAX_MINUTES} minutes`);
    }
    return value;
}
export function loadTimeoutMinutes(value) {
    try {
        return cleanTimeoutMinutes(value);
    }
    catch {
        return undefined;
    }
}
export function loadAttachments(value) {
    try {
        return cleanAttachments(value);
    }
    catch {
        return [];
    }
}
export function cloneAttachments(attachments) {
    return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}
