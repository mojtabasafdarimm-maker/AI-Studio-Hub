import { bodyThreadIds, requestThreadIds } from "../bot-visibility.js";
import { onParsedBody } from "../harness/http.js";
import { cloudSyncRoutes } from "../routes/cloud-sync.js";
export const NO_SUCH_CONVERSATION = "no such conversation";
/** The routes that act on the bot's selected conversation when the body names none (bot-messages.ts, bot-settings.ts). */
const SELECTED_THREAD_ROUTE = /^\/api\/bots\/([\w-]+)\/(?:messages(?:\/guarded)?|messages\/[\w-]+\/edit|queue\/[\w-]+(?:\/steer)?|compact|active-branch|respond|always-allow|interrupt|read)$/;
/** "no such conversation" when the request names someone else's private chat in its path or query. Its JSON body is
 * checked as a route reads it: one that names such a chat, or leaves out the conversation on a route that then acts on a
 * selected conversation that is someone else's, fails the read with 404. Nothing at all off a Team Cloud. */
export function hiddenThreadRefusal(req, path, query, visible, selectedThread) {
    if (!visible.filtersThreads)
        return null;
    if (requestThreadIds(path, query).some((id) => visible.hides(id)))
        return NO_SUCH_CONVERSATION;
    const selectedRoute = SELECTED_THREAD_ROUTE.exec(path);
    onParsedBody(req, (body) => {
        if (bodyThreadIds(body).some((id) => visible.hides(id)))
            return { status: 404, error: NO_SUCH_CONVERSATION };
        const named = body && typeof body === "object" && !Array.isArray(body) && body.threadId !== undefined;
        const selected = selectedRoute && !named ? selectedThread(selectedRoute[1]) : undefined;
        return selected && visible.hides(selected) ? { status: 404, error: NO_SUCH_CONVERSATION } : null;
    });
    return null;
}
/** A bot's synced folder is one conversation's (`bot-<bot>-<thread>`, cloud-sync.ts): someone else's private chat's
 * folder is not listed, and answers as one that does not exist. */
export function hideOthersSyncFolders(bots, threadShown) {
    cloudSyncRoutes.showFolders((auth) => {
        const shown = threadShown(auth);
        return (folderId) => !folderId.startsWith("bot-") || bots().every((bot) => !folderId.startsWith(`bot-${bot.id}-`) || shown(folderId.slice(`bot-${bot.id}-`.length)));
    });
}
