import { redactSecretsInText } from "../../shared/redact.js";
import { newId } from "../contracts.js";
import { serverLine } from "../server-lines.js";
const MCP_CARD_PROPOSED = "A card is now visible to the person. End this turn and wait for the decision.";
export const MCP_KEY_EXPIRED = "The key expired. Ask for it again with request_credential.";
const RESTARTED = "OpenMausBot restarted, so this request expired. Ask again if you still need it.";
/** The negative option is "Cancel": phones send deny only for Deny, Cancel, Dismiss or Skip. */
const CARDS = {
    enable: { title: "server.mcp.card.turnOn", option: "Turn on", denied: () => "The person kept it off. Don't add it again unless they ask." },
    update: { title: "server.mcp.card.change", option: "Change", denied: (name) => `The person kept ${name} as it was. Don't change it again unless they ask.` },
    remove: { title: "server.mcp.card.remove", option: "Remove", denied: (name) => `The person kept ${name}. Don't remove it again unless they ask.` },
};
const FRAMED = {
    applied: (text) => `The person approved it. ${text}`,
    denied: (text) => text,
    expired: (text) => text,
    failed: (text) => `The person approved it, but it wasn't applied: ${text}`,
};
export function mcpDecisionText(request) {
    const result = request.result;
    return `OpenMausBot MCP server decision ${request.requestId}: ${result ? FRAMED[result.state](result.text) : "not answered yet."}`;
}
export class McpRequestService {
    resolving = new Set();
    held = new Map();
    options;
    constructor(options) { this.options = options; }
    /** An older open card about the same server is superseded, so only the newest proposal can be answered, and every
     * earlier card's held fields are freed, a Stop-closed one's included. `fields`: an update's. */
    propose(request, subtitle, fields, from) {
        const { store } = this.options;
        for (const line of store.messagesFor(request.threadId)) {
            const card = line.card, earlier = card?.mcpRequest;
            if (!card || !earlier || earlier.botId !== request.botId || earlier.name !== request.name)
                continue;
            this.held.delete(earlier.requestId);
            if (!card.answered && !card.dismissed && !card.expired)
                store.patchMessage(request.threadId, line.id, { card: { ...card, expired: true, options: [] } });
        }
        const requestId = newId();
        const kind = CARDS[request.action];
        const shown = redactSecretsInText(subtitle);
        const card = {
            title: serverLine(this.language(request.threadId), kind.title, { name: request.name }), subtitle: shown,
            options: [kind.option, "Cancel"], requestId, tool: "mcp_server", fixedOptions: true, mcpRequest: { ...request, requestId },
        };
        if (fields)
            this.held.set(requestId, fields);
        const message = store.appendMessage(request.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card });
        this.options.decide({ threadId: request.threadId, requestId, botId: request.botId, summary: `${card.title}\n${shown}`, decision: "card-shown" });
        return { requestId, messageId: message.id, text: MCP_CARD_PROPOSED };
    }
    /** Null when no MCP card has this id. */
    async respond(args, ownerReview) {
        const message = this.find(args.threadId, args.requestId);
        const card = message?.card, request = card?.mcpRequest;
        if (!message || !card || !request)
            return null;
        if (request.botId !== args.botId || request.threadId !== args.threadId)
            return { status: 403, body: { error: "This card belongs to another conversation." } };
        if (args.behavior !== "allow" && args.behavior !== "deny")
            return { status: 400, body: { error: `Answer with ${card.options.join(" or ")}.` } };
        if (args.behavior === "allow" && !ownerReview) {
            return { status: 403, body: { error: this.options.teamCloud ? "Ask a workspace admin to approve this."
                        : "Approve MCP server changes from the desktop app or a paired Full-access device. In a local browser, wait until every bot is idle." } };
        }
        const duplicate = Boolean(card.answered || card.dismissed || card.expired);
        let settled = request;
        if (!duplicate) {
            if (this.resolving.has(request.requestId))
                return { status: 409, body: { error: "This change is already being applied." } };
            this.resolving.add(request.requestId);
            let result;
            try {
                result = await this.resultOf(args.threadId, request, args.behavior);
            }
            finally {
                this.resolving.delete(request.requestId);
            }
            if (result === "busy")
                return { status: 409, body: { error: "MCP servers are already being updated. Try again in a moment." } };
            settled = this.record(args.threadId, message.id, request, result, args.behavior);
            this.options.decide({ threadId: args.threadId, requestId: request.requestId, botId: request.botId, summary: `${card.title}\n${card.subtitle}`,
                decision: args.behavior === "allow" ? "user-approved" : "user-denied" });
        }
        if (settled.result && !settled.resumed)
            this.resume(args.threadId, message.id, (text) => this.options.answer(args.threadId, message.id, text));
        return { status: 200, body: { ok: true, outcome: settled.result?.state === "applied" ? "allowed-once" : "rejected", result: settled.result, alreadySettled: duplicate } };
    }
    /** Whether the card has a decision for the turn parked on it. An open Change card whose fields a restart lost expires
     * now, so the turn hears why instead of waiting on a card nothing can apply. */
    decided(threadId, messageId) {
        const card = this.options.store.messagesFor(threadId).find((line) => line.id === messageId)?.card, request = card?.mcpRequest;
        if (!card || !request)
            return false;
        if (request.result)
            return true;
        if (card.answered || card.dismissed || card.expired || !this.lost(request))
            return false;
        this.record(threadId, messageId, request, this.restarted(threadId), "allow");
        return true;
    }
    /** Hands the card's decision to a parked turn; true once that turn took it. A restart calls it again for a card
     * answered while no turn could take it. */
    resume(threadId, messageId, answer) {
        const message = this.options.store.messagesFor(threadId).find((line) => line.id === messageId);
        const card = message?.card, request = card?.mcpRequest;
        if (!card || !request?.result || !answer(mcpDecisionText(request)))
            return false;
        if (!request.resumed)
            this.options.store.patchMessage(threadId, messageId, { card: { ...card, mcpRequest: { ...request, resumed: true } } });
        return true;
    }
    async resultOf(threadId, request, behavior) {
        if (behavior === "deny")
            return { state: "denied", text: CARDS[request.action].denied(request.name) };
        if (this.lost(request))
            return this.restarted(threadId);
        let applied;
        try {
            applied = await this.options.apply(request, this.held.get(request.requestId));
        }
        catch (error) {
            applied = { state: "failed", text: error instanceof Error ? error.message : String(error), note: serverLine(this.language(threadId), "server.mcp.card.failed") };
        }
        return applied.state === "busy" ? "busy" : applied;
    }
    record(threadId, messageId, request, result, behavior) {
        this.held.delete(request.requestId);
        const settled = { ...request, result: { state: result.state, text: redactSecretsInText(result.text) } };
        const current = this.options.store.messagesFor(threadId).find((line) => line.id === messageId)?.card;
        if (current) {
            const closed = result.state === "applied" || result.state === "denied" ? { answered: behavior }
                : { expired: true, options: [], held: redactSecretsInText(result.note ?? result.text) };
            this.options.store.patchMessage(threadId, messageId, { card: { ...current, ...closed, mcpRequest: settled } });
        }
        return settled;
    }
    /** Only an update needs fields from memory; a restart loses them. */
    lost(request) {
        return request.action === "update" && !this.held.has(request.requestId);
    }
    restarted(threadId) {
        return { state: "expired", text: RESTARTED, note: serverLine(this.language(threadId), "server.mcp.card.restarted") };
    }
    language(threadId) {
        return this.options.language?.(threadId);
    }
    find(threadId, requestId) {
        return this.options.store.messagesFor(threadId).find((line) => line.card?.requestId === requestId && line.card.mcpRequest);
    }
}
