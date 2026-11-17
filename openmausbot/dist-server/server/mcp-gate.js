// stdout is the MCP transport. Never log there.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { allowsTool, parseToolScope } from "../shared/tool-scope.js";
import { bridgedCallTarget } from "./drivers/agents-bridge.js";
import { resolveCliSpawn } from "./env-path.js";
import { APP_ONLY_REFUSAL, AppObserver, GATE_APPS_ENV, modelVisible, parseAppMount, withUiExtension } from "./mcp-app-observer.js";
import { directoryCallTarget, isDirectoryTool } from "./mcp-directory.js";
import { QUERY_TOOL, QUERY_TOOL_NAME, ResultStore, answerQuery, describeShape, exampleQuery } from "./mcp-shape.js";
import { fitToolList } from "./mcp-tool-schema.js";
import { DEFAULT_RESULT_BUDGET, trimResultText, trimStructured } from "./mcp-trim.js";
import { descendantsOf, signalTree, stopTree } from "./proc-descendants.js";
import { killCliTree } from "./procs.js";
import { toolSchemaProfileFromEnv } from "./tool-schema-profile.js";
import { capToolListResult, toolLimitFromEnv } from "./tool-count-limit.js";
/** Codex imports env from one shared app-server environment: each mount names its own record, and only that name reaches argv. */
function gateEnvironment() {
    if (process.argv.length === 2)
        return process.env;
    try {
        const key = process.argv[3];
        if (process.argv.length !== 4 || process.argv[2] !== "--config-env" || !key || !/^OMB_GATE_CONFIG_[a-f0-9]{64}$/.test(key))
            throw new Error();
        const value = JSON.parse(process.env[key] ?? "");
        if (!value || typeof value !== "object" || Array.isArray(value)
            || !["OMB_GATE_NAME", "OMB_GATE_UPSTREAM"].every(name => typeof value[name] === "string")
            || (typeof value.OMB_GATE_TOOL_SCOPE !== "string" && typeof value[GATE_APPS_ENV] !== "string")
            || !Object.entries(value).every(([name, setting]) => GATE_ENV_KEYS.includes(name) && typeof setting === "string"))
            throw new Error();
        return value;
    }
    catch {
        process.stderr.write("mcp-gate: invalid private configuration\n");
        process.exit(1);
    }
}
/** The gate's own settings never reach the upstream server's environment. */
const GATE_ENV_KEYS = ["OMB_GATE_NAME", "OMB_GATE_SPILL_DIR", "OMB_GATE_BUDGET", "OMB_GATE_UPSTREAM", "OMB_GATE_SPILL_HINT", "OMB_GATE_TOOL_SCOPE", "OMB_GATE_DIRECTORY", GATE_APPS_ENV];
const gateEnv = gateEnvironment();
const NAME = gateEnv.OMB_GATE_NAME || "mcp";
const SPILL_DIR = gateEnv.OMB_GATE_SPILL_DIR || "";
const rawBudget = Number(gateEnv.OMB_GATE_BUDGET);
const BUDGET = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : DEFAULT_RESULT_BUDGET;
const SPILL_MAX_AGE_MS = 24 * 60 * 60_000;
const SPILL_HINT = gateEnv.OMB_GATE_SPILL_HINT === "1";
const DIRECTORY = gateEnv.OMB_GATE_DIRECTORY === "1";
const SCHEMA_PROFILE = toolSchemaProfileFromEnv(process.env);
const TOOL_LIMIT = toolLimitFromEnv(process.env);
function fail(message) {
    process.stderr.write(`mcp-gate(${NAME}): ${message}\n`);
    process.exit(1);
}
function toolScope() {
    const raw = gateEnv.OMB_GATE_TOOL_SCOPE;
    if (raw === undefined)
        return;
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        fail("invalid tool selection JSON");
    }
    const parsed = parseToolScope(value);
    if (!parsed.ok || parsed.scope === undefined)
        fail("invalid tool selection; check the bot's Access settings");
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(NAME))
        fail("invalid MCP server identity for tool selection");
    return parsed.scope;
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function requestKey(id) {
    return typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
        ? `${typeof id}:${id}` : undefined;
}
function rejectRequest(id, code, message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestKey(id) ? id : null, error: { code, message } })}\n`);
}
function upstreamSpec() {
    let parsed;
    try {
        parsed = JSON.parse(gateEnv.OMB_GATE_UPSTREAM ?? "");
    }
    catch {
        fail("OMB_GATE_UPSTREAM is not valid JSON");
    }
    const spec = parsed;
    if (!spec || typeof spec !== "object" || typeof spec.command !== "string" || !spec.command) {
        fail("OMB_GATE_UPSTREAM needs a command");
    }
    return spec;
}
function sweepSpill(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return;
    }
    const cutoff = Date.now() - SPILL_MAX_AGE_MS;
    for (const entry of entries) {
        try {
            const path = join(dir, entry);
            if (statSync(path).mtimeMs < cutoff)
                rmSync(path, { force: true });
        }
        catch {
        }
    }
}
let spilled = 0;
/** Whole results the model can query instead of re-reading: one gate, one MCP connection, one session. */
const store = new ResultStore();
/** Keep the parsed payload for query_result; only a JSON result can be queried, text is cut as before. */
function hold(tool, text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (value === null || typeof value !== "object")
        return undefined;
    const handle = store.put(tool, value, Buffer.byteLength(text, "utf8"));
    return { handle, shape: describeShape(value), example: exampleQuery(value) };
}
function spill(tool, text) {
    if (!SPILL_DIR)
        return undefined;
    const safeTool = tool.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60) || "tool";
    const path = join(SPILL_DIR, `${Date.now()}-${process.pid}-${spilled++}-${safeTool}.json`);
    try {
        mkdirSync(SPILL_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(path, text, { mode: 0o600 });
        return path;
    }
    catch (error) {
        process.stderr.write(`mcp-gate(${NAME}): could not save the full result: ${String(error)}\n`);
        return undefined;
    }
}
/** Object key order aside (a server may build the two copies differently); array order counts. */
function sameJson(text, value) {
    try {
        return sameValue(JSON.parse(text), value, 0);
    }
    catch {
        return false;
    }
}
function sameValue(a, b, depth) {
    if (a === b)
        return true;
    if (depth > 200 || !a || !b || typeof a !== "object" || typeof b !== "object")
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i], depth + 1));
    }
    const left = a;
    const right = b;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key], depth + 1));
}
function trimCallResult(result, tool) {
    if (BUDGET === 0)
        return false;
    const content = result.content;
    if (!Array.isArray(content))
        return false;
    const textBlocks = content.filter((block) => Boolean(block) && typeof block === "object" && block.type === "text" && typeof block.text === "string");
    const total = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
    if (!textBlocks.length || total <= BUDGET)
        return false;
    const share = Math.floor(BUDGET / textBlocks.length);
    const path = spill(tool, textBlocks.map((block) => block.text).join("\n"));
    const held = textBlocks.length === 1 ? hold(tool, textBlocks[0].text) : undefined;
    const structuredIsText = textBlocks.length === 1 && Boolean(result.structuredContent) && typeof result.structuredContent === "object"
        && sameJson(textBlocks[0].text, result.structuredContent);
    let trimmed = false;
    let keptValue;
    for (const block of textBlocks) {
        const outcome = trimResultText({ text: block.text, budget: share, spillPath: path, spillHint: SPILL_HINT, toolName: tool, held });
        if (!outcome.trimmed)
            continue;
        block.text = outcome.text;
        keptValue = outcome.value;
        trimmed = true;
    }
    // Claude Code prefers structuredContent over text, hiding the shaping note. Without an outputSchema,
    // omit it so the model sees the note; schema-declaring tools retain the structural trim.
    if (trimmed && !outputSchemas.get(tool)) {
        delete result.structuredContent;
    }
    else if (trimmed && result.structuredContent && typeof result.structuredContent === "object") {
        if (structuredIsText && keptValue && typeof keptValue === "object") {
            result.structuredContent = keptValue;
        }
        else {
            const structured = trimStructured(result.structuredContent, BUDGET);
            if (structured)
                result.structuredContent = structured.value;
        }
    }
    return trimmed;
}
// Validate before starting a process: corrupt policy must never become pass-through.
const scope = toolScope();
const observer = (() => {
    try {
        const mount = parseAppMount(gateEnv[GATE_APPS_ENV]);
        return mount ? new AppObserver(mount, { log: (line) => process.stderr.write(`mcp-gate(${NAME}): ${line}\n`) }) : undefined;
    }
    catch {
        return fail("invalid MCP apps configuration");
    }
})();
const appOnly = new Set();
const outputSchemas = new Map();
const spec = upstreamSpec();
if (SPILL_DIR)
    sweepSpill(SPILL_DIR);
const childEnv = { ...process.env, ...spec.env };
for (const key of Object.keys(childEnv))
    if (key.startsWith("OMB_GATE_"))
        delete childEnv[key];
// CreateProcess cannot exec an npm .cmd shim or a node-shebang script, and a shell would re-interpret JSON argv.
const resolved = resolveCliSpawn(spec.command, spec.args ?? []);
const child = spawn(resolved.command, resolved.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    shell: false,
    // a console app spawned from the desktop shell flashes a window otherwise
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
});
// The real server must not outlive its gate: a launcher (npx, a shell) does not pass a signal on to what it started, so
// each process below the gate is signalled itself. On Windows only taskkill /T reaps a tree.
const END_OF_INPUT_GRACE_MS = 5_000;
const TREE_STOP_GRACE_MS = 1_500;
const tree = [];
const captureTree = () => {
    if (!child.pid)
        return;
    const seen = new Set(tree.map((one) => `${one.pid}:${one.start}`));
    for (const one of descendantsOf(child.pid)) {
        if (!seen.has(`${one.pid}:${one.start}`))
            tree.push(one);
    }
};
let stopping;
const stopUpstream = () => stopping ??= (async () => {
    captureTree();
    if (process.platform === "win32") {
        await killCliTree(child, TREE_STOP_GRACE_MS);
        return;
    }
    if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    await stopTree(tree, TREE_STOP_GRACE_MS);
    if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
})();
const leave = (code) => void stopUpstream().finally(() => process.exit(code));
process.on("SIGTERM", () => leave(0));
process.on("SIGINT", () => leave(0));
process.on("exit", () => {
    if (stopping)
        return;
    if (process.platform === "win32")
        void killCliTree(child);
    else {
        captureTree();
        if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGTERM");
        signalTree(tree, "SIGTERM");
    }
});
child.on("error", (error) => {
    process.stderr.write(`mcp-gate(${NAME}): could not start ${resolved.command}: ${String(error)}\n`);
    process.exit(1);
});
child.stderr.pipe(process.stderr);
function callTarget(name, args) {
    return DIRECTORY ? directoryCallTarget(name, args) : name;
}
/** JSON-RPC string and numeric IDs are separate, even when their text is equal. */
const pending = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    if (line.trim()) {
        try {
            const parsed = JSON.parse(line);
            if (isRecord(parsed))
                message = parsed;
        }
        catch {
            if (scope)
                return rejectRequest(null, -32700, "Invalid JSON-RPC frame");
        }
        if (scope && (!message || message.jsonrpc !== "2.0"))
            return rejectRequest(message?.id, -32600, "Invalid JSON-RPC frame");
    }
    const id = requestKey(message?.id);
    const params = isRecord(message?.params) ? message.params : undefined;
    // The gate's own read-only tool: it reads a held result and never reaches upstream, so no selection or app rule applies.
    if (BUDGET > 0 && message?.method === "tools/call" && params?.name === QUERY_TOOL_NAME) {
        if (!id)
            return;
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answerQuery(store, params.arguments, BUDGET) })}\n`);
        return;
    }
    if (scope && message?.method === "tools/call") {
        if (!id || typeof params?.name !== "string"
            || (params.arguments !== undefined && !isRecord(params.arguments))) {
            return rejectRequest(message.id, -32602, "Invalid tool call");
        }
        // Security: should a bridged agents server answer here, use_tool is also judged by the tool it names. Each target
        // is judged with its own arguments, which say which action of an agents action tool runs.
        const inner = isRecord(params.arguments) ? params.arguments.arguments : undefined;
        const called = callTarget(params.name, params.arguments);
        const targets = [[called, called === params.name ? params.arguments : inner],
            ...(NAME === "agents" ? [[bridgedCallTarget(params.name, params.arguments), inner]] : [])];
        if (targets.some(([target, args]) => target !== undefined && !allowsTool(scope, { kind: "mcp", server: NAME, name: target }, args ?? {}))) {
            return rejectRequest(message.id, -32602, "Tool selection excludes this tool. Check the bot's Access settings.");
        }
    }
    if (message?.method === "tools/call" && typeof params?.name === "string") {
        const target = callTarget(params.name, params.arguments);
        if (target !== undefined && appOnly.has(target))
            return rejectRequest(message.id, -32602, APP_ONLY_REFUSAL);
    }
    if (scope && message?.method === "tools/list" && !id) {
        return rejectRequest(message.id, -32600, "Tool listing needs a request ID");
    }
    if (id && typeof message?.method === "string") {
        if (scope && pending.has(id))
            fail("duplicate request ID on a restricted connection");
        if (message.method === "tools/call") {
            const name = typeof params?.name === "string" ? params.name : "tool";
            const target = callTarget(name, params?.arguments);
            pending.set(id, { kind: "call", tool: target ?? name, trim: target !== undefined, ...(observer && params ? { params } : {}) });
        }
        else if (message.method === "initialize" && observer) {
            if (observer.mount.extension) {
                pending.set(id, { kind: "initialize", original: line });
                return child.stdin.write(`${JSON.stringify({ ...message, params: withUiExtension(message.params) })}\n`);
            }
            pending.set(id, { kind: "initialize" });
        }
        else if (message.method === "tools/list" || scope) {
            pending.set(id, { kind: message.method === "tools/list" ? "list" : "other" });
        }
    }
    child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => {
    child.stdin.end();
    captureTree();
    setTimeout(() => leave(0), END_OF_INPUT_GRACE_MS);
});
createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim())
        return;
    let message;
    try {
        const parsed = JSON.parse(line);
        if (isRecord(parsed))
            message = parsed;
    }
    catch {
        if (scope)
            fail("unreadable upstream frame on a restricted connection");
    }
    if (!message || (scope && message.jsonrpc !== "2.0")) {
        if (scope)
            fail("invalid upstream frame on a restricted connection");
        process.stdout.write(`${line}\n`);
        return;
    }
    const id = typeof message.method === "string" ? undefined : requestKey(message.id);
    const request = id === undefined ? undefined : pending.get(id);
    if (scope && id !== undefined && !request)
        fail("unrequested upstream response on a restricted connection");
    if (request?.kind === "initialize" && request.original && message.error !== undefined && id !== undefined) {
        pending.set(id, { kind: "initialize" });
        process.stderr.write(`mcp-gate(${NAME}): the server refused the MCP Apps extension; connecting without it\n`);
        child.stdin.write(`${request.original}\n`);
        return;
    }
    if (id !== undefined)
        pending.delete(id);
    const result = message.result;
    if (request?.kind === "initialize")
        observer?.initialized(result);
    // A tool only an MCP app's view may call is never listed to the model, and a call to it is refused.
    if (request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools)) {
        observer?.listed(result);
        for (const tool of result.tools) {
            if (!isRecord(tool) || typeof tool.name !== "string")
                continue;
            outputSchemas.set(tool.name, tool.outputSchema !== undefined);
            if (modelVisible(tool))
                appOnly.delete(tool.name);
            else
                appOnly.add(tool.name);
        }
        result.tools = result.tools.filter(modelVisible);
    }
    if (scope && request?.kind === "list" && message.error === undefined) {
        if (!isRecord(result) || !Array.isArray(result.tools)
            || !result.tools.every((tool) => isRecord(tool) && typeof tool.name === "string" && tool.name.trim().length > 0)
            || (result.nextCursor !== undefined && typeof result.nextCursor !== "string")) {
            return rejectRequest(message.id, -32603, "Invalid tool catalog on a restricted connection");
        }
        result.tools = result.tools.filter((tool) => (DIRECTORY && isDirectoryTool(tool.name))
            || allowsTool(scope, { kind: "mcp", server: NAME, name: tool.name }));
    }
    if (SCHEMA_PROFILE && request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools)) {
        result.tools = fitToolList(result.tools, SCHEMA_PROFILE, (note) => process.stderr.write(`mcp-gate(${NAME}): ${note}\n`));
    }
    if (BUDGET > 0 && request?.kind === "list" && message.error === undefined && isRecord(result) && Array.isArray(result.tools) && result.nextCursor === undefined) {
        result.tools = [...result.tools.filter((tool) => !isRecord(tool) || tool.name !== QUERY_TOOL_NAME), QUERY_TOOL];
    }
    if (TOOL_LIMIT !== undefined && request?.kind === "list" && message.error === undefined && isRecord(result)) {
        message.result = capToolListResult(result, TOOL_LIMIT, (note) => process.stderr.write(`mcp-gate(${NAME}): ${note}\n`));
    }
    if (request?.kind === "call" && observer && message.error === undefined)
        observer.returned(request.params, result);
    if (request?.kind === "call" && request.trim && isRecord(result)) {
        try {
            if (trimCallResult(result, request.tool)) {
                process.stderr.write(`mcp-gate(${NAME}): trimmed ${request.tool} to ${BUDGET} chars\n`);
            }
        }
        catch (error) {
            process.stderr.write(`mcp-gate(${NAME}): could not trim ${request.tool}: ${String(error)}\n`);
            process.stdout.write(`${line}\n`);
            return;
        }
    }
    process.stdout.write(`${JSON.stringify(message)}\n`);
});
child.on("exit", (code, signal) => leave(code ?? (signal ? 1 : 0)));
