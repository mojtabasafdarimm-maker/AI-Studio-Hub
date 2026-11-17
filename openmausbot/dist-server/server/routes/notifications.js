import { userError } from "../user-errors.js";
import { markNotificationLogRead, recentNotificationLog } from "../message-db.js";
import { ownerOrAdmin } from "../request-auth.js";
import { PASS } from "./table.js";
/** Opening a conversation reads the notifications its opener's list shows, so every open app of theirs drops them too:
 * on a Team Cloud only the opener's. */
export function readThreadNotifications(threadId, broadcast, listed) {
    const { reader } = listed;
    const ids = recentNotificationLog(undefined, reader).filter((entry) => entry.threadId === threadId && !entry.read && listed(entry)).map((entry) => entry.id);
    if (!ids.length)
        return;
    const payload = { kind: "notifications.read", threadId, ids };
    if (reader === undefined) {
        markNotificationLogRead(ids);
        broadcast(payload);
    }
    else {
        markNotificationLogRead(ids, reader);
        broadcast(payload, { person: reader });
    }
}
/** Whether a notification is in a request's own list. `shown`: on a Team Cloud another person's private chat's
 * notifications are theirs alone, an admin's list included. `reaches`: an ask only its person. `reader`: on a Team Cloud
 * the person signed in, whose read marks are their own. */
export function notificationListedFor(shown = () => () => true, reaches = () => true, reader = () => null) {
    return (auth) => {
        const seen = shown(auth);
        const admin = ownerOrAdmin(auth);
        const person = reader(auth);
        const listed = (entry) => (entry.kind !== "spend" || admin) && (!entry.threadId || seen(entry.threadId)) && reaches(auth, entry);
        return person === null ? listed : Object.assign(listed, { reader: person });
    };
}
export function createNotificationRoutes(deps = {
    recent: (reader) => recentNotificationLog(undefined, reader),
    markRead: markNotificationLogRead,
}, listed = notificationListedFor()) {
    const visible = (listing) => deps.recent(listing.reader).filter(listing);
    const markRead = (ids, reader) => (reader === undefined ? deps.markRead(ids) : deps.markRead(ids, reader));
    return async ({ res, path, method, auth, json }) => {
        if (method === "GET" && path === "/api/notifications") {
            return json(res, 200, { notifications: visible(listed(auth)) });
        }
        if (method !== "POST")
            return PASS;
        const listing = listed(auth);
        if (path === "/api/notifications/read-all") {
            const unread = visible(listing).filter((entry) => !entry.read).map((entry) => entry.id);
            if (unread.length)
                markRead(unread, listing.reader);
            return json(res, 200, { ok: true });
        }
        const m = path.match(/^\/api\/notifications\/([\w-]+)\/read$/);
        if (!m)
            return PASS;
        if (!visible(listing).some((entry) => entry.id === m[1]))
            return json(res, 404, userError("serverError.notification.missing"));
        markRead([m[1]], listing.reader);
        return json(res, 200, { ok: true });
    };
}
