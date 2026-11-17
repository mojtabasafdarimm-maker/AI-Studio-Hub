#!/usr/bin/env node

// scripts/mcp-server.ts
import readline from "node:readline";

// electron/tailnet.mjs
var LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
var TAILNET_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.ts\\.net$`);

// electron/server-address.mjs
var DEFAULT_PORT = 8799;
var EXAMPLE_ADDRESS = `http://192.168.1.20:${DEFAULT_PORT}`;
var bareHost = (host) => String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
function ipv4(host) {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  return octets.some((octet) => octet > 255) ? null : octets;
}
function isLoopbackHost(host) {
  const name = bareHost(host);
  const v4 = ipv4(name);
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" || v4 !== null && v4[0] === 127;
}
function isPrivateHost(host) {
  const name = bareHost(host);
  if (!name) return false;
  const v4 = ipv4(name);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127;
  }
  if (/^\d+(\.\d+){0,3}$/.test(name)) return false;
  if (name.includes(":")) return name === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
  if (isLoopbackHost(name) || [".ts.net", ".local", ".home.arpa"].some((suffix) => name.endsWith(suffix))) return true;
  return !name.includes(".") && /^[a-z0-9-]+$/.test(name);
}
function allowedServerOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || url.protocol === "http:" && isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

// scripts/mcp-message-projection.ts
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function projectMessage(message) {
  const card = isRecord(message.card) ? {
    title: message.card.title,
    subtitle: message.card.subtitle,
    options: message.card.options,
    answered: message.card.answered,
    dismissed: message.card.dismissed,
    expired: message.card.expired
  } : void 0;
  const tool = isRecord(message.tool) ? {
    name: message.tool.name,
    ok: message.tool.ok,
    spoken: message.tool.spoken,
    setup: message.tool.setup,
    ...message.tool.terminal === true ? { terminal: true } : {}
  } : void 0;
  const connector = isRecord(message.connector) ? {
    slug: message.connector.slug,
    label: message.connector.label,
    description: message.connector.description,
    status: message.connector.status,
    dismissed: message.connector.dismissed,
    resumed: message.connector.resumed
  } : void 0;
  const secret = isRecord(message.secret) ? {
    target: message.secret.target,
    label: message.secret.label,
    description: message.secret.description,
    placeholder: message.secret.placeholder,
    helpUrl: message.secret.helpUrl,
    provided: message.secret.provided,
    dismissed: message.secret.dismissed,
    superseded: message.secret.superseded,
    resumed: message.secret.resumed
  } : void 0;
  const signIn = isRecord(message.signIn) ? {
    site: message.signIn.site,
    url: message.signIn.url,
    place: message.signIn.place,
    reason: message.signIn.reason,
    done: message.signIn.done,
    cancelled: message.signIn.cancelled,
    superseded: message.signIn.superseded,
    answeredInChat: message.signIn.answeredInChat,
    resumed: message.signIn.resumed
  } : void 0;
  return {
    id: message.id,
    at: message.at,
    role: message.role,
    kind: message.kind,
    text: message.text,
    from: message.from,
    replyToId: message.replyToId,
    reactions: message.reactions,
    steered: message.steered,
    queued: message.queued,
    ...tool ? { tool } : {},
    ...card ? { card } : {},
    ...connector ? { connector } : {},
    ...secret ? { secret } : {},
    ...signIn ? { signIn } : {},
    ...message.widget ? { widget: message.widget } : {},
    ...message.app ? { app: message.app } : {},
    ...message.fromApp ? { fromApp: message.fromApp } : {},
    ...message.wait ? { wait: message.wait } : {},
    ...message.kind === "screen" ? { hasImage: Boolean(message.hasImage || message.png) } : {}
  };
}

// scripts/mcp-server.ts
function validateBaseUrl(url) {
  const trimmed = url.trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid OpenMausBot URL: '${url}'. Start it with http:// or https://, like ${EXAMPLE_ADDRESS}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenMausBot URL must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OpenMausBot URL must not contain credentials; use OPENMAUSBOT_TOKEN instead");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "" || parsed.search || parsed.hash) {
    throw new Error("OpenMausBot URL must be an origin without a path, query, or fragment");
  }
  if (!allowedServerOrigin(parsed.origin)) {
    throw new Error(`${parsed.origin} is on the open internet and plain http isn't encrypted. Use the server's https:// address, or put HTTPS in front (cloudflared, Caddy or Tailscale).`);
  }
  return parsed.origin;
}
var configuredUrl = process.env.OPENMAUSBOT_URL || (process.env.OMB_PORT ? `http://127.0.0.1:${process.env.OMB_PORT}` : void 0);
var OMB_BASE_URL = validateBaseUrl(configuredUrl || "http://127.0.0.1:8799");
var DISCOVERY_URLS = configuredUrl ? [OMB_BASE_URL] : [8799, 18799, 28799].map((port) => `http://127.0.0.1:${port}`);
var discoveredBaseUrl;
function log(msg) {
  process.stderr.write(`[openmausbot-mcp] ${msg}
`);
}
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
function requestTimeoutMs() {
  const raw = Number(process.env.OPENMAUSBOT_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1e3 && raw <= 12e4 ? Math.floor(raw) : DEFAULT_REQUEST_TIMEOUT_MS;
}
function requestHeaders(options) {
  const token = process.env.OPENMAUSBOT_TOKEN?.trim();
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}
var OpenMausBotApiError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function fetchJson(url, options = {}) {
  const timeout = AbortSignal.timeout(requestTimeoutMs());
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers = requestHeaders(options);
  const response = await fetch(url, { ...options, signal, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 403 && !new Headers(headers).has("Authorization")) {
      throw new OpenMausBotApiError(403, /on this shared server/.test(text) ? "This is a shared server, so a program on it without a paired session token may only check its health. Set OPENMAUSBOT_TOKEN to a paired session (openmausbot connect), as described in docs/mcp-server.md." : "OpenMausBot refused this request because the installed desktop app requires a paired session token. Set OPENMAUSBOT_TOKEN as described in docs/mcp-server.md.");
    }
    throw new OpenMausBotApiError(response.status, `OpenMausBot API error (${response.status}): ${text || response.statusText}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`OpenMausBot API returned a non-JSON response from ${url}`);
  }
}
async function probeBaseUrls(candidates) {
  const failures = [];
  for (const unvalidated of candidates) {
    const candidate = validateBaseUrl(unvalidated);
    try {
      const health = await fetchJson(`${candidate}/api/health`, {
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs(), 2e3))
      });
      if (health?.app !== "openmausbot") {
        failures.push(`${candidate} answered, but it was not OpenMausBot`);
        continue;
      }
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not find a running OpenMausBot server. ${failures.join("; ")}`);
}
async function resolveBaseUrl() {
  if (discoveredBaseUrl) return discoveredBaseUrl;
  if (process.env.OPENMAUSBOT_TOKEN?.trim() && !configuredUrl) {
    throw new Error("Set OPENMAUSBOT_URL or OMB_PORT when using OPENMAUSBOT_TOKEN so credentials are never sent during port discovery");
  }
  discoveredBaseUrl = await probeBaseUrls(DISCOVERY_URLS);
  return discoveredBaseUrl;
}
async function request(path, options = {}, baseUrl) {
  const target = baseUrl ? validateBaseUrl(baseUrl) : await resolveBaseUrl();
  return fetchJson(`${target}${path}`, options);
}
var SEND_ID_SCHEMA = {
  type: "string",
  description: "Optional id you make up for this send (16-80 letters, digits, - or _). Sending again with the same id returns the first send's receipt instead of a second message."
};
var READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
var ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
var MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
var DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
var AGENT_ACTION = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
var TOOLS = [
  {
    name: "get_system_health",
    description: "Check whether the OpenMausBot server is reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "list_bots",
    description: "List bots, their current status, active task, and available tasks without loading transcripts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "get_bot_messages",
    description: "Retrieve a bounded page of recent messages from one bot task. Images are never returned inline.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the bot's active task." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages to retrieve (default: 30, max: 200)." }
      },
      required: ["bot_id"],
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "send_bot_message",
    description: "Send an instruction to one bot task without changing the selected task. This may cause the bot to use external tools.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot to message." },
        task_id: { type: "string", description: "Optional owned task/thread ID. Defaults to the bot's selected task." },
        text: { type: "string", description: "The message content/instruction to send." },
        send_id: SEND_ID_SCHEMA
      },
      required: ["bot_id", "text"],
      additionalProperties: false
    },
    annotations: AGENT_ACTION
  },
  {
    name: "create_bot",
    description: "Create a new bot and optionally configure its profile, section, and exact model selection.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bot display name." },
        title: { type: "string", description: "Optional short role title." },
        description: { type: "string", description: "Optional persona or responsibility description." },
        section: { type: "string", description: "Optional sidebar section." },
        instance_id: { type: "string", description: "Optional provider instance ID; model is required with it." },
        model: { type: "string", description: "Optional exact model ID; instance_id is required with it." },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] }
      },
      required: ["name"],
      additionalProperties: false
    },
    annotations: ADDITIVE
  },
  {
    name: "update_bot_profile",
    description: "Update safe bot profile fields. This cannot alter permissions, computer access, or approval settings.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        name: { type: "string", description: "Optional bot display name." },
        title: { type: "string", description: "Optional short role title." },
        description: { type: "string", description: "Optional persona or responsibility description." },
        section: { type: ["string", "null"], description: "Optional sidebar section. Null clears it." }
      },
      required: ["bot_id"],
      additionalProperties: false
    },
    annotations: MUTATING
  },
  {
    name: "list_channels",
    description: "List multi-agent channels, their members, active task, and available tasks without loading transcripts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "get_channel_messages",
    description: "Retrieve a bounded page of recent messages from one channel task. Images are never returned inline.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel." },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the channel's active task." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages to retrieve (default: 30, max: 200)." }
      },
      required: ["channel_id"],
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "send_channel_message",
    description: "Send an instruction to a channel's active task. Optionally name the expected task to prevent cross-task races. This may cause one or more bots to use external tools.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel." },
        task_id: { type: "string", description: "Optional expected active task/thread ID." },
        text: { type: "string", description: "The message content to post." },
        send_id: SEND_ID_SCHEMA,
        mentions: { type: "array", items: { type: "string" }, maxItems: 20, description: "When an @name in text is shared by several bots in the channel: the ids of the ones you mean." }
      },
      required: ["channel_id", "text"],
      additionalProperties: false
    },
    annotations: AGENT_ACTION
  },
  {
    name: "create_channel",
    description: "Create a multi-agent channel from existing bots.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Channel name." },
        member_ids: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        section: { type: "string", description: "Optional sidebar section." },
        bulletin: { type: "string", description: "Optional shared instructions for channel members." },
        default_responder: {
          oneOf: [
            { type: "object", properties: { kind: { const: "everyone" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "mentions" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "member" }, bot_id: { type: "string" } }, required: ["kind", "bot_id"], additionalProperties: false }
          ]
        }
      },
      required: ["name", "member_ids"],
      additionalProperties: false
    },
    annotations: ADDITIVE
  },
  {
    name: "update_channel",
    description: "Update a channel's name, members, section, bulletin, or default responder.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel." },
        name: { type: "string" },
        member_ids: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        section: { type: ["string", "null"], description: "Null clears the section." },
        bulletin: { type: "string" },
        default_responder: {
          oneOf: [
            { type: "object", properties: { kind: { const: "everyone" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "mentions" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "member" }, bot_id: { type: "string" } }, required: ["kind", "bot_id"], additionalProperties: false }
          ]
        }
      },
      required: ["channel_id"],
      additionalProperties: false
    },
    annotations: MUTATING
  },
  {
    name: "create_task",
    description: "Create and activate a fresh conversation task for a bot or user-created channel.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        title: { type: "string", description: "Optional task title." }
      },
      required: ["target_type", "target_id"],
      additionalProperties: false
    },
    annotations: ADDITIVE
  },
  {
    name: "switch_task",
    description: "Select an existing bot or channel task. Bot tasks keep running independently; busy channels cannot switch.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string" }
      },
      required: ["target_type", "target_id", "task_id"],
      additionalProperties: false
    },
    annotations: MUTATING
  },
  {
    name: "rename_task",
    description: "Rename an existing bot or channel task.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string" },
        title: { type: "string" }
      },
      required: ["target_type", "target_id", "task_id", "title"],
      additionalProperties: false
    },
    annotations: MUTATING
  },
  {
    name: "search_messages",
    description: "Search local transcripts, optionally within one task/thread. Returns at most 100 compact hits.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        task_id: { type: "string", description: "Optional task/thread ID." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum hits (default: 40)." }
      },
      required: ["query"],
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "wait_for_conversation",
    description: "Wait for a bot or channel task, and every teammate it is waiting on, to finish, stall, fail, or require user input. The result carries the job tree.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the active task." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 120, description: "Maximum wait (default: 30 seconds)." },
        scope: { type: "string", enum: ["job", "turn"], description: "job (default): the conversation and every teammate it waits on; turn: its own turn only." },
        since_ms: { type: "integer", minimum: 0, description: "Optional: the job's since from an earlier result, so a repeated wait watches the same job." },
        after_version: { type: "string", description: "Optional: an earlier result's job version; answer only once the job has changed since." }
      },
      required: ["target_type", "target_id"],
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "set_bot_model",
    description: "Change an idle bot's default and selected task model, or only one idle task's model when task_id is provided. Other tasks are unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        task_id: { type: "string", description: "Optional owned task/thread ID. Omit to change the bot's default and selected task model." },
        instance_id: { type: "string", description: "The configured provider instance ID." },
        model: { type: "string", description: "The exact model ID exposed by that instance." },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] }
      },
      required: ["bot_id", "instance_id", "model"],
      additionalProperties: false
    },
    annotations: MUTATING
  },
  {
    name: "edit_bot_message",
    description: "Edit an earlier user message, which forks the conversation from that point and answers again. This is the rewind a person performs in the composer, and the only mapped way to make the harness rebuild a thread's context instead of resuming the provider's own session. Refused while the thread is working.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The ID of the bot." },
        message_id: { type: "string", description: "The user message to replace." },
        text: { type: "string", description: "What that message should say instead." },
        task_id: { type: "string", description: "Optional owned task/thread ID. Defaults to the bot's selected task." }
      },
      required: ["bot_id", "message_id", "text"],
      additionalProperties: false
    },
    annotations: MUTATING
  },
  {
    name: "list_available_models",
    description: "List configured model instances and capabilities without exposing local executable paths.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: "interrupt_conversation",
    description: "Interrupt one bot or channel task's turn without stopping other bot tasks.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["bot", "channel"] },
        target_id: { type: "string" },
        task_id: { type: "string", description: "Optional task/thread ID. Defaults to the selected task." }
      },
      required: ["target_type", "target_id"],
      additionalProperties: false
    },
    annotations: DESTRUCTIVE
  }
];
function parsePositiveLimit(raw, fallback = 30, maximum = 200) {
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
function valueHasType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
function schemaError(schema, value, path) {
  if (schema.const !== void 0 && value !== schema.const) return `${path} must equal ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => !schemaError(candidate, value, path));
    return matches.length === 1 ? null : `${path} does not match exactly one supported shape`;
  }
  if (schema.type !== void 0) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => valueHasType(value, type))) return `${path} must be ${types.join(" or ")}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      return `${path} must not contain duplicates`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = schemaError(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `${path}.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !(key in properties));
      if (extra) return `${path}.${extra} is not supported`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const error = schemaError(child, value[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}
var ToolInputError = class extends Error {
};
function validateToolArguments(name, args) {
  if (typeof name !== "string" || !name) throw new ToolInputError("tool name must be a non-empty string");
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
  if (!isRecord(args)) throw new ToolInputError("tool arguments must be an object");
  const error = schemaError(tool.inputSchema, args, "arguments");
  if (error) throw new ToolInputError(error);
}
function stringArg(args, key, options = {}) {
  const raw = args[key];
  if (typeof raw !== "string") throw new ToolInputError(`${key} must be a string`);
  const value = options.trim === false ? raw : raw.trim();
  if (!options.allowEmpty && !value) throw new ToolInputError(`${key} must not be empty`);
  if (options.max && value.length > options.max) throw new ToolInputError(`${key} must be at most ${options.max} characters`);
  return value;
}
function optionalStringArg(args, key, options = {}) {
  if (!(key in args)) return void 0;
  return stringArg(args, key, options);
}
function idArg(args, key) {
  const value = stringArg(args, key);
  if (!/^[\w-]+$/.test(value)) throw new ToolInputError(`${key} is not a valid OpenMausBot ID`);
  return value;
}
function stringArrayArg(args, key) {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ToolInputError(`${key} must be a non-empty list of IDs`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}
function records(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function projectTask(task, activeThreadId) {
  return {
    taskId: task.threadId,
    title: task.title,
    createdAt: task.createdAt,
    ...typeof task.busy === "boolean" ? { busy: task.busy } : {},
    ...typeof task.waitingForTeammates === "boolean" ? { waitingForTeammates: task.waitingForTeammates } : {},
    ...task.activity ? { activity: task.activity } : {},
    ...typeof task.working === "boolean" ? { working: task.working } : {},
    ...task.busyBotId !== void 0 ? { busyBotId: task.busyBotId ?? null } : {},
    ...task.modelSelection ? { modelSelection: task.modelSelection } : {},
    ...typeof activeThreadId === "string" ? { active: task.threadId === activeThreadId } : {},
    ...task.usage ? { usage: task.usage } : {}
  };
}
function channelBusyWith(groups, botId) {
  return records(groups).find((channel) => channel.busyBotId === botId || records(channel.tasks).some((task) => task.busyBotId === botId));
}
function botTaskState(bot, taskId) {
  const task = records(bot.tasks).find((candidate) => candidate.threadId === taskId);
  if (task && (typeof task.busy === "boolean" || typeof task.activity === "string")) return task;
  return bot.threadId === taskId ? bot : { busy: false, activity: "idle" };
}
function projectBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    section: bot.section ?? null,
    chiefOfStaff: Boolean(bot.chiefOfStaff),
    modelSelection: bot.modelSelection,
    busy: Boolean(bot.busy),
    waitingForTeammates: Boolean(bot.waitingForTeammates),
    activity: bot.activity,
    unread: Boolean(bot.unread),
    activeTaskId: bot.threadId,
    tasks: records(bot.tasks).map((task) => projectTask(task, bot.threadId))
  };
}
function projectChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    memberIds: channel.memberIds,
    bulletin: channel.bulletin,
    defaultResponder: channel.defaultResponder,
    section: channel.section ?? null,
    directMessage: Boolean(channel.dm),
    working: Boolean(channel.working),
    busyBotId: channel.busyBotId ?? null,
    activeTaskId: channel.threadId,
    tasks: records(channel.tasks).map((task) => projectTask(task, channel.threadId))
  };
}
async function fleet(fetcher) {
  return fetcher("/api/bots?messages=0");
}
function taskBelongsTo(owner, taskId) {
  return owner.threadId === taskId || records(owner.tasks).some((task) => task.threadId === taskId);
}
function messageNeedsInput(message) {
  const card = isRecord(message.card) && message.card.requestId && !message.card.answered && !message.card.dismissed && !message.card.expired && !message.card.quotaSwitch;
  const connector = isRecord(message.connector) && !message.connector.dismissed && !message.connector.resumed && message.connector.status !== "connected";
  const secret = isRecord(message.secret) && !message.secret.provided && !message.secret.dismissed && !message.secret.superseded;
  const signIn = isRecord(message.signIn) && !message.signIn.done && !message.signIn.cancelled && !message.signIn.superseded && !message.signIn.answeredInChat;
  return Boolean(card || connector || secret || signIn);
}
function dispatchFailedAfterLatestUser(messages) {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const turnMessages = messages.slice(lastUser + 1);
  if (turnMessages.some((message) => message.tool?.terminal === true && message.tool.ok === false)) return true;
  if (turnMessages.some((message) => message.role === "bot" && message.kind === "text" && message.text?.trim())) {
    return false;
  }
  return turnMessages.some(
    (message) => message.kind === "activity" && message.tool?.ok === false && typeof message.tool?.name === "string" && /^error:/i.test(message.tool.name.trim())
  );
}
async function conversationTail(fetcher, taskId, limit = 10) {
  const page = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
  const raw = records(page.messages);
  return {
    raw,
    messages: raw.map(projectMessage),
    hasMore: Boolean(page.hasMore)
  };
}
function normalizeResponder(value) {
  if (value === void 0) return void 0;
  if (!isRecord(value)) throw new ToolInputError("default_responder must be an object");
  if (value.kind === "everyone" || value.kind === "mentions") return { kind: value.kind };
  if (value.kind === "member" && typeof value.bot_id === "string" && value.bot_id.trim()) {
    return { kind: "member", botId: value.bot_id.trim() };
  }
  throw new ToolInputError("default_responder is invalid");
}
async function checkedModelSelection(args, fetcher) {
  const instanceId = stringArg(args, "instance_id");
  const model = stringArg(args, "model");
  const effort = optionalStringArg(args, "effort");
  const described = await fetcher("/api/instances");
  const instance = records(described.instances).find((candidate) => candidate.instanceId === instanceId);
  if (!instance) throw new ToolInputError(`model instance not found: ${instanceId}`);
  if (instance.snapshot?.state !== "available") throw new ToolInputError(`model instance is unavailable: ${instanceId}`);
  const models = isRecord(instance.models) ? instance.models : {};
  const offered = records(models.options).map((option) => option.id).filter((id) => typeof id === "string");
  if (models.default !== model && !offered.includes(model)) {
    throw new ToolInputError(`model '${model}' is not offered by instance '${instanceId}'`);
  }
  const efforts = Array.isArray(instance.capabilities?.effortLevels) ? instance.capabilities.effortLevels : [];
  if (effort && !efforts.includes(effort)) {
    throw new ToolInputError(`effort '${effort}' is not offered by instance '${instanceId}'`);
  }
  return { instanceId, model, ...effort ? { effort } : {} };
}
function taskRoute(targetType, targetId) {
  if (targetType === "bot") return `/api/bots/${encodeURIComponent(targetId)}/tasks`;
  if (targetType === "channel") return `/api/groups/${encodeURIComponent(targetId)}/tasks`;
  throw new ToolInputError("target_type must be bot or channel");
}
function sendIdArg(args) {
  if (args.send_id === void 0) return {};
  const value = stringArg(args, "send_id");
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(value)) throw new ToolInputError("send_id must be 16-80 letters, digits, - or _");
  return { sendId: value };
}
function sendReceipt(receipt) {
  const body = isRecord(receipt) ? receipt : {};
  const message = isRecord(body.message) ? body.message : void 0;
  return {
    ...message && typeof message.id === "string" ? { messageId: message.id, at: message.at } : {},
    ...body.queued === true ? { queued: true, queueId: body.queueId } : {},
    ...body.steered === true ? { steered: true } : {}
  };
}
var FINAL_JOB_STATES = /* @__PURE__ */ new Set(["needs-input", "completed", "failed", "stalled", "idle"]);
async function waitForJob(fetcher, threadId, options) {
  const deadline = Date.now() + options.timeoutMs;
  const holdMs = Math.max(500, Math.min(2e4, requestTimeoutMs() - 5e3));
  let since = options.since;
  let version = options.after;
  for (; ; ) {
    const wait = version === void 0 ? 0 : Math.max(0, Math.min(holdMs, deadline - Date.now()));
    const params = new URLSearchParams({
      scope: options.scope,
      ...since !== void 0 ? { since: String(since) } : {},
      ...wait > 0 ? { wait: String(wait) } : {},
      ...version !== void 0 ? { version } : {}
    });
    const job = await fetcher(
      `/api/threads/${encodeURIComponent(threadId)}/job?${params.toString()}`,
      options.signal ? { signal: options.signal } : {}
    ).catch((error) => {
      throw error instanceof OpenMausBotApiError && error.status === 404 && !/no such conversation/.test(error.message) ? new OpenMausBotApiError(404, "This OpenMausBot server cannot report a conversation's job (GET /api/threads/:id/job); update it, then wait again.") : error;
    });
    since = Number(job.since);
    if (job.version !== version) options.onProgress?.(job);
    version = String(job.version);
    if (FINAL_JOB_STATES.has(job.state) && job.version !== options.after) return { job, timedOut: false };
    if (Date.now() >= deadline) return { job, timedOut: true };
  }
}
async function handleToolCall(name, args, baseFetcher = request, signal, hooks = {}) {
  const fetcher = signal ? (path, options = {}) => baseFetcher(path, { ...options, signal: options.signal ?? signal }) : baseFetcher;
  validateToolArguments(name, args);
  switch (name) {
    case "get_system_health": {
      const res = await fetcher("/api/health");
      if (res?.app !== "openmausbot") throw new Error("The configured endpoint is not an OpenMausBot server");
      return {
        status: "connected",
        endpoint: discoveredBaseUrl ?? OMB_BASE_URL,
        app: "openmausbot",
        packaged: Boolean(res.static)
      };
    }
    case "list_bots": {
      const res = await fleet(fetcher);
      return { bots: records(res.bots).map(projectBot) };
    }
    case "get_bot_messages": {
      const botId = idArg(args, "bot_id");
      const res = await fleet(fetcher);
      const bot = records(res.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Bot not found: ${botId}`);
      const taskId = args.task_id === void 0 ? String(bot.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
      const limit = parsePositiveLimit(args.limit, 30, 200);
      const page = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
      return {
        bot: projectBot(bot),
        taskId,
        messages: records(page.messages).map(projectMessage),
        hasMore: Boolean(page.hasMore)
      };
    }
    case "send_bot_message": {
      const botId = idArg(args, "bot_id");
      const text = stringArg(args, "text", { trim: true, max: 1e5 });
      const state = await fleet(fetcher);
      const bot = records(state.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Bot not found: ${botId}`);
      const taskId = args.task_id === void 0 ? String(bot.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
      const busyChannel = channelBusyWith(state.groups, botId);
      if (busyChannel) {
        throw new Error(`Bot '${botId}' is working in channel '${busyChannel.id}'; send to or interrupt that channel instead`);
      }
      const receipt = await fetcher(`/api/bots/${encodeURIComponent(botId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, threadId: taskId, ...sendIdArg(args) })
      });
      return { success: true, botId, taskId, ...sendReceipt(receipt) };
    }
    case "create_bot": {
      const name2 = stringArg(args, "name", { max: 100 });
      const title = optionalStringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
      const description = optionalStringArg(args, "description", { trim: false, allowEmpty: true, max: 4e3 });
      const section = optionalStringArg(args, "section", { max: 60 });
      const wantsModel = args.instance_id !== void 0 || args.model !== void 0 || args.effort !== void 0;
      if (wantsModel && (args.instance_id === void 0 || args.model === void 0)) {
        throw new ToolInputError("instance_id and model must be provided together");
      }
      const selection = wantsModel ? await checkedModelSelection(args, fetcher) : void 0;
      const created = await fetcher("/api/bots", {
        method: "POST",
        body: JSON.stringify({
          name: name2,
          ...title !== void 0 ? { title } : {},
          ...description !== void 0 ? { description } : {},
          ...section !== void 0 ? { section } : {},
          ...selection ? { modelSelection: selection, requireAvailableModel: true } : {}
        })
      });
      if (!isRecord(created?.bot) || typeof created.bot.id !== "string") {
        throw new Error("OpenMausBot did not return the created bot");
      }
      return { success: true, bot: projectBot(created.bot) };
    }
    case "update_bot_profile": {
      const botId = idArg(args, "bot_id");
      const patch = {};
      if (args.name !== void 0) patch.name = stringArg(args, "name", { max: 100 });
      if (args.title !== void 0) patch.title = stringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
      if (args.description !== void 0) patch.description = stringArg(args, "description", { trim: false, allowEmpty: true, max: 4e3 });
      if ("section" in args) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
      if (!Object.keys(patch).length) throw new ToolInputError("provide at least one profile field to update");
      const result = await fetcher(`/api/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      if (!isRecord(result?.bot)) {
        throw new Error("OpenMausBot did not return the updated bot");
      }
      return { success: true, bot: projectBot(result.bot) };
    }
    case "list_channels": {
      const res = await fleet(fetcher);
      return { channels: records(res.groups).map(projectChannel) };
    }
    case "get_channel_messages": {
      const channelId = idArg(args, "channel_id");
      const res = await fleet(fetcher);
      const channel = records(res.groups).find((candidate) => candidate.id === channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);
      const taskId = args.task_id === void 0 ? String(channel.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(channel, taskId)) throw new Error(`Task '${taskId}' does not belong to channel '${channelId}'`);
      const limit = parsePositiveLimit(args.limit, 30, 200);
      const page = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
      return {
        channel: projectChannel(channel),
        taskId,
        messages: records(page.messages).map(projectMessage),
        hasMore: Boolean(page.hasMore)
      };
    }
    case "send_channel_message": {
      const channelId = idArg(args, "channel_id");
      const text = stringArg(args, "text", { trim: true, max: 1e5 });
      const state = await fleet(fetcher);
      const channel = records(state.groups).find((candidate) => candidate.id === channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);
      const taskId = args.task_id === void 0 ? String(channel.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(channel, taskId)) {
        throw new Error(`Task '${taskId}' does not belong to channel '${channelId}'`);
      }
      if (channel.threadId !== taskId && !records(channel.tasks).some((task) => typeof task.working === "boolean")) {
        throw new Error(`Task '${taskId}' is not active for channel '${channelId}'; switch to it before sending`);
      }
      const receipt = await fetcher(`/api/groups/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, threadId: taskId, ...sendIdArg(args), ...args.mentions !== void 0 ? { mentions: stringArrayArg(args, "mentions") } : {} })
      });
      return { success: true, channelId, taskId, ...sendReceipt(receipt) };
    }
    case "create_channel": {
      const name2 = stringArg(args, "name", { max: 100 });
      const memberIds = stringArrayArg(args, "member_ids");
      const section = optionalStringArg(args, "section", { max: 60 });
      const bulletin = optionalStringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12e3 }) ?? "";
      const requestedResponder = normalizeResponder(args.default_responder);
      if (requestedResponder?.kind === "member" && !memberIds.includes(requestedResponder.botId)) {
        throw new ToolInputError("default_responder bot must be a channel member");
      }
      const responder = requestedResponder ?? { kind: "member", botId: memberIds[0] };
      const created = await fetcher("/api/groups", {
        method: "POST",
        body: JSON.stringify({
          name: name2,
          memberIds,
          ...section ? { section } : {},
          setup: { bulletin, defaultResponder: responder }
        })
      });
      if (!isRecord(created?.group) || typeof created.group.id !== "string") {
        throw new Error("OpenMausBot did not return the created channel");
      }
      return { success: true, channel: projectChannel(created.group) };
    }
    case "update_channel": {
      const channelId = idArg(args, "channel_id");
      const patch = {};
      if (args.name !== void 0) patch.name = stringArg(args, "name", { max: 100 });
      if (args.member_ids !== void 0) patch.memberIds = stringArrayArg(args, "member_ids");
      if (args.section !== void 0) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
      if (args.bulletin !== void 0) patch.bulletin = stringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12e3 });
      if (args.default_responder !== void 0) patch.defaultResponder = normalizeResponder(args.default_responder);
      if (Object.keys(patch).length === 0) throw new ToolInputError("provide at least one channel field to update");
      const memberIds = patch.memberIds;
      const responder = patch.defaultResponder;
      if (memberIds && responder?.kind === "member" && !memberIds.includes(responder.botId)) {
        throw new ToolInputError("default_responder bot must be a channel member");
      }
      const result = await fetcher(`/api/groups/${encodeURIComponent(channelId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      if (!isRecord(result?.group)) {
        throw new Error("OpenMausBot did not return the updated channel");
      }
      return { success: true, channel: projectChannel(result.group) };
    }
    case "create_task": {
      const targetId = idArg(args, "target_id");
      const title = optionalStringArg(args, "title", { max: 80 });
      const route = taskRoute(args.target_type, targetId);
      const result = await fetcher(route, { method: "POST", body: JSON.stringify(title ? { title } : {}) });
      if (!isRecord(result?.task) || typeof result.task.threadId !== "string") {
        throw new Error("OpenMausBot did not return the created task");
      }
      const activeTaskId = result.bot?.threadId ?? result.group?.threadId ?? result.task?.threadId;
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        task: projectTask(result.task, activeTaskId)
      };
    }
    case "switch_task": {
      const targetId = idArg(args, "target_id");
      const taskId = idArg(args, "task_id");
      const route = taskRoute(args.target_type, targetId);
      const result = await fetcher(`${route}/${encodeURIComponent(taskId)}?messages=0`, { method: "POST", body: "{}" });
      const target = args.target_type === "bot" ? result.bot : result.group;
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        taskId,
        ...isRecord(target) ? { target: args.target_type === "bot" ? projectBot(target) : projectChannel(target) } : {}
      };
    }
    case "rename_task": {
      const targetId = idArg(args, "target_id");
      const taskId = idArg(args, "task_id");
      const title = stringArg(args, "title", { max: 80 });
      const route = taskRoute(args.target_type, targetId);
      const result = await fetcher(`${route}/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title })
      });
      if (!isRecord(result?.task)) {
        throw new Error("OpenMausBot did not return the renamed task");
      }
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        task: projectTask(result.task, void 0)
      };
    }
    case "search_messages": {
      const query = stringArg(args, "query", { max: 500 });
      const limit = parsePositiveLimit(args.limit, 40, 100);
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (args.task_id !== void 0) params.set("threadId", idArg(args, "task_id"));
      const result = await fetcher(`/api/search?${params.toString()}`);
      return { hits: records(result.hits) };
    }
    case "wait_for_conversation": {
      const targetType = args.target_type;
      if (targetType !== "bot" && targetType !== "channel") {
        throw new ToolInputError("target_type must be bot or channel");
      }
      const targetId = idArg(args, "target_id");
      const timeoutSeconds = parsePositiveLimit(args.timeout_seconds, 30, 120);
      const label = targetType === "bot" ? "Bot" : "Channel";
      const find = (state2) => (targetType === "bot" ? records(state2.bots) : records(state2.groups)).find((candidate) => candidate.id === targetId);
      const state = await fleet(fetcher);
      const target = find(state);
      if (!target) throw new Error(`${label} not found: ${targetId}`);
      const taskId = args.task_id === void 0 ? String(target.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(target, taskId)) throw new Error(`Task '${taskId}' does not belong to ${targetType} '${targetId}'`);
      const busyChannel = targetType === "bot" && botTaskState(target, taskId) === target && channelBusyWith(state.groups, targetId);
      if (busyChannel) throw new Error(`Bot '${targetId}' is working in channel '${busyChannel.id}'; wait on that channel instead`);
      const { job, timedOut } = await waitForJob(fetcher, taskId, {
        scope: args.scope === "turn" ? "turn" : "job",
        timeoutMs: timeoutSeconds * 1e3,
        signal,
        onProgress: hooks.onProgress,
        ...typeof args.since_ms === "number" ? { since: args.since_ms } : {},
        ...args.after_version !== void 0 ? { after: stringArg(args, "after_version") } : {}
      });
      const tail = await conversationTail(fetcher, taskId);
      const latest = find(await fleet(fetcher)) ?? target;
      const activity = job.conversation?.activity;
      const status = job.state === "needs-input" || tail.raw.some(messageNeedsInput) ? "needs-user" : timedOut ? "timed-out" : activity === "dead" ? "failed" : activity === "no-signal" ? "stalled" : dispatchFailedAfterLatestUser(tail.raw) ? "failed" : "settled";
      const jobState = status === "needs-user" ? "needs-input" : status === "timed-out" ? "timed-out" : status !== "settled" && (job.state === "completed" || job.state === "idle") ? status : job.state;
      return {
        status,
        state: jobState,
        targetType,
        targetId,
        taskId,
        target: targetType === "bot" ? projectBot(latest) : projectChannel(latest),
        messages: tail.messages,
        hasMore: tail.hasMore,
        job
      };
    }
    case "set_bot_model": {
      const botId = idArg(args, "bot_id");
      const current = await fleet(fetcher);
      const bot = records(current.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Bot not found: ${botId}`);
      if (args.task_id !== void 0) {
        const taskId = idArg(args, "task_id");
        if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
        if (botTaskState(bot, taskId).busy) throw new Error("Interrupt the task or let it finish before changing its model");
        const selection2 = await checkedModelSelection(args, fetcher);
        const res2 = await fetcher(`${taskRoute("bot", botId)}/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify({ modelSelection: selection2, requireAvailableModel: true })
        });
        if (!isRecord(res2?.task)) throw new Error("OpenMausBot did not return the updated task");
        return { success: true, botId, task: projectTask(res2.task, bot.threadId) };
      }
      if (bot.busy) throw new Error("Interrupt the bot or let it finish before changing its model");
      const selection = await checkedModelSelection(args, fetcher);
      const res = await fetcher(`/api/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelSelection: selection, requireAvailableModel: true })
      });
      return { success: true, bot: projectBot(res.bot) };
    }
    case "edit_bot_message": {
      const botId = idArg(args, "bot_id");
      const messageId = idArg(args, "message_id");
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("text is required");
      const current = await fleet(fetcher);
      const bot = records(current.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Bot not found: ${botId}`);
      let threadId;
      if (args.task_id !== void 0) {
        threadId = idArg(args, "task_id");
        if (!taskBelongsTo(bot, threadId)) throw new Error(`Task '${threadId}' does not belong to bot '${botId}'`);
        if (botTaskState(bot, threadId).busy) throw new Error("Interrupt the task or let it finish before editing a message");
      } else if (bot.busy) {
        throw new Error("Interrupt the bot or let it finish before editing a message");
      }
      const res = await fetcher(
        `/api/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(messageId)}/edit`,
        { method: "POST", body: JSON.stringify({ text, ...threadId ? { threadId } : {} }) }
      );
      return { success: true, botId, message: res?.message ?? null };
    }
    case "list_available_models": {
      const res = await fetcher("/api/instances");
      return {
        instances: records(res.instances).map((instance) => ({
          instanceId: instance.instanceId,
          driverKind: instance.driverKind,
          displayName: instance.displayName,
          snapshot: { state: instance.snapshot?.state },
          models: instance.models,
          capabilities: instance.capabilities,
          access: instance.access
        }))
      };
    }
    case "interrupt_conversation": {
      const targetType = args.target_type;
      if (targetType !== "bot" && targetType !== "channel") {
        throw new ToolInputError("target_type must be bot or channel");
      }
      const targetId = idArg(args, "target_id");
      const current = await fleet(fetcher);
      const target = (targetType === "bot" ? records(current.bots) : records(current.groups)).find((candidate) => candidate.id === targetId);
      if (!target) throw new Error(`${targetType === "bot" ? "Bot" : "Channel"} not found: ${targetId}`);
      const taskId = args.task_id === void 0 ? String(target.threadId) : idArg(args, "task_id");
      if (!taskBelongsTo(target, taskId)) throw new Error(`Task '${taskId}' does not belong to ${targetType} '${targetId}'`);
      if (targetType === "bot") {
        const busyChannel = botTaskState(target, taskId) === target && channelBusyWith(current.groups, targetId);
        if (busyChannel) {
          throw new Error(`Bot '${targetId}' is working in channel '${busyChannel.id}'; interrupt that channel instead`);
        }
      }
      const route = targetType === "bot" ? "bots" : "groups";
      await fetcher(`/api/${route}/${encodeURIComponent(targetId)}/interrupt`, {
        method: "POST",
        body: JSON.stringify({ threadId: taskId })
      });
      return { success: true, targetType, targetId, taskId };
    }
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}
function formatResponse(id, result, error) {
  const payload = { jsonrpc: "2.0", id: id ?? null };
  if (error) {
    payload.error = {
      code: error.code ?? -32603,
      message: error.message ?? "Internal error"
    };
  } else {
    payload.result = result;
  }
  return JSON.stringify(payload);
}
var activeMcpRequests = /* @__PURE__ */ new Map();
var activeMcpControllers = /* @__PURE__ */ new Set();
async function processMcpMessage(raw, toolHandler = handleToolCall) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return formatResponse(null, void 0, { code: -32700, message: "Parse error" });
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return formatResponse(null, void 0, { code: -32600, message: "Invalid Request" });
  }
  if (message.jsonrpc !== "2.0") {
    return formatResponse(null, void 0, { code: -32600, message: "Invalid Request: missing or invalid jsonrpc version" });
  }
  const hasId = "id" in message && message.id !== void 0;
  if (hasId && (typeof message.id !== "string" && typeof message.id !== "number" || typeof message.id === "number" && !Number.isFinite(message.id))) {
    return formatResponse(null, void 0, { code: -32600, message: "Invalid Request: id must be a string or number" });
  }
  const isNotification = !hasId;
  const id = isNotification ? null : message.id;
  const { method, params } = message;
  if (typeof method !== "string") {
    if (isNotification) return null;
    return formatResponse(id, void 0, { code: -32600, message: "Invalid Request: method is required" });
  }
  try {
    if (method === "notifications/cancelled") {
      if (isRecord(params)) {
        const requestId = params.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          activeMcpRequests.get(requestId)?.abort(new DOMException("Request cancelled", "AbortError"));
        }
      }
      return null;
    }
    if (method === "initialize") {
      if (isNotification) return null;
      if (!isRecord(params) || typeof params.protocolVersion !== "string" || !isRecord(params.capabilities) || !isRecord(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") {
        return formatResponse(id, void 0, {
          code: -32602,
          message: "Invalid params: protocolVersion, capabilities, and clientInfo name/version are required"
        });
      }
      const supportedVersions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
      const protocolVersion = supportedVersions.includes(params.protocolVersion) ? params.protocolVersion : supportedVersions[supportedVersions.length - 1];
      return formatResponse(id, {
        protocolVersion,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "openmausbot-mcp",
          version: "1.1.0"
        },
        instructions: "Use bounded read tools before mutating the OpenMausBot team. Approval grants, deletion, and computer lifecycle are intentionally unavailable."
      });
    }
    if (method === "notifications/initialized") {
      log("MCP client initialized session");
      return null;
    }
    if (method === "ping") {
      if (isNotification) return null;
      return formatResponse(id, {});
    }
    if (method === "tools/list") {
      if (isNotification) return null;
      return formatResponse(id, { tools: TOOLS });
    }
    if (method === "tools/call") {
      if (!isRecord(params)) {
        if (isNotification) return null;
        return formatResponse(id, void 0, { code: -32602, message: "Invalid params: tools/call expects an object" });
      }
      const name = params.name;
      const toolArgs = params.arguments === void 0 ? {} : params.arguments;
      try {
        validateToolArguments(name, toolArgs);
      } catch (error) {
        if (isNotification) return null;
        return formatResponse(id, void 0, {
          code: -32602,
          message: `Invalid params: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      const controller = new AbortController();
      activeMcpControllers.add(controller);
      if (!isNotification) activeMcpRequests.set(id, controller);
      let result;
      try {
        result = await toolHandler(name, toolArgs, request, controller.signal);
      } finally {
        activeMcpControllers.delete(controller);
        if (!isNotification && activeMcpRequests.get(id) === controller) {
          activeMcpRequests.delete(id);
        }
      }
      if (isNotification) return null;
      return formatResponse(id, {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
          }
        ],
        ...isRecord(result) ? { structuredContent: result } : {}
      });
    }
    if (isNotification) return null;
    return formatResponse(id, void 0, { code: -32601, message: `Method not found: ${method}` });
  } catch (err) {
    if ((err?.name === "AbortError" || err?.message === "Request cancelled") && !isNotification) {
      return formatResponse(id, void 0, { code: -32800, message: "Request cancelled" });
    }
    log(`Error handling ${method}: ${err?.message || err}`);
    if (err instanceof ToolInputError && !isNotification) {
      return formatResponse(id, void 0, { code: -32602, message: `Invalid params: ${err.message}` });
    }
    if (!isNotification) {
      return formatResponse(id, {
        content: [
          {
            type: "text",
            text: `Error: ${err?.message || String(err)}`
          }
        ],
        isError: true
      });
    }
    return null;
  }
}
function runStdio() {
  log("OpenMausBot MCP server running on stdio");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });
  const activeRequests = /* @__PURE__ */ new Set();
  rl.on("line", (line) => {
    const task = (async () => {
      try {
        const response = await processMcpMessage(line);
        if (response) {
          process.stdout.write(response + "\n");
        }
      } catch (err) {
        log(`Error processing line: ${err}`);
      }
    })();
    activeRequests.add(task);
    task.finally(() => {
      activeRequests.delete(task);
    });
  });
  return new Promise((closed) => rl.on("close", async () => {
    for (const controller of activeMcpControllers) {
      controller.abort(new DOMException("Request cancelled", "AbortError"));
    }
    if (activeRequests.size > 0) {
      await Promise.allSettled(Array.from(activeRequests));
    }
    process.exitCode = 0;
    closed();
  }));
}
if (process.argv[1] && (process.argv[1].endsWith("mcp-server.ts") || process.argv[1].endsWith("mcp-server.js"))) void runStdio();
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  OMB_BASE_URL,
  OpenMausBotApiError,
  TOOLS,
  ToolInputError,
  formatResponse,
  handleToolCall,
  log,
  probeBaseUrls,
  processMcpMessage,
  request,
  resolveBaseUrl,
  runStdio,
  validateBaseUrl,
  validateToolArguments,
  waitForJob
};
