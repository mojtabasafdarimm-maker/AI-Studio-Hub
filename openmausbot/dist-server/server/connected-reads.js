// Reads Google Calendar events, Gmail headers and, for a one-time code, a single Gmail or Outlook message from the server
// through the connected-apps relay, with no AI turn, as the default connected account of each app, or the one the host
// names when an app has several. Tool names, arguments and answer shapes follow Composio's documentation; the fixtures are
// not yet checked against the live service, so an answer of any other shape is an error, never an empty list.
import { findMeetingLink } from "../shared/meetings.js";
import { parseMcpResponse } from "./connector-tools-list.js";
export const READ_APPS = ["gmail", "googlecalendar"];
const SIGNED_OUT = /\b(?:unauthori[sz]ed|unauthenticated|invalid[_ ]grant|expired|re-?connect|not connected|no connected account|not active|initiated|initializing|permission denied|forbidden|401|403)\b/i;
/** A read that failed: the app, what went wrong, and whether reconnecting the app is what fixes it. */
export class SourceError extends Error {
    app;
    signedOut;
    /** The read named one of the app's several connected accounts, so that account is the one to check. */
    severalAccounts;
    constructor(app, message, severalAccounts = false) {
        super(message);
        this.app = app;
        this.signedOut = SIGNED_OUT.test(message);
        this.severalAccounts = severalAccounts;
        this.name = "SourceError";
    }
}
export const CALENDAR_LIST_TOOL = "GOOGLECALENDAR_EVENTS_LIST";
export const CALENDARS_TOOL = "GOOGLECALENDAR_LIST_CALENDARS";
export const GMAIL_FETCH_TOOL = "GMAIL_FETCH_EMAILS";
export const GMAIL_PROFILE_TOOL = "GMAIL_GET_PROFILE";
export const GMAIL_MESSAGE_TOOL = "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID";
export const GMAIL_THREAD_TOOL = "GMAIL_FETCH_MESSAGE_BY_THREAD_ID";
export const OUTLOOK_LIST_TOOL = "OUTLOOK_LIST_MESSAGES";
export const OUTLOOK_MESSAGE_TOOL = "OUTLOOK_GET_MESSAGE";
const CALENDAR_READS_AT_ONCE = 4;
const CALENDAR_PAGES = 20;
const CALENDAR_NAME_MAX = 80;
const GOOGLE_NOT_FOUND = /\brequested entity was not found\b/i;
const MESSAGE_WORD = /\b(?:message|email|thread)\b/i;
const MISSING_WORD = /\b(?:not found|deleted|no longer exists)\b/i;
const OTHER_SUBJECT = /\b(?:account|connect|o?auth|token|permission|scope|credential|tool|integration)/i;
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CALL_ID = "omb-check-call";
const PREVIEW_MAX = 300;
const ADDRESS = /^[\w.+][\w.+-]*@[\w-]+(?:\.[\w-]+)+$/;
const PRIMARY_CALENDAR = { id: "primary", name: "primary", primary: true, owned: true, read: true };
const GONE = Symbol("gone");
const SHORTENED = Symbol("shortened");
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const flat = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const seconds = (ms) => Math.floor(ms / 1000);
const errorText = (error) => (error instanceof Error ? error.message : String(error));
export const isAddress = (value) => ADDRESS.test(value);
/** The tool itself answered that it failed, as opposed to the relay or Composio failing around it. */
class ToolAnswerError extends Error {
}
/** The connected-apps service sends an answer past its size limit as a short preview with no data: the read must ask for less. */
class ShortenedAnswerError extends Error {
}
/** Whether a Gmail tool's own error says the message asked for is missing, while naming no account, connection, token,
 * permission or tool. */
export function messageGone(toolError) {
    if (OTHER_SUBJECT.test(toolError))
        return false;
    return GOOGLE_NOT_FOUND.test(toolError) || (MESSAGE_WORD.test(toolError) && MISSING_WORD.test(toolError));
}
async function inParallel(items, limit, run) {
    const results = [];
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
/** One tool's `data` from a tools/call answer, multi-execute or direct. Anything else throws. */
export function toolData(slug, frame) {
    if (!frame)
        throw new Error(`${slug}: no answer`);
    const rpcError = record(frame.error)?.message;
    if (typeof rpcError === "string")
        throw new Error(rpcError.slice(0, 300));
    const result = record(frame.result);
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map(record).find((part) => typeof part?.text === "string")?.text;
    if (result?.isError === true)
        throw new Error(text?.slice(0, 300) || `${slug} failed`);
    if (text === undefined)
        throw new Error(`${slug}: the answer had no text`);
    let body;
    try {
        body = record(JSON.parse(text));
    }
    catch {
        throw new Error(`${slug}: the answer was not JSON`);
    }
    if (!body)
        throw new Error(`${slug}: the answer was not an object`);
    if (body.successful === false)
        throw new Error(String(body.error ?? `${slug} failed`).slice(0, 300));
    const results = record(body.data)?.results;
    if (Array.isArray(results)) {
        const response = record(results.map(record).find((item) => item?.tool_slug === slug)?.response);
        if (!response)
            throw new Error(`${slug}: missing from the answer`);
        if (response.successful === false)
            throw new ToolAnswerError(String(response.error ?? `${slug} failed`).slice(0, 300));
        if (!("data" in response)) {
            if ("data_preview" in response)
                throw new ShortenedAnswerError(`${slug}: the answer was too large and came back shortened; ask for fewer`);
            throw new Error(`${slug}: the answer had no data`);
        }
        return response.data;
    }
    if (!("data" in body))
        throw new Error(`${slug}: the answer had no data`);
    return body.data;
}
function listIn(data, keys) {
    if (Array.isArray(data))
        return data;
    for (const body of [record(data), record(record(data)?.response_data)]) {
        for (const key of keys)
            if (Array.isArray(body?.[key]))
                return body[key];
    }
    return null;
}
function headerValue(item, name) {
    const headers = record(item.payload)?.headers;
    const value = (Array.isArray(headers) ? headers : []).map(record).find((header) => typeof header?.name === "string" && header.name.toLowerCase() === name)?.value;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function sentAt(item) {
    const at = typeof item.messageTimestamp === "string" ? Date.parse(item.messageTimestamp)
        : typeof item.internalDate === "string" || typeof item.internalDate === "number" ? Number(item.internalDate) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
}
function senderOf(item) {
    return flat(item.sender ?? item.from ?? headerValue(item, "from"));
}
function oneLine(value, max) {
    return Array.from(flat(typeof value === "string" ? value.replace(/[^\P{C}\s]/gu, "") : "")).slice(0, max).join("").trim();
}
function addressIn(sender) {
    const candidate = (/<([^<>\s]+)>/.exec(sender)?.[1] ?? sender).trim().toLowerCase();
    return ADDRESS.test(candidate) ? candidate : "";
}
function calendarEvent(raw, calendar) {
    const item = record(raw);
    if (!item || typeof item.id !== "string" || !item.id)
        return null;
    const start = record(item.start);
    const end = record(item.end);
    const allDay = typeof start?.date === "string" && typeof start?.dateTime !== "string";
    const startMs = Date.parse(String(start?.dateTime ?? start?.date ?? ""));
    if (!Number.isFinite(startMs))
        return null;
    const endMs = Date.parse(String(end?.dateTime ?? end?.date ?? ""));
    const attendees = (Array.isArray(item.attendees) ? item.attendees : []).flatMap((rawAttendee) => {
        const attendee = record(rawAttendee);
        if (!attendee || typeof attendee.email !== "string" || attendee.resource === true)
            return [];
        return [{
                email: attendee.email.trim().toLowerCase(),
                ...(typeof attendee.displayName === "string" && attendee.displayName.trim() ? { name: flat(attendee.displayName) } : {}),
                self: attendee.self === true,
                organizer: attendee.organizer === true,
                ...(typeof attendee.responseStatus === "string" ? { response: attendee.responseStatus } : {}),
            }];
    });
    const video = (Array.isArray(record(item.conferenceData)?.entryPoints) ? record(item.conferenceData).entryPoints : [])
        .map(record).find((entry) => entry?.entryPointType === "video" && typeof entry.uri === "string")?.uri;
    const location = typeof item.location === "string" && item.location.trim() ? item.location.trim() : undefined;
    const original = record(item.originalStartTime);
    const originalStart = Date.parse(String(original?.dateTime ?? original?.date ?? ""));
    const organizer = record(item.organizer)?.email;
    const joinUrl = [item.hangoutLink, video, location].find((value) => typeof value === "string" && /^https:\/\/\S+$/i.test(value.trim()))
        ?? findMeetingLink(typeof item.description === "string" ? item.description : undefined) ?? undefined;
    return {
        id: item.id,
        title: flat(item.summary) || "Untitled meeting",
        start: startMs,
        end: Number.isFinite(endMs) ? endMs : startMs,
        allDay,
        ...(item.transparency === "transparent" ? { transparent: true } : {}),
        status: item.status === "cancelled" || item.status === "tentative" ? item.status : "confirmed",
        selfDeclined: attendees.some((attendee) => attendee.self && attendee.response === "declined"),
        attendees,
        ...(typeof item.recurringEventId === "string" ? { seriesId: item.recurringEventId } : {}),
        ...(joinUrl ? { joinUrl: joinUrl.trim() } : {}),
        ...(location ? { location } : {}),
        ...(typeof item.description === "string" && item.description.trim() ? { description: item.description } : {}),
        calendarId: calendar.id,
        ownedCalendar: calendar.owned,
        ...(typeof item.iCalUID === "string" && item.iCalUID ? { iCalUID: item.iCalUID } : {}),
        ...(Number.isFinite(originalStart) ? { originalStart } : {}),
        ...(typeof organizer === "string" && organizer.trim() ? { organizer: organizer.trim().toLowerCase() } : {}),
    };
}
export function eventsFromData(data, calendar) {
    const list = listIn(data, ["items", "events"]);
    if (!list)
        throw new Error("the calendar answer had no event list");
    let cancelledDropped = 0;
    const events = list.flatMap((raw) => {
        const event = calendarEvent(raw, calendar);
        if (!event && record(raw)?.status === "cancelled")
            cancelledDropped += 1;
        return event ? [event] : [];
    });
    if (list.length > cancelledDropped && events.length === 0)
        throw new Error("none of the calendar events could be read");
    return events;
}
function messageId(item) {
    const id = item?.messageId ?? item?.id;
    return typeof id === "string" && id ? id : undefined;
}
function emailHeader(raw) {
    const item = record(raw);
    const id = messageId(item);
    if (!item || !id)
        return null;
    const preview = record(item.preview);
    return {
        id,
        threadId: typeof item.threadId === "string" && item.threadId ? item.threadId : id,
        at: sentAt(item),
        from: senderOf(item),
        subject: flat(item.subject ?? preview?.subject ?? headerValue(item, "subject")),
        preview: flat(preview?.body ?? item.snippet ?? item.messageText).slice(0, PREVIEW_MAX),
    };
}
export function emailsFromData(data) {
    const list = listIn(data, ["messages"]);
    if (!list)
        throw new Error("the Gmail answer had no message list");
    const headers = list.flatMap((raw) => emailHeader(raw) ?? []);
    if (list.length > 0 && headers.length === 0)
        throw new Error("none of the Gmail messages could be read");
    return headers;
}
/** Gmail or Calendar's page token for more results, or undefined on the last page. */
export function nextPageOf(data) {
    const token = [record(data), record(record(data)?.response_data)].flatMap((body) => [body?.nextPageToken, body?.next_page_token]).find((value) => typeof value === "string" && value);
    return typeof token === "string" ? token : undefined;
}
export function messageFromData(data) {
    const top = record(data);
    const header = emailHeader(record(top?.message) ?? record(top?.response_data) ?? top);
    if (!header)
        throw new Error("the Gmail message could not be read");
    return header;
}
/** The text of a Gmail payload's parts, plain text before HTML. Gmail encodes each part's data as base64url. */
function gmailPartText(part, mime) {
    if (!part)
        return "";
    if (part.mimeType === mime && typeof part.body?.data === "string")
        return Buffer.from(part.body.data, "base64url").toString("utf8");
    return (Array.isArray(part.parts) ? part.parts : []).map((child) => gmailPartText(child, mime)).filter(Boolean).join("\n");
}
/** A Gmail message's body text; a message with none to read is an error. */
export function gmailBodyFromData(data) {
    const top = record(data);
    const item = record(top?.message) ?? record(top?.response_data) ?? top;
    const payload = record(item?.payload);
    const text = gmailPartText(payload, "text/plain") || gmailPartText(payload, "text/html") || (typeof item?.messageText === "string" ? item.messageText : "");
    if (!text.trim())
        throw new Error("the Gmail message had no text to read");
    return text;
}
function outlookSender(item) {
    const address = record(record(item.from)?.emailAddress)?.address;
    return typeof address === "string" ? address.trim() : "";
}
function outlookReceivedAt(item) {
    const at = typeof item.receivedDateTime === "string" ? Date.parse(item.receivedDateTime) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
}
export function outlookMessagesFromData(data) {
    const list = listIn(data, ["value", "messages"]);
    if (!list)
        throw new Error("the Outlook answer had no message list");
    const headers = list.flatMap((raw) => {
        const item = record(raw);
        if (!item || typeof item.id !== "string" || !item.id)
            return [];
        return [{ id: item.id, threadId: item.id, at: outlookReceivedAt(item), from: outlookSender(item), subject: flat(item.subject), preview: "" }];
    });
    if (list.length > 0 && headers.length === 0)
        throw new Error("none of the Outlook messages could be read");
    return headers;
}
/** An Outlook message's body text; a message with none to read is an error. */
export function outlookBodyFromData(data) {
    const top = record(data);
    const content = record((record(top?.message) ?? record(top?.response_data) ?? top)?.body)?.content;
    if (typeof content !== "string" || !content.trim())
        throw new Error("the Outlook message had no text to read");
    return content;
}
export function threadFromData(data) {
    const list = listIn(data, ["messages"]);
    if (!list)
        throw new Error("the Gmail thread had no message list");
    const messages = list.flatMap((raw) => {
        const item = record(raw);
        const id = messageId(item);
        return item && id ? [{ id, at: sentAt(item), from: addressIn(senderOf(item)) }] : [];
    });
    if (list.length > 0 && messages.length === 0)
        throw new Error("none of the thread's messages could be read");
    return messages;
}
export function profileFromData(data) {
    const address = [record(data), record(record(data)?.response_data)].map((body) => body?.emailAddress).find((value) => typeof value === "string");
    const normalised = typeof address === "string" ? address.trim().toLowerCase() : "";
    if (!ADDRESS.test(normalised))
        throw new Error("the Gmail profile had no address");
    return normalised;
}
// Google Calendar's access role for a calendar shared as free/busy only: its events carry no details to read.
const FREE_BUSY_ONLY = "freeBusyReader";
export function calendarsFromData(data) {
    const list = listIn(data, ["items", "calendars"]);
    if (!list)
        throw new Error("the answer had no calendar list");
    const calendars = list.flatMap((raw) => {
        const item = record(raw);
        if (!item || typeof item.id !== "string" || !item.id)
            return [];
        const primary = item.primary === true;
        return [{
                id: item.id, name: oneLine(item.summary, CALENDAR_NAME_MAX) || item.id, primary,
                owned: primary || item.accessRole === "owner", read: primary || (item.selected === true && item.hidden !== true && item.accessRole !== FREE_BUSY_ONLY),
            }];
    });
    if (list.length > 0 && calendars.length === 0)
        throw new Error("none of the calendars could be read");
    return calendars;
}
export const READ_TIMEOUT_MS = 60_000;
/** `promise`, or a rejection with the signal's reason once `signal` aborts first (after `onAbort`). */
function untilAborted(promise, signal, onAbort) {
    return new Promise((resolve, reject) => {
        const abort = () => {
            onAbort();
            reject(signal.reason);
        };
        if (signal.aborted)
            return abort();
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
// A 50-email page is past the connected-apps service's size limit and comes back shortened; 20 fits, and a page that
// still comes back shortened is asked again at half the size, down to 5.
const GMAIL_PAGE = 20;
const GMAIL_PAGE_MIN = 5;
const GMAIL_PAGES = 6;
const appOf = (slug) => (slug.startsWith("GMAIL_") ? "gmail" : slug.startsWith("OUTLOOK_") ? "outlook" : "googlecalendar");
export function createConnectedReads(deps) {
    const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
    function session() {
        let opened;
        let accounts;
        async function open(signal) {
            const init = await deps.relay({
                jsonrpc: "2.0", id: "omb-check-init", method: "initialize",
                params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-checks", version: "1" } },
            }, undefined, signal);
            if (init.status !== 200)
                throw new Error(`connected apps answered HTTP ${init.status}`);
            // Streamable-HTTP MCP servers expect the initialized notification before the first request.
            await deps.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, init.transportSessionId, signal).catch(() => undefined);
            return init.transportSessionId;
        }
        /** One tool's data, GONE when `gone` says the tool's own failure means the thing asked for is missing, or SHORTENED
         *  when `shortened` is set and the answer was too large to come back whole. */
        async function call(slug, args, options = {}) {
            const { gone, shortened, signal = AbortSignal.timeout(readTimeoutMs) } = options;
            const app = appOf(slug);
            let account;
            try {
                signal.throwIfAborted();
                opened ??= open(signal).catch((error) => {
                    opened = undefined;
                    throw error;
                });
                const transport = await opened;
                // A failed lookup reads as no account named and is asked again on the next read, not kept for the session.
                accounts ??= deps.accounts?.().catch(() => {
                    accounts = undefined;
                    return {};
                }) ?? Promise.resolve({});
                // The lookup counts toward this read's time limit; one that runs out is dropped so the next read asks again.
                const lookup = accounts;
                account = (await untilAborted(lookup, signal, () => {
                    if (accounts === lookup)
                        accounts = undefined;
                }))[app];
                const answer = await deps.relay({
                    jsonrpc: "2.0", id: CALL_ID, method: "tools/call",
                    params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: slug, arguments: args, ...(account ? { account } : {}) }] } },
                }, transport, signal);
                if (answer.status !== 200)
                    throw new Error(`${slug} answered HTTP ${answer.status}`);
                return toolData(slug, parseMcpResponse(new TextDecoder().decode(answer.bytes), CALL_ID));
            }
            catch (error) {
                if (error instanceof SourceError)
                    throw error;
                if (gone && error instanceof ToolAnswerError && gone(error.message))
                    return GONE;
                if (shortened && error instanceof ShortenedAnswerError)
                    return SHORTENED;
                if (signal.aborted)
                    throw new SourceError(app, `${slug} did not answer within ${Math.round(readTimeoutMs / 1000)} seconds`);
                // Only the tool's own refusal points at the named account; a relay hiccup (HTTP 5xx) is a later try.
                throw new SourceError(app, errorText(error), account !== undefined && error instanceof ToolAnswerError);
            }
        }
        function parsed(app, parse) {
            try {
                return parse();
            }
            catch (error) {
                throw new SourceError(app, errorText(error));
            }
        }
        function requireFinite(app, ...times) {
            if (times.some((time) => !Number.isFinite(time)))
                throw new SourceError(app, "the time window was not a finite time");
        }
        async function calendarPages(slug, args, parse, signal) {
            const results = [];
            const seen = new Set();
            let page;
            for (let index = 0; index < CALENDAR_PAGES; index++) {
                const pageArgs = page ? { ...args, [slug === CALENDARS_TOOL ? "page_token" : "pageToken"]: page } : args;
                const data = await call(slug, pageArgs, { signal });
                results.push(...parsed("googlecalendar", () => parse(data)));
                page = nextPageOf(data);
                if (!page)
                    return results;
                if (seen.has(page))
                    throw new SourceError("googlecalendar", `${slug}: repeated page token`);
                seen.add(page);
            }
            throw new SourceError("googlecalendar", `${slug}: too many pages to read completely`);
        }
        return {
            async events(fromMs, toMs) {
                requireFinite("googlecalendar", fromMs, toMs);
                const failed = new AbortController();
                const signal = AbortSignal.any([AbortSignal.timeout(readTimeoutMs), failed.signal]);
                const listed = await calendarPages(CALENDARS_TOOL, {}, calendarsFromData, signal);
                const read = [...(listed.some((calendar) => calendar.primary) ? [] : [PRIMARY_CALENDAR]), ...listed.filter((calendar) => calendar.read)];
                const perCalendar = await inParallel(read, CALENDAR_READS_AT_ONCE, async (calendar) => {
                    try {
                        return await calendarPages(CALENDAR_LIST_TOOL, {
                            calendarId: calendar.id, timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
                            singleEvents: true, orderBy: "startTime", maxResults: 100, showDeleted: true,
                        }, (data) => eventsFromData(data, { id: calendar.id, owned: calendar.owned }), signal);
                    }
                    catch (error) {
                        failed.abort();
                        throw new SourceError("googlecalendar", `calendar ${calendar.name}: ${errorText(error)}`, error instanceof SourceError && error.severalAccounts);
                    }
                });
                return perCalendar.flat();
            },
            async emails(sinceMs, limit) {
                requireFinite("gmail", sinceMs);
                const found = [];
                let page;
                let size = GMAIL_PAGE;
                // Only whole pages count toward GMAIL_PAGES; a shortened answer is asked again smaller, at most twice per read.
                for (let pages = 0; pages < GMAIL_PAGES;) {
                    const data = await call(GMAIL_FETCH_TOOL, {
                        user_id: "me", query: `in:inbox after:${seconds(sinceMs)} -category:promotions -category:social`,
                        max_results: size, include_payload: false, verbose: false, ...(page ? { page_token: page } : {}),
                    }, { shortened: size > GMAIL_PAGE_MIN });
                    if (data === SHORTENED) {
                        size = Math.max(GMAIL_PAGE_MIN, Math.floor(size / 2));
                        continue;
                    }
                    pages++;
                    found.push(...parsed("gmail", () => emailsFromData(data)));
                    page = nextPageOf(data);
                    if (!page)
                        break;
                }
                const newest = [...new Map(found.map((email) => [email.id, email])).values()].sort((a, b) => b.at - a.at);
                return { emails: newest.slice(0, limit), more: newest.length > limit || page !== undefined };
            },
            async message(id) {
                const data = await call(GMAIL_MESSAGE_TOOL, { user_id: "me", message_id: id, format: "metadata" }, { gone: messageGone });
                return data === GONE ? null : parsed("gmail", () => messageFromData(data));
            },
            async messageBody(id) {
                const data = await call(GMAIL_MESSAGE_TOOL, { user_id: "me", message_id: id, format: "full" }, { gone: messageGone });
                return data === GONE ? null : parsed("gmail", () => gmailBodyFromData(data));
            },
            async thread(threadId) {
                const data = await call(GMAIL_THREAD_TOOL, { user_id: "me", thread_id: threadId });
                return parsed("gmail", () => threadFromData(data));
            },
            async address() {
                const data = await call(GMAIL_PROFILE_TOOL, { user_id: "me" });
                return parsed("gmail", () => profileFromData(data));
            },
            async outlookEmails(sinceMs, limit) {
                requireFinite("outlook", sinceMs);
                const data = await call(OUTLOOK_LIST_TOOL, {
                    user_id: "me", folder: "inbox", top: limit, received_date_time_ge: new Date(sinceMs).toISOString(), select: ["id", "subject", "from", "receivedDateTime"],
                });
                return parsed("outlook", () => outlookMessagesFromData(data));
            },
            async outlookBody(id) {
                const data = await call(OUTLOOK_MESSAGE_TOOL, { user_id: "me", message_id: id, select: ["id", "body"] });
                return parsed("outlook", () => outlookBodyFromData(data));
            },
        };
    }
    return { connected: () => deps.connected(), session };
}
