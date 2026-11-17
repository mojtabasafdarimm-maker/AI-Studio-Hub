// Only a turn-scoped capability crosses into the agent process; engine commands, session names and provider credentials stay in OMB.
import { pathToFileURL } from "node:url";
import { failure, harnessMcpRequest, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, parseHarnessMcpKind } from "./harness-mcp-request.js";
import { harnessMcpTokenEnv } from "./harness-mcp-token.js";
import { toolLimitFromEnv } from "./tool-count-limit.js";
export { harnessMcpRequest } from "./harness-mcp-request.js";
const MAX_PENDING = 16;
function run(kind) {
    const connection = { url: process.env.OMB_HARNESS_URL ?? "", token: process.env[harnessMcpTokenEnv(kind)] ?? "", kind, toolLimit: toolLimitFromEnv() };
    let input = Buffer.alloc(0);
    let pending = 0;
    const output = (message) => {
        if (message === undefined)
            return;
        const line = `${JSON.stringify(message)}\n`;
        if (Buffer.byteLength(line) > MAX_OUTPUT_BYTES || process.stdout.writableLength > MAX_OUTPUT_BYTES * 2) {
            process.stdin.destroy();
            process.exitCode = 1;
            return;
        }
        process.stdout.write(line);
    };
    process.stdout.on("error", () => { process.stdin.destroy(); process.exitCode = 1; });
    process.stdin.on("data", (chunk) => {
        input = Buffer.concat([input, chunk]);
        let newline;
        while ((newline = input.indexOf(10)) !== -1) {
            if (newline > MAX_INPUT_BYTES) {
                process.stdin.destroy();
                process.exitCode = 1;
                return;
            }
            const line = input.subarray(0, newline).toString("utf8");
            input = input.subarray(newline + 1);
            if (!line.trim())
                continue;
            let frame;
            try {
                frame = JSON.parse(line);
            }
            catch {
                output(failure(null, null, "Parse error.", -32700));
                continue;
            }
            if (pending >= MAX_PENDING) {
                const request = frame;
                if (request && Object.hasOwn(request, "id"))
                    output(failure(request.id ?? null, request.method, `Too many pending ${kind} requests.`));
                continue;
            }
            pending++;
            void harnessMcpRequest(frame, connection).then(output).finally(() => { pending--; });
        }
        if (input.length > MAX_INPUT_BYTES) {
            process.stdin.destroy();
            process.exitCode = 1;
        }
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const kind = parseHarnessMcpKind(process.argv[2]);
    if (!kind) {
        process.stderr.write("usage: harness-mcp-proxy browser|computer|data|email|device\n");
        process.exitCode = 2;
    }
    else
        run(kind);
}
