// electron/managed-companion-guardian.mjs
import { spawn } from "node:child_process";
import path2 from "node:path";

// electron/companion-origin-gateway.mjs
import http from "node:http";
import path from "node:path";
var MANAGED_COMPANION_ORIGIN_HOST = "127.0.0.1";
var MANAGED_COMPANION_ORIGIN_PORT = 8812;
var RUNTIME_PREFIX = "omb-companion-origin-";
var SOCKET_NAME = "origin.sock";
function validCompanionOriginTarget(target, platform = process.platform) {
  if (!Number.isSafeInteger(target?.pid) || target.pid <= 0) return false;
  if (Object.prototype.toString.call(target?.socketPath) !== "[object String]") return false;
  if (platform === "win32") {
    return /^\\\\\.\\pipe\\openmausbot-companion-origin-[1-9][0-9]*-[0-9a-f-]{36}$/i.test(
      target.socketPath
    );
  }
  return path.isAbsolute(target.socketPath) && path.basename(target.socketPath) === SOCKET_NAME && path.basename(path.dirname(target.socketPath)).startsWith(RUNTIME_PREFIX);
}
function unavailable(response) {
  if (response.headersSent) return response.destroy();
  const body = JSON.stringify({ error: "companion origin unavailable" });
  response.writeHead(503, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json"
  });
  response.end(body);
}
var HOP_BY_HOP_HEADERS = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
function endToEndHeaders(headers = {}) {
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  const connection = Array.isArray(headers.connection) ? headers.connection.join(",") : String(headers.connection ?? "");
  for (const name of connection.split(",")) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== void 0 && !blocked.has(name.toLowerCase()))
  );
}
function upgradeHeaders(headers = {}) {
  if (String(headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  return {
    ...endToEndHeaders(headers),
    connection: "Upgrade",
    upgrade: "websocket"
  };
}
function writeUpgrade(socket, response) {
  const lines = [];
  for (const name of [
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions"
  ]) {
    const value = response.headers[name];
    if (typeof value === "string") lines.push(`${name}: ${value}`);
  }
  socket.write(
    `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r
${lines.join("\r\n")}\r
\r
`
  );
}
function destroySockets(sockets) {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}
function createCompanionOriginGateway({
  target,
  originHost = MANAGED_COMPANION_ORIGIN_HOST,
  originPort = MANAGED_COMPANION_ORIGIN_PORT,
  isTargetAlive = () => true,
  createServer = http.createServer,
  request = http.request,
  upstreamTimeoutMs = 3e4
} = {}) {
  if (!validCompanionOriginTarget(target)) {
    throw new Error("The companion origin target is invalid");
  }
  let accepting = true;
  let listening = false;
  let transition = Promise.resolve();
  const upgradedSockets = /* @__PURE__ */ new Set();
  const server = createServer((incoming, outgoing) => {
    if (!accepting || !isTargetAlive(target)) return unavailable(outgoing);
    const upstream = request(
      {
        headers: endToEndHeaders(incoming.headers),
        method: incoming.method,
        path: incoming.url,
        socketPath: target.socketPath,
        timeout: upstreamTimeoutMs
      },
      (response) => {
        upstream.setTimeout(0);
        if (!accepting || !isTargetAlive(target)) {
          response.destroy();
          return unavailable(outgoing);
        }
        outgoing.writeHead(response.statusCode ?? 502, endToEndHeaders(response.headers));
        response.once("error", () => outgoing.destroy());
        response.once("aborted", () => outgoing.destroy());
        response.once("close", () => {
          if (!response.complete) outgoing.destroy();
        });
        response.pipe(outgoing);
      }
    );
    upstream.once("timeout", () => upstream.destroy(new Error("companion origin timed out")));
    upstream.once("error", () => unavailable(outgoing));
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!accepting || !isTargetAlive(target)) return socket.destroy();
    const headers = upgradeHeaders(incoming.headers);
    if (!headers || incoming.method !== "GET") return socket.destroy();
    upgradedSockets.add(socket);
    let remoteSocket = null;
    const release = () => {
      upgradedSockets.delete(socket);
      if (remoteSocket) upgradedSockets.delete(remoteSocket);
    };
    socket.once("close", release);
    const upstream = request({
      headers,
      method: "GET",
      path: incoming.url,
      socketPath: target.socketPath,
      timeout: upstreamTimeoutMs
    });
    upstream.once("timeout", () => upstream.destroy(new Error("companion origin upgrade timed out")));
    upstream.once("upgrade", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      remote.setTimeout(0);
      if (!accepting || !isTargetAlive(target)) {
        remote.destroy();
        socket.destroy();
        return;
      }
      writeUpgrade(socket, response);
      remoteSocket = remote;
      upgradedSockets.add(remote);
      const teardown = () => {
        socket.destroy();
        remote.destroy();
      };
      socket.on("error", teardown);
      remote.on("error", teardown);
      remote.once("close", release);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket);
    });
    upstream.once("response", (response) => {
      response.resume();
      socket.destroy();
    });
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {
      },
      () => {
      }
    );
    return next;
  };
  return Object.freeze({
    start() {
      return serialize(async () => {
        if (listening) return server.address();
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen({ exclusive: true, host: originHost, port: originPort });
        });
        listening = true;
        return server.address();
      });
    },
    invalidate() {
      accepting = false;
      server.closeAllConnections?.();
      destroySockets(upgradedSockets);
    },
    close() {
      return serialize(async () => {
        accepting = false;
        server.closeAllConnections?.();
        destroySockets(upgradedSockets);
        if (!listening) return;
        await new Promise((resolve) => server.close(() => resolve()));
        listening = false;
      });
    }
  });
}

// electron/managed-companion-guardian.mjs
var copyEnvironmentValue = (source, target, names) => {
  const entries = Object.entries(source);
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (found) target[found[0]] = found[1];
  }
};
function minimalCloudflaredEnvironment(environment = process.env, platform = process.platform) {
  const minimal = {};
  copyEnvironmentValue(environment, minimal, ["PATH"]);
  if (platform === "win32") {
    copyEnvironmentValue(environment, minimal, ["SystemRoot", "WINDIR", "TEMP", "TMP"]);
  }
  return minimal;
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
var delay = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});
async function terminateConnector(child, graceMs = 250) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const exit = new Promise((resolve) => {
    const finish = () => {
      if (exited) return;
      exited = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", () => {
      if (!Number.isSafeInteger(child.pid)) finish();
    });
  });
  try {
    child.kill("SIGTERM");
  } catch {
  }
  await Promise.race([exit, delay(graceMs)]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
  }
  await exit;
}
function ownerLoss(ownerInput, signalSource) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ kind: "owner" });
    };
    ownerInput.once("end", finish);
    ownerInput.once("close", finish);
    ownerInput.once("error", finish);
    signalSource.once("SIGINT", finish);
    signalSource.once("SIGTERM", finish);
    ownerInput.resume?.();
  });
}
async function runManagedCompanionGuardian({
  cloudflaredBinary,
  tokenFile,
  target,
  originPort = MANAGED_COMPANION_ORIGIN_PORT,
  environment = process.env,
  platform = process.platform,
  ownerInput = process.stdin,
  signalSource = process,
  spawnProcess = spawn,
  isTargetAlive = ({ pid }) => processIsAlive(pid),
  createGateway = createCompanionOriginGateway
} = {}) {
  if (!path2.isAbsolute(cloudflaredBinary ?? "") || !path2.isAbsolute(tokenFile ?? "")) {
    throw new Error("The managed connector paths are invalid");
  }
  if (!validCompanionOriginTarget(target, platform)) {
    throw new Error("The managed companion origin target is invalid");
  }
  if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65535) {
    throw new Error("The managed companion origin port is invalid");
  }
  const gateway = createGateway({
    target,
    originPort,
    isTargetAlive
  });
  await gateway.start();
  let connector;
  try {
    connector = spawnProcess(
      cloudflaredBinary,
      [
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "info",
        "--output",
        "json",
        "run",
        "--token-file",
        tokenFile
      ],
      {
        env: minimalCloudflaredEnvironment(environment, platform),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"]
      }
    );
  } catch (error) {
    gateway.invalidate();
    await gateway.close();
    throw error;
  }
  const connectorExit = new Promise((resolve) => {
    connector.once("exit", (code) => resolve({ kind: "connector", code: code ?? 1 }));
    connector.once("error", () => {
      if (!Number.isSafeInteger(connector.pid)) {
        resolve({ kind: "connector", code: 1 });
      }
    });
  });
  const outcome = await Promise.race([connectorExit, ownerLoss(ownerInput, signalSource)]);
  gateway.invalidate();
  if (outcome.kind === "owner") await terminateConnector(connector);
  await gateway.close();
  return outcome.kind === "connector" ? outcome.code : 0;
}
function guardianArguments(argv) {
  if (argv.length !== 5) throw new Error("The managed companion guardian arguments are invalid");
  const [cloudflaredBinary, tokenFile, socketPath, rawPid, rawPort] = argv;
  const pid = Number(rawPid);
  const originPort = Number(rawPort);
  const target = { pid, socketPath };
  if (!validCompanionOriginTarget(target)) {
    throw new Error("The managed companion guardian target is invalid");
  }
  return { cloudflaredBinary, tokenFile, target, originPort };
}

// electron/managed-companion-guardian-main.mjs
runManagedCompanionGuardian(guardianArguments(process.argv.slice(2))).then(
  (code) => process.exit(code),
  () => process.exit(1)
);
