// server/drivers/pi-mcp-extension.ts
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// packages/phone-protocol/src/agents-tool-names.ts
var given = (args, key) => args[key] !== void 0 && args[key] !== null;
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var AGENTS_ACTION_TOOLS = {
  trigger_info: { members: ["list_triggers", "list_trigger_events"], member: (args) => args.action === "events" ? "list_trigger_events" : "list_triggers" },
  trigger: { members: ["create_trigger", "manage_trigger"], member: (args) => args.action === "create" ? "create_trigger" : "manage_trigger" },
  delete_trigger: { members: ["manage_trigger"], member: () => "manage_trigger" },
  manage_room: { members: ["manage_room", "create_room"], member: (args) => args.action === "create" ? "create_room" : "manage_room" },
  session_search: { members: ["session_search", "session_read"], member: (args) => given(args, "thread_id") || given(args, "message_id") ? "session_read" : "session_search" },
  show_widget: { members: ["show_widget", "update_widget"], member: (args) => given(args, "widget_id") ? "update_widget" : "show_widget" },
  show_html: { members: ["show_html", "update_html"], member: (args) => given(args, "app_id") ? "update_html" : "show_html" },
  x_search: {
    members: ["x_search", "x_user_posts", "x_post", "x_profile"],
    member: (args) => args.action === "user_posts" ? "x_user_posts" : args.action === "post" ? "x_post" : args.action === "profile" ? "x_profile" : "x_search"
  }
};
var as = (name, args) => ({ name, arguments: args });
var required = (args, key) => ({ ...args, [key]: args[key] ?? "" });
var AGENTS_TOOL_ALIASES = {
  list_triggers: { tools: ["trigger_info"], resolve: (args) => as("trigger_info", { ...args, action: "list" }) },
  list_trigger_events: { tools: ["trigger_info"], resolve: (args) => as("trigger_info", { ...args, action: "events" }) },
  create_trigger: { tools: ["trigger"], resolve: (args) => as("trigger", { ...args, action: "create" }) },
  manage_trigger: {
    tools: ["trigger", "delete_trigger"],
    resolve: ({ changes, ...args }) => {
      const fields = record(changes) ? changes : {};
      if (args.action === "delete") {
        const { action: _delete, ...target } = args;
        return as("delete_trigger", { ...fields, ...target });
      }
      return as("trigger", { ...fields, ...args, action: args.action === "create" ? void 0 : args.action });
    }
  },
  create_room: { tools: ["manage_room"], resolve: (args) => as("manage_room", { ...args, action: "create" }) },
  session_read: { tools: ["session_search"], resolve: (args) => as("session_search", required(required(args, "thread_id"), "message_id")) },
  update_widget: { tools: ["show_widget"], resolve: (args) => as("show_widget", required(args, "widget_id")) },
  update_html: { tools: ["show_html"], resolve: (args) => as("show_html", required(args, "app_id")) },
  x_user_posts: { tools: ["x_search"], resolve: (args) => as("x_search", { ...args, action: "user_posts" }) },
  x_post: { tools: ["x_search"], resolve: (args) => as("x_search", { ...args, action: "post" }) },
  x_profile: { tools: ["x_search"], resolve: (args) => as("x_search", { ...args, action: "profile" }) }
};
var aliasOf = (name) => Object.hasOwn(AGENTS_TOOL_ALIASES, name) ? AGENTS_TOOL_ALIASES[name] : void 0;
var actionToolOf = (name) => Object.hasOwn(AGENTS_ACTION_TOOLS, name) ? AGENTS_ACTION_TOOLS[name] : void 0;
function agentsCallMember(tool, args) {
  return actionToolOf(tool)?.member(record(args) ? args : {}) ?? tool;
}
function named(tool, member) {
  return actionToolOf(tool)?.members.includes(tool) ? [member] : [tool, member];
}
function agentsCallIdentities(name, args) {
  const alias = aliasOf(name);
  if (alias) {
    if (args === void 0) return alias.tools.map((tool2) => named(tool2, name));
    const call = alias.resolve(record(args) ? args : {});
    return [named(call.name, agentsCallMember(call.name, call.arguments))];
  }
  const tool = actionToolOf(name);
  if (!tool) return [[name]];
  return args === void 0 ? tool.members.map((member) => named(name, member)) : [named(name, tool.member(record(args) ? args : {}))];
}

// packages/phone-protocol/src/phone-steps.ts
var PHONE_STEP_TOOLS = ["open_app", "tap_text", "tap", "swipe", "type_text", "press", "read_screen"];

// packages/phone-protocol/src/tool-scope.ts
var SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
var CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
var MAX_SELECTORS = 256;
var MAX_SELECTOR_LENGTH = 1024;
function validName(name) {
  return typeof name === "string" && name.trim().length > 0 && name.length <= MAX_SELECTOR_LENGTH && !CONTROL_CHARACTER.test(name) && !name.includes("*");
}
function selectorIdentity(selector) {
  if (selector.length > MAX_SELECTOR_LENGTH || CONTROL_CHARACTER.test(selector)) return;
  if (selector.startsWith("native:")) {
    const name = selector.slice(7);
    if (name === "*" || validName(name)) return { kind: "native", name };
  } else if (selector.startsWith("mcp:")) {
    const separator = selector.indexOf(":", 4);
    if (separator < 0) return;
    const server = selector.slice(4, separator);
    const name = selector.slice(separator + 1);
    if (SERVER_NAME.test(server) && (name === "*" || validName(name))) {
      return { kind: "mcp", server, name };
    }
  }
}
function parseToolScope(value) {
  if (value === void 0) return { ok: true, scope: void 0 };
  const invalid = { ok: false, error: "Tool selection must contain only valid allow and deny lists." };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid;
  const scope = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "allow" && key !== "deny") return invalid;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return invalid;
    const list = descriptor.value;
    if (!Array.isArray(list) || list.length > MAX_SELECTORS) return invalid;
    if (!Array.from(list).every((entry) => typeof entry === "string" && selectorIdentity(entry))) return invalid;
    scope[key] = [...new Set(list)];
  }
  return { ok: true, scope };
}
function matches(selector, tool, names = [tool.name]) {
  const selected = selectorIdentity(selector);
  return selected?.kind === tool.kind && (selected.kind !== "mcp" || tool.kind === "mcp" && selected.server === tool.server) && (selected.name === "*" || names.includes(selected.name));
}
function permitsNamed(scope, tool, names) {
  return (scope?.allow === void 0 || scope.allow.some((selector) => matches(selector, tool, names))) && !scope?.deny?.some((selector) => matches(selector, tool, names));
}
function permits(scope, tool, args) {
  if (!validName(tool.name) || tool.kind === "mcp" && !SERVER_NAME.test(tool.server)) return false;
  if (tool.kind === "mcp" && tool.server === "phone" && tool.name === "batch") {
    return ["batch", ...PHONE_STEP_TOOLS].every((name) => permitsNamed(scope, tool, [name]));
  }
  const named2 = tool.kind === "mcp" && tool.server === "agents" ? agentsCallIdentities(tool.name, args) : [[tool.name]];
  return named2.some((names) => permitsNamed(scope, tool, names));
}
function allowsTool(scope, tool, args) {
  const parsed = parseToolScope(scope);
  return parsed.ok && permits(parsed.scope, tool, args);
}
function canUseMcpServer(scope, server, names) {
  const parsed = parseToolScope(scope);
  if (!parsed.ok || !SERVER_NAME.test(server)) return false;
  if (names !== void 0) {
    return names.some((name) => permits(parsed.scope, { kind: "mcp", server, name }));
  }
  if (parsed.scope?.deny?.includes(`mcp:${server}:*`)) return false;
  if (parsed.scope?.allow === void 0) return true;
  return parsed.scope.allow.some((selector) => {
    const selected = selectorIdentity(selector);
    return selected?.kind === "mcp" && selected.server === server && (selected.name === "*" || permits(parsed.scope, selected));
  });
}

// packages/phone-protocol/src/ask-question.ts
var MAX_QUESTIONS = 6;
var MAX_OPTIONS = 12;
var MAX_QUESTION_TEXT = 8e3;
var MAX_LABEL = 120;
var MAX_DESCRIPTION = 400;
var MAX_CUSTOM_ANSWER = 2e3;
function text(value, limit) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit).trim() : void 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseOption(value) {
  if (typeof value === "string") {
    const label2 = text(value, MAX_LABEL);
    return label2 ? { label: label2 } : null;
  }
  if (!isRecord(value)) return null;
  const label = text(value.label, MAX_LABEL);
  if (!label) return null;
  const description = text(value.description, MAX_DESCRIPTION);
  return description ? { label, description } : { label };
}
function parseQuestion(value) {
  if (!isRecord(value)) return null;
  const question = text(value.question, MAX_QUESTION_TEXT);
  if (!question) return null;
  const options = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of Array.isArray(value.options) ? value.options : []) {
    const option = parseOption(raw);
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push(option);
    if (options.length === MAX_OPTIONS) break;
  }
  const header = text(value.header, MAX_LABEL);
  return {
    question,
    ...header ? { header } : {},
    ...value.multiSelect === true ? { multiSelect: true } : {},
    options,
    // only meaningful beside options: with none, free text is the only answer
    ...value.custom === false && options.length ? { custom: false } : {}
  };
}
function parseAskQuestions(input) {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const questions = [];
  for (const raw of input.questions) {
    const question = parseQuestion(raw);
    if (!question) continue;
    questions.push(question);
    if (questions.length === MAX_QUESTIONS) break;
  }
  return questions.length ? questions : null;
}
var ASK_USER_TOOL = "ask_user";
var ANSWER_PREAMBLE = "The user answered your questions.";
var JSON_ANSWERS_PREFIX = `${ANSWER_PREAMBLE}

Answers (JSON):
`;
function formatQuestionAnswers(questions, answers) {
  const pairs = [];
  questions.forEach((question, index) => {
    const picked = (answers[index] ?? []).map((value) => value.trim()).filter(Boolean);
    if (!picked.length) return;
    pairs.push([question.question, picked.join(", ")]);
  });
  if (!pairs.length) return "";
  if (pairs.some((pair) => pair.some((value) => /[\r\n]/.test(value)))) {
    return JSON_ANSWERS_PREFIX + JSON.stringify(pairs);
  }
  return `${ANSWER_PREAMBLE}

${pairs.map(([question, answer]) => `Q: ${question}
A: ${answer}`).join("\n\n")}`;
}
var MAX_ANSWER_ECHO = ANSWER_PREAMBLE.length + MAX_QUESTIONS * ("\n\nQ: \nA: ".length + MAX_QUESTION_TEXT + MAX_OPTIONS * (MAX_LABEL + ", ".length) + MAX_CUSTOM_ANSWER);

// server/mcp-directory.ts
var SEARCH_TOOL = "search_tools";
var DESCRIBE_TOOL = "describe_tool";
var CALL_TOOL = "call_tool";
var DIRECTORY_TOOLS = /* @__PURE__ */ new Set([SEARCH_TOOL, DESCRIBE_TOOL, CALL_TOOL]);
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isDirectoryTool(name) {
  return typeof name === "string" && DIRECTORY_TOOLS.has(name);
}
function directoryCallTarget(name, args) {
  if (name === SEARCH_TOOL || name === DESCRIBE_TOOL) return void 0;
  if (name !== CALL_TOOL) return name;
  const target = isRecord2(args) ? args.name : void 0;
  return typeof target === "string" && target.trim() ? target : void 0;
}
var FIELD_WEIGHTS = { name: 2, text: 1, schema: 0.5 };
var FIELDS = Object.keys(FIELD_WEIGHTS);
var AREA_WEIGHT = FIELD_WEIGHTS.name;
var HOW_TO_SEARCH = `Find tool names with ${SEARCH_TOOL}({ "query": "what you want to do" }), then run one with ${CALL_TOOL}({ "name": "...", "arguments": {...} }).`;
var encoder = new TextEncoder();
var ANNOTATIONS = /* @__PURE__ */ new Set(["examples", "example", "default", "$comment"]);
var ANNOTATIONS_AND_WORDS = /* @__PURE__ */ new Set([...ANNOTATIONS, "description", "title"]);

// server/mcp-http.ts
var MAX_REMOTE_MCP_BYTES = 32 * 1024 * 1024;
var REMOTE_MCP_STARTUP_MS = 3e4;

// server/drivers/agents-tool-limit.ts
var AGENTS_TOOL_TIMEOUT_SECONDS = 960;

// server/drivers/pi-mcp-extension.ts
var MCP_STARTUP_TIMEOUT_MS = 8e3;
var MCP_TOOL_TIMEOUT_MS = AGENTS_TOOL_TIMEOUT_SECONDS * 1e3;
var MCP_MAX_LIST_PAGES = 100;
var MCP_MAX_FRAME_BYTES = 32 * 1024 * 1024;
var TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
var TOOL_OUTPUT_MAX_LINES = 2e3;
var TOOL_NAME_MAX_LENGTH = 64;
var StdioMcp = class {
  child;
  buf = "";
  nextId = 1;
  disposed = false;
  pending = /* @__PURE__ */ new Map();
  remote;
  listDeadline;
  constructor(def) {
    this.remote = def.directory === true;
    this.child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...def.env }
    });
    this.child.stderr.on("data", () => {
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.on("error", (err) => this.closeWithError(err));
    this.child.on("exit", (code) => this.closeWithError(new Error(`MCP server exited (code ${code ?? "?"})`)));
    this.child.stdin.on("error", () => this.closeWithError(new Error("MCP server stdin closed")));
  }
  failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
  closeWithError(err) {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(err);
    try {
      this.child.kill();
    } catch {
    }
  }
  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MCP_MAX_FRAME_BYTES) {
        this.closeWithError(new Error(`MCP frame exceeded ${MCP_MAX_FRAME_BYTES} bytes`));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
        continue;
      }
      if (msg.id !== void 0 && typeof msg.method === "string") {
        try {
          this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Client method not supported" } });
        } catch (err) {
          this.closeWithError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
    }
    if (Buffer.byteLength(this.buf, "utf8") > MCP_MAX_FRAME_BYTES) {
      this.closeWithError(new Error(`MCP frame exceeded ${MCP_MAX_FRAME_BYTES} bytes without a newline`));
    }
  }
  write(frame) {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("MCP server stdin is closed");
    }
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }
  call(method, params, timeoutMs, signal) {
    if (this.disposed) return Promise.reject(new Error("MCP client is closed"));
    if (signal?.aborted) return Promise.reject(new Error(`MCP ${method} aborted`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const cancel = (reason) => {
        this.pending.delete(id);
        try {
          this.notify("notifications/cancelled", { requestId: id, reason });
        } catch {
        }
        settle(() => reject(new Error(reason)));
      };
      const onAbort = () => cancel(`MCP ${method} aborted`);
      const timer = setTimeout(() => cancel(`MCP ${method} timed out after ${timeoutMs}ms`), timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (err) => settle(() => reject(err))
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }
  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  async init() {
    const budget = this.remote ? REMOTE_MCP_STARTUP_MS : MCP_STARTUP_TIMEOUT_MS;
    this.listDeadline = this.remote ? Date.now() + budget : void 0;
    await this.call(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openmausbot-pi", version: "1" }
      },
      budget
    );
    this.notify("notifications/initialized");
  }
  async listTools() {
    const tools = [];
    const seenCursors = /* @__PURE__ */ new Set();
    const deadline = this.listDeadline ?? Date.now() + MCP_STARTUP_TIMEOUT_MS;
    let cursor;
    for (let page = 0; page < MCP_MAX_LIST_PAGES; page += 1) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const res = await this.call(
        "tools/list",
        cursor ? { cursor } : {},
        remainingMs
      );
      if (!Array.isArray(res?.tools)) throw new Error("MCP tools/list returned no tools array");
      tools.push(...res.tools);
      if (typeof res.nextCursor !== "string" || !res.nextCursor) return tools;
      if (seenCursors.has(res.nextCursor)) throw new Error("MCP tools/list repeated a pagination cursor");
      seenCursors.add(res.nextCursor);
      cursor = res.nextCursor;
    }
    throw new Error(`MCP tools/list exceeded ${MCP_MAX_LIST_PAGES} pages`);
  }
  /** Text is bounded so a remote server cannot flood the model context. */
  async callTool(name, args, signal) {
    const res = await this.call(
      "tools/call",
      { name, arguments: args ?? {} },
      MCP_TOOL_TIMEOUT_MS,
      signal
    );
    const rawContent = Array.isArray(res?.content) ? res.content : [];
    const text2 = rawContent.filter((c) => Boolean(c) && c.type === "text").map((c) => String(c.text ?? "")).join("\n");
    const images = rawContent.filter(
      (c) => Boolean(c) && c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string"
    ).map((c) => ({ type: "image", data: String(c.data), mimeType: String(c.mimeType) }));
    const unsupported = rawContent.length - rawContent.filter((c) => c?.type === "text").length - images.length;
    let boundedText = truncateToolText(text2 || (images.length ? "" : "(empty result)"));
    if (unsupported > 0) boundedText += `${boundedText ? "\n" : ""}[${unsupported} unsupported MCP content item(s) omitted]`;
    return {
      content: [...boundedText ? [{ type: "text", text: boundedText }] : [], ...images],
      isError: Boolean(res?.isError)
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("MCP client disposed"));
    try {
      this.child.kill();
    } catch {
    }
  }
};
var SCHEMA_OPTION_KEYS = [
  "title",
  "description",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties"
];
function schemaOptions(schema) {
  const options = {};
  for (const key of SCHEMA_OPTION_KEYS) {
    const value = schema[key];
    if (value !== void 0) Reflect.set(options, key, value);
  }
  return options;
}
function isSchemaObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function primitiveLiteral(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Type.Literal(value);
  }
  if (value === null) return Type.Null();
  return null;
}
function withNullable(schema, nullable) {
  return nullable === true ? Type.Union([schema, Type.Null()]) : schema;
}
function collectObjectShape(schema) {
  const properties = {};
  const required2 = /* @__PURE__ */ new Set();
  const visit = (candidate, mode) => {
    if (!isSchemaObject(candidate)) return;
    for (const branch of candidate.allOf ?? []) visit(branch, mode === "choice" ? "choice" : "all");
    for (const branch of [...candidate.anyOf ?? [], ...candidate.oneOf ?? []]) visit(branch, "choice");
    for (const [key, value] of Object.entries(candidate.properties ?? {})) {
      if (mode === "root" || properties[key] === void 0) properties[key] = value;
    }
    if (mode !== "choice" && Array.isArray(candidate.required)) {
      for (const key of candidate.required) if (typeof key === "string") required2.add(key);
    }
  };
  visit(schema, "root");
  return { properties, required: required2 };
}
function objectSchema(schema, root = false) {
  const { properties, required: required2 } = collectObjectShape(schema);
  const converted = {};
  for (const [key, value] of Object.entries(properties)) {
    const nested = nestedTypebox(value);
    converted[key] = required2.has(key) ? nested : Type.Optional(nested);
  }
  const options = schemaOptions(schema);
  if (typeof schema.additionalProperties === "boolean") {
    options.additionalProperties = schema.additionalProperties;
  } else if (isSchemaObject(schema.additionalProperties)) {
    options.additionalProperties = nestedTypebox(schema.additionalProperties);
  }
  const object = Type.Object(converted, options);
  return root ? object : withNullable(object, schema.nullable);
}
function nestedTypebox(schema) {
  if (!isSchemaObject(schema)) return Type.Any();
  const options = schemaOptions(schema);
  const literal = primitiveLiteral(schema.const);
  if (literal) return withNullable(literal, schema.nullable);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.every((value) => typeof value === "string")) {
      return withNullable(Type.String({ ...options, enum: schema.enum }), schema.nullable);
    }
    const literals = schema.enum.map(primitiveLiteral).filter((value) => value !== null);
    if (literals.length === schema.enum.length) {
      const union = literals.length === 1 ? literals[0] : Type.Union(literals, options);
      return withNullable(union, schema.nullable);
    }
  }
  if (Array.isArray(schema.type)) {
    const variants = schema.type.map((type) => nestedTypebox({ ...schema, type, nullable: false }));
    return variants.length === 1 ? variants[0] : Type.Union(variants, options);
  }
  if (schema.type === "object" || schema.properties) return objectSchema(schema);
  const choice = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(choice) && choice.length > 0) {
    const variants = choice.map(nestedTypebox);
    return withNullable(variants.length === 1 ? variants[0] : Type.Union(variants, options), schema.nullable);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const variants = schema.allOf.map(nestedTypebox);
    return withNullable(variants.length === 1 ? variants[0] : Type.Intersect(variants, options), schema.nullable);
  }
  switch (schema.type) {
    case "string":
      return withNullable(Type.String(options), schema.nullable);
    case "number":
      return withNullable(Type.Number(options), schema.nullable);
    case "integer":
      return withNullable(Type.Integer(options), schema.nullable);
    case "boolean":
      return withNullable(Type.Boolean(options), schema.nullable);
    case "null":
      return Type.Null();
    case "array": {
      const tupleItems = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : void 0);
      const value = tupleItems ? Type.Tuple(tupleItems.map(nestedTypebox), options) : Type.Array(schema.items ? nestedTypebox(schema.items) : Type.Any(), options);
      return withNullable(value, schema.nullable);
    }
    default:
      return Type.Any();
  }
}
function toTypebox(schema) {
  return objectSchema(isSchemaObject(schema) ? schema : {}, true);
}
function sanitizeToolName(server, tool) {
  const raw = `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return raw.slice(0, TOOL_NAME_MAX_LENGTH) || "mcp_tool";
}
function allocateToolName(server, tool, used) {
  const base = sanitizeToolName(server, tool);
  let candidate = base;
  for (let suffixNumber = 2; used.has(candidate); suffixNumber += 1) {
    const suffix = `_${suffixNumber}`;
    candidate = `${base.slice(0, Math.max(1, TOOL_NAME_MAX_LENGTH - suffix.length))}${suffix}`;
  }
  return candidate;
}
function truncateToolText(text2) {
  const lines = text2.split("\n");
  const lineLimited = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\n");
  const bytes = Buffer.from(lineLimited, "utf8");
  let byteEnd = Math.min(bytes.length, TOOL_OUTPUT_MAX_BYTES);
  while (byteEnd > 0 && byteEnd < bytes.length && (bytes[byteEnd] & 192) === 128) byteEnd -= 1;
  const content = bytes.subarray(0, byteEnd).toString("utf8");
  const truncatedByLines = lines.length > TOOL_OUTPUT_MAX_LINES;
  const truncatedByBytes = bytes.length > TOOL_OUTPUT_MAX_BYTES;
  if (!truncatedByLines && !truncatedByBytes) return content;
  const reasons = [
    ...truncatedByLines ? [`${TOOL_OUTPUT_MAX_LINES}-line limit`] : [],
    ...truncatedByBytes ? [`${TOOL_OUTPUT_MAX_BYTES / 1024}KB limit`] : []
  ];
  return `${content}

[MCP output truncated: ${reasons.join(" and ")}. Refine the request for less output.]`;
}
function summarizeParams(params) {
  try {
    const s = JSON.stringify(params ?? {});
    return s === "{}" ? "" : s.slice(0, 300);
  } catch {
    return "";
  }
}
var ASK_USER_NOT_ANSWERED = "The person did not answer this question. Do not guess an answer; ask again later or proceed without it.";
function askUserTool(allowed) {
  return {
    name: ASK_USER_TOOL,
    label: "Ask the person",
    description: "Ask the person questions when the decision is theirs. Offer concrete options where they exist; they can always answer in their own words. Ask up to six questions in one call rather than one at a time. Each question takes one answer.",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String({ description: "The question to show the person." }),
        options: Type.Optional(Type.Array(
          Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }),
          { maxItems: MAX_OPTIONS, description: "Suggested answers; the person picks one or writes their own." }
        ))
      }), { minItems: 1, maxItems: MAX_QUESTIONS })
    }),
    exposure: "model-only",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!allowed()) throw new Error("Tool selection excludes this tool");
      const raw = params?.questions;
      if (Array.isArray(raw) && raw.some((entry) => entry?.multiSelect === true)) {
        throw new Error("This engine takes one answer per question. Ask a single-choice question instead; the person can still name several things in their own words.");
      }
      const questions = parseAskQuestions(params);
      if (!questions) {
        throw new Error("The ask_user arguments are malformed: pass a questions array of one to six questions, each with a question string and at most twelve options carrying a label. Ask again with valid arguments.");
      }
      const answers = [];
      for (const question of questions) {
        const labels = question.options.map((option) => option.label);
        const described = question.options.filter((option) => option.description);
        const title = described.length ? `${question.question}

${described.map((option) => `${option.label}: ${option.description}`).join("\n")}` : question.question;
        const answer = labels.length ? await ctx.ui.select?.(title, labels, { signal }) : await ctx.ui.input?.(question.question, void 0, { signal });
        if (!answer?.trim()) break;
        answers.push([answer.trim()]);
      }
      if (!answers.length) throw new Error(ASK_USER_NOT_ANSWERED);
      const unanswered = answers.length < questions.length ? "\n\nThe person did not answer the other questions. Do not guess their answers." : "";
      return { content: [{ type: "text", text: formatQuestionAnswers(questions, answers) + unanswered }], details: {} };
    }
  };
}
async function pi_mcp_extension_default(pi) {
  const configPath = process.env.OMB_MCP_CONFIG;
  if (!configPath) return;
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("OpenMausBot Pi MCP configuration could not be read");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("OpenMausBot Pi MCP configuration is invalid");
  const parsed = parseToolScope(config.toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const scope = parsed.scope;
  if (scope !== void 0 && (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function")) throw new Error("Pi tool selection enforcement APIs are unavailable");
  const used = /* @__PURE__ */ new Set();
  const identities = /* @__PURE__ */ new Map();
  const directoryTools = /* @__PURE__ */ new Map();
  let enforcementFailed = false;
  const clients = [];
  const serverEntries = Object.entries(config.mcpServers ?? {}).filter(([name]) => scope === void 0 || canUseMcpServer(scope, name));
  if (scope !== void 0) {
    const allowed = (name) => directoryTools.has(name) ? canUseMcpServer(scope, directoryTools.get(name)) : allowsTool(scope, identities.get(name) ?? { kind: "native", name });
    const intersect = () => {
      if (enforcementFailed) throw new Error("Pi tool selection enforcement is unavailable");
      try {
        const active = pi.getActiveTools();
        if (!Array.isArray(active) || active.some((name) => typeof name !== "string")) throw new Error("Pi tool selection enforcement returned an invalid catalog");
        const requested = new Set(active.filter(allowed));
        pi.setActiveTools([...requested]);
        const selected = pi.getActiveTools();
        if (!Array.isArray(selected) || selected.some((name) => !requested.has(name))) throw new Error("Pi tool selection enforcement did not apply the active-tool restriction");
        if (config.scopeReadyPath) writeFileSync(config.scopeReadyPath, JSON.stringify({ ok: true, toolScope: scope }), { mode: 384 });
        return selected;
      } catch (error) {
        enforcementFailed = true;
        if (config.scopeReadyPath) {
          try {
            writeFileSync(config.scopeReadyPath, JSON.stringify({ ok: false }), { mode: 384 });
          } catch {
          }
        }
        throw error;
      }
    };
    for (const event of ["session_start", "session_switch", "model_select", "before_agent_start", "context"]) pi.on(event, () => {
      intersect();
    });
    pi.on("tool_call", (event) => !enforcementFailed && typeof event?.toolName === "string" && allowed(event.toolName) ? void 0 : { block: true, reason: "Tool selection excludes this tool" });
    pi.on("before_provider_request", (event, context) => {
      let selected = /* @__PURE__ */ new Set();
      try {
        selected = new Set(intersect());
      } catch {
        try {
          context?.abort?.();
        } catch {
        }
      }
      const declared = (name) => selected.has(name) && allowed(name);
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") return payload;
      const body = payload;
      if (Array.isArray(body.tools)) body.tools = body.tools.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const tool = value;
        if (Array.isArray(tool.functionDeclarations)) {
          const functionDeclarations = tool.functionDeclarations.filter((declaration) => typeof declaration.name === "string" && declared(declaration.name));
          return functionDeclarations.length ? [{ ...tool, functionDeclarations }] : [];
        }
        const name = tool.function?.name ?? tool.name;
        return typeof name === "string" && declared(name) ? [tool] : [];
      });
      return payload;
    });
  }
  if (config.askUser === true) {
    const identity = { kind: "native", name: ASK_USER_TOOL };
    if (scope === void 0 || allowsTool(scope, identity)) {
      pi.registerTool(askUserTool(() => scope === void 0 || !enforcementFailed && allowsTool(scope, identity)));
      used.add(ASK_USER_TOOL);
    }
  }
  const mounts = await Promise.all(
    serverEntries.map(async ([serverName, def]) => {
      if (!def || typeof def.command !== "string" || !def.command.trim()) return { serverName };
      let client;
      try {
        client = new StdioMcp(def);
        await client.init();
        return { serverName, def, client, tools: await client.listTools() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openmausbot-pi-mcp] ${serverName}: ${message}
`);
        client?.dispose();
        return { serverName };
      }
    })
  );
  for (const mount of mounts) {
    if (!mount.client || !mount.def || !mount.tools) continue;
    const { serverName, def, client, tools } = mount;
    const gated = def.scope === "local-computer" || def.scope === "custom" && config.approvalMode !== "full";
    let registered = 0;
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
        process.stderr.write(`[openmausbot-pi-mcp] ${serverName}: skipped a tool with no valid name
`);
        continue;
      }
      const toolName = tool.name;
      const identity = { kind: "mcp", server: serverName, name: toolName };
      const directoryTool = def.directory === true && isDirectoryTool(toolName);
      if (scope !== void 0 && !directoryTool && !allowsTool(scope, identity)) continue;
      const name = allocateToolName(serverName, toolName, used);
      try {
        const parameters = toTypebox(tool.inputSchema);
        pi.registerTool({
          name,
          label: `${serverName}:${toolName}`,
          description: typeof tool.description === "string" ? tool.description : `${toolName} (MCP tool from ${serverName})`,
          parameters,
          async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const target = directoryTool ? directoryCallTarget(toolName, params) : toolName;
            if (scope !== void 0 && (enforcementFailed || target !== void 0 && !allowsTool(
              scope,
              { kind: "mcp", server: serverName, name: target },
              (directoryTool && toolName === CALL_TOOL ? params?.arguments : params) ?? {}
            ))) {
              throw new Error("Tool selection excludes this tool");
            }
            if (gated && target !== void 0) {
              const shown = target;
              const detail = summarizeParams(directoryTool && toolName === CALL_TOOL ? params?.arguments : params);
              const allowed = await ctx.ui.confirm(
                def.scope === "local-computer" ? `Allow ${shown} on your computer?` : `Allow ${serverName}:${shown}?`,
                detail || `Run ${serverName}:${shown}`
              );
              if (!allowed) {
                return { content: [{ type: "text", text: "Blocked by the user." }], details: {} };
              }
            }
            const res = await client.callTool(toolName, params, signal);
            if (res.isError) {
              const message = res.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
              throw new Error(message || `MCP tool ${serverName}:${toolName} returned an error`);
            }
            return { content: res.content, details: {} };
          }
        });
        used.add(name);
        identities.set(name, identity);
        if (directoryTool) directoryTools.set(name, serverName);
        registered += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openmausbot-pi-mcp] ${serverName}:${toolName}: ${message}
`);
      }
    }
    if (registered > 0) clients.push(client);
    else client.dispose();
  }
  pi.on("session_shutdown", () => {
    for (const c of clients) c.dispose();
    clients.length = 0;
  });
}
export {
  StdioMcp,
  allocateToolName,
  pi_mcp_extension_default as default,
  toTypebox,
  truncateToolText
};
