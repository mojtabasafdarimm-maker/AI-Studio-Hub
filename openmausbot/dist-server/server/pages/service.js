import { join } from "node:path";
import { createPagesInternalRoutes, createPublishedPageRoutes } from "../routes/published-pages.js";
import { applyIncludedPagesMessage, pagesAccess, pagesNotOffered } from "./access.js";
import { createPagesClient } from "./client.js";
import { createPagePublisher } from "./publisher.js";
import { PublishedPagesStore } from "./store.js";
/** How often live published pages' folders are checked for changes. */
const LIVE_EVERY_MS = 15_000;
/** Pages bots publish to a link: the bot tools' internal routes, the card's Unpublish, the desktop's sign-in message, and
 * the chat's page cards, which show a published page and its link. */
export function createPublishedPages(options) {
    const store = new PublishedPagesStore(join(options.dataDir, "published-pages.json"));
    const client = createPagesClient({ access: () => pagesAccess(options.cloudHome), notOffered: () => pagesNotOffered(options.cloudHome),
        selfHosted: options.selfHosted === true,
        ...(options.fetch ? { fetch: options.fetch } : {}) });
    const apps = options.apps;
    const pageRow = (threadId, messageId) => apps?.store.messagesFor(threadId).find((message) => message.id === messageId && message.kind === "app");
    // A page card keeps its own text, the page's: only the card's link changes.
    const patch = (threadId, messageId, text, card) => {
        if (pageRow(threadId, messageId))
            apps.store.patchMessage(threadId, messageId, { publishedPage: card });
        else
            options.patch(threadId, messageId, text, card);
    };
    const publisher = createPagePublisher({ client, store, patch, liveRoots: options.liveRoots, paused: options.paused });
    // Live pages whose folders changed are published again; each at most once a minute (the publisher's own limit).
    const liveTimer = setInterval(() => { void publisher.refreshLive(); }, LIVE_EVERY_MS);
    liveTimer.unref?.();
    const appPages = apps ? {
        botOf: (threadId) => (apps.store.groupByThread(threadId) ? null : apps.store.botByThread(threadId) ?? null),
        page: (threadId, messageId, rev) => apps.chat.publishablePage(threadId, messageId, rev),
        published: (threadId, messageId) => {
            const card = pageRow(threadId, messageId)?.publishedPage;
            return card?.state === "live" && card.pageId ? card.pageId : null;
        },
        show: (threadId, messageId, publishedPage) => (pageRow(threadId, messageId) && apps.store.patchMessage(threadId, messageId, { publishedPage }) ? messageId : null),
    } : undefined;
    return {
        store, publisher, internal: createPagesInternalRoutes(publisher), routes: createPublishedPageRoutes(publisher, appPages), receive: applyIncludedPagesMessage,
        /** publish_page's card as the page itself, inline; null when it can't be shown so (the caller posts the link). */
        show: (args) => apps?.chat.showPublishedPage(args) ?? null,
    };
}
