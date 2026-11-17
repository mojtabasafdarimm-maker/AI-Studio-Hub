// Who is here on a Team Cloud (docs/team-cloud.md "Who is here"): the wire between the server and the app. A person is
// named by their address, as in GET /api/team/people. Nothing here ever names a private chat: a conversation only one
// person can read is never reported, and its person only counts as here.
/** POST {tab, threadId}: this app window is open, with that conversation in front of the person (null: none, or one that
 * is theirs alone). `tab` is the window's own id, made when it loads. Sent when the conversation changes and every
 * HERE_REPEAT_MS while the window shows. */
export const PRESENCE_HERE_PATH = "/api/presence/here";
/** How often a showing window repeats its POST; a window not heard from for a few of these no longer counts. */
export const HERE_REPEAT_MS = 60_000;
