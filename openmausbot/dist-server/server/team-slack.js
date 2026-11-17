// Slack for Clouds, the Cloud's side (docs/team-slack.md). One MausBot Slack app is installed per company or person;
// Slack's events arrive at the Admin, which hands each message to the Cloud with a session it opened for the member who
// wrote it (on a personal Cloud, for its owner), so here the message is that person's own request. This module holds
// the contract's wire shapes, the record of the messages taken (the idempotency key and what the Admin has been told)
// and the signed report back.
// Security invariants: the Slack bot token never reaches this machine; nothing the Admin sends beyond the member's own
// session and this contract's signature is authority; a report carries a message's id, state and final answer only.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
/** On the Admin; must match openmaus-cloud's TEAM_SLACK_REPORT_PATH. */
export const TEAM_SLACK_REPORT_PATH = "/api/cloud/machines/slack";
export const TEAM_SLACK_FILE = "team-slack-messages.json";
/** The Admin's own limit on a final answer. */
export const TEAM_SLACK_ANSWER_MAX = 200_000;
export const TEAM_SLACK_RUNNING_EVERY_MS = 10 * 60_000;
const MAX_MESSAGES = 2_000, KEEP_FINISHED_MS = 7 * 24 * 3_600_000, KEEP_ANY_MS = 30 * 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000, ANSWER_MAX_BYTES = 16 * 1024;
/** Must match openmaus-cloud's teamSlackSignature: a context of its own, so no other signed request reads as a report. */
export function teamSlackSignature(secret, machineId, timestamp, nonce, body) {
    const bodyHash = createHash("sha256").update(body).digest("base64url");
    return createHmac("sha256", secret).update(`omb-team-slack-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}
const slackId = z.string().regex(/^[A-Z0-9]{1,32}$/), slackTs = z.string().regex(/^\d{1,12}\.\d{1,9}$/);
// oxlint-disable-next-line no-control-regex
const plainName = z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/);
/** POST /api/slack/team/messages. `slack` says where the message was written, for the conversation's title only: it is
 * never authority. `channelName` is additive: the Admin may send the channel's name, shown as "#name". */
export const teamSlackMessageSchema = z.object({
    v: z.literal(1),
    id: z.uuid(),
    audience: z.enum(["team", "member"]),
    bot: z.union([z.object({ id: z.string().regex(/^[\w-]{1,200}$/) }).strict(), z.object({ name: plainName }).strict(), z.object({ default: z.literal(true) }).strict()]),
    conversationId: z.string().regex(/^[\w-]{1,128}$/).nullable(),
    text: z.string().min(1).max(12_000),
    slack: z.object({ workspace: slackId, channel: slackId, threadTs: slackTs, messageTs: slackTs, user: slackId, channelName: plainName.optional() }).optional(),
});
export const TEAM_SLACK_FINAL = new Set(["completed", "failed", "stopped"]);
const personSchema = z.string().regex(/^p_[\w-]{22}$/);
const recordSchema = z.object({
    id: z.uuid(),
    person: personSchema,
    botId: z.string(),
    botName: z.string(),
    threadId: z.string(),
    audience: z.enum(["team", "member"]),
    at: z.number(),
    state: z.enum(["running", "waiting", "completed", "failed", "stopped"]),
    waiting: z.enum(["approval", "question"]).optional(),
    /** The last state the Admin answered for; a message is over here once this is its final state. */
    told: z.string().optional(),
    /** The Admin no longer wants reports for it (already over there, or not this team's). */
    closed: z.literal(true).optional(),
});
const fileSchema = z.object({ version: z.literal(1), messages: z.array(recordSchema),
    /** A personal Cloud only: the conversations a Slack channel's message opened, kept after their messages are dropped. */
    channels: z.array(z.string().regex(/^[\w-]{1,128}$/)).optional() });
export const teamSlackKey = (record) => record.state === "waiting" ? `waiting:${record.waiting ?? "question"}` : record.state;
/** Nothing more will be said about it: the Admin has its final state, or asked for no more. */
export const teamSlackOver = (record) => record.closed === true || (TEAM_SLACK_FINAL.has(record.state) && record.told === record.state);
/** The messages taken from Slack: ids and state, never their words. */
export function createTeamSlackMessages(options) {
    const file = join(options.dataDir, TEAM_SLACK_FILE), now = options.now ?? Date.now, max = options.max ?? MAX_MESSAGES;
    const records = new Map();
    const channels = new Set();
    try {
        const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success) {
            for (const record of parsed.data.messages)
                records.set(record.id, record);
            for (const threadId of parsed.data.channels ?? [])
                channels.add(threadId);
        }
        else
            console.warn("team slack: the record of Slack messages can't be read; starting empty");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            console.warn("team slack: the record of Slack messages can't be read; starting empty");
    }
    const save = () => {
        const at = now();
        for (const [id, record] of records)
            if (at - record.at > KEEP_ANY_MS || (teamSlackOver(record) && at - record.at > KEEP_FINISHED_MS))
                records.delete(id);
        // Past the cap, what is over goes first: a run still tracked keeps its report and its Stop.
        for (const [id, record] of records) {
            if (records.size <= max)
                break;
            if (teamSlackOver(record))
                records.delete(id);
        }
        while (records.size > max)
            records.delete(records.keys().next().value);
        while (channels.size > max)
            channels.delete(channels.values().next().value);
        try {
            writeFileAtomic(file, `${JSON.stringify({ version: 1, messages: [...records.values()], ...(channels.size ? { channels: [...channels] } : {}) })}\n`, { mode: 0o600 });
        }
        catch (error) {
            console.warn(`team slack: could not save the record of Slack messages (${error instanceof Error ? error.name : "error"})`);
        }
    };
    return {
        get: (id) => records.get(id),
        all: () => [...records.values()],
        /** A personal Cloud's conversation that a Slack channel's message opened: never the chat its bot opens to. */
        channelThread: (threadId) => channels.has(threadId),
        /** On a personal Cloud: a Slack channel's message opened this conversation, or (`opened` false) it was not kept. */
        channel(threadId, opened) {
            if (opened ? channels.has(threadId) : !channels.delete(threadId))
                return;
            if (opened)
                channels.add(threadId);
            save();
        },
        put(record) {
            records.set(record.id, record);
            save();
        },
        patch(id, change) {
            const record = records.get(id);
            if (!record)
                return undefined;
            Object.assign(record, change);
            save();
            return record;
        },
        /** Everything of one person's, when they leave the team. */
        forgetPerson(person) {
            const gone = [...records.values()].filter((record) => record.person === person).map((record) => record.id);
            for (const id of gone)
                records.delete(id);
            if (gone.length)
                save();
            return gone;
        },
    };
}
const answerSchema = z.object({ ok: z.literal(true), done: z.boolean().optional() });
/** One signed report to the Admin, as the roster check signs its own. It never rejects, and logs no id, word or address. */
export function createTeamSlackReporter(options) {
    const now = options.now ?? Date.now, log = options.log ?? (() => { });
    return async (report) => {
        const fetcher = options.fetchImpl ?? globalThis.fetch;
        const body = JSON.stringify({ v: 1, ...report });
        const timestamp = String(Math.floor(now() / 1000)), nonce = randomBytes(18).toString("base64url");
        let response;
        try {
            response = await fetcher(`${options.adminOrigin}${TEAM_SLACK_REPORT_PATH}`, { method: "POST", redirect: "error", cache: "no-store", body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: {
                    accept: "application/json", "content-type": "application/json", "x-omb-cloud-machine": options.machineId, "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
                    "x-omb-cloud-signature": `v1=${teamSlackSignature(options.secret, options.machineId, timestamp, nonce, body)}`,
                } });
        }
        catch (error) {
            log(`the Admin can't be reached for a Slack report (${error instanceof Error ? error.name : "error"})`);
            return "later";
        }
        const text = await response.text().catch(() => "");
        // Security: the answer's `stop` is never read. Only a member's own session stops a run (the Stop route).
        if (response.status === 404)
            return "over";
        if (response.status === 429 || response.status >= 500)
            return "later";
        if (response.status !== 200) {
            log(`the Admin refused a Slack report (HTTP ${response.status})`);
            return "refused";
        }
        let answer;
        try {
            answer = text.length > ANSWER_MAX_BYTES ? answerSchema.safeParse(null) : answerSchema.safeParse(JSON.parse(text));
        }
        catch {
            answer = answerSchema.safeParse(null);
        }
        if (!answer.success)
            return "later";
        return answer.data.done ? "over" : "told";
    };
}
