// The copy capture in BOOTSTRAP is T3 Code's CLIPBOARD_SCRIPT
// (apps/server/src/preview/ServerBrowser.ts), Copyright 2026 T3 Tools Inc.,
// used under the MIT License (third_party/t3-code/LICENSE). Modified: renamed
// globals.
import { isGone } from "./errors.js";
import { WORLD_NAME } from "./frames.js";
import { AUTH_PATTERNS } from "./auth.js";
import { NO_PASSKEY_COMMANDS } from "./passkeys.js";
export const CLIPBOARD_TEXT_LIMIT = 1024 * 1024;
/**
 * Runs in the isolated world of every document before the page's own scripts.
 * Headless Chromium shares one clipboard between every profile, so a copy or
 * cut that a real key press makes is captured here instead of read back from it.
 */
export const BOOTSTRAP = `(() => {
  if (globalThis.__ombBootstrapped) return;
  globalThis.__ombBootstrapped = true;
  let keying = false;
  let copied = "";
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    keying = true;
    copied = "";
    setTimeout(() => { keying = false; });
  }, true);
  const selection = () => {
    let field = document.activeElement;
    while (field && field.shadowRoot && field.shadowRoot.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null)
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    return String(document.getSelection() ?? "");
  };
  const record = (text) => { copied = String(text ?? "").slice(0, ${CLIPBOARD_TEXT_LIMIT}); };
  const snapshot = (event) => { if (keying && event.isTrusted) record(selection()); };
  const replace = (event) => { if (keying && event.isTrusted && event.defaultPrevented) record(event.clipboardData && event.clipboardData.getData("text/plain")); };
  for (const type of ["copy", "cut"]) {
    addEventListener(type, snapshot, true);
    addEventListener(type, replace);
  }
  globalThis.__ombTakeCopy = () => { const text = copied; copied = ""; return text; };
})();`;
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
/**
 * Configures a page or an out-of-process iframe while Chrome holds it paused,
 * then lets it run. CDP runs one session's commands in order, so everything
 * lands before the first script.
 */
export async function setUpDocumentSession(session, setup, { isPage }) {
    const calls = [
        session.send("Page.enable"),
        session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
        session.send("Network.enable"),
        session.send("Log.enable"),
    ];
    if (setup.identity)
        calls.push(session.send("Emulation.setUserAgentOverride", { ...setup.identity }));
    if (isPage && setup.focusEmulation)
        calls.push(session.send("Emulation.setFocusEmulationEnabled", { enabled: true }));
    if (isPage && setup.handleAuth)
        calls.push(session.send("Fetch.enable", { patterns: AUTH_PATTERNS, handleAuthRequests: true }));
    // A Chrome without the WebAuthn domain still opens its pages: their passkey requests are then left as they were.
    if (isPage && setup.noPasskeys)
        for (const [method, params] of NO_PASSKEY_COMMANDS)
            void session.send(method, params).catch(() => { });
    calls.push(session.send("Page.setInterceptFileChooserDialog", { enabled: setup.interceptFileChooser }), session.send("Page.addScriptToEvaluateOnNewDocument", { source: BOOTSTRAP, worldName: WORLD_NAME, runImmediately: true }), session.send("Target.setAutoAttach", AUTO_ATTACH));
    const released = session.send("Runtime.runIfWaitingForDebugger");
    const results = await Promise.allSettled([...calls, released]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed && !isGone(failed.reason))
        throw failed.reason;
}
/** Workers get the identity, and nothing else, before their first line runs. */
export function setUpWorkerSession(session, identity) {
    if (identity) {
        void session.send("Emulation.setUserAgentOverride", { ...identity }).catch(() => { });
        void session.send("Network.setUserAgentOverride", { ...identity }).catch(() => { });
    }
    void session.send("Target.setAutoAttach", AUTO_ATTACH).catch(() => { });
    void session.send("Runtime.runIfWaitingForDebugger").catch(() => { });
}
export function releaseSession(session) {
    void session.send("Runtime.runIfWaitingForDebugger").catch(() => { });
}
/** Granted, as a normal profile has them; denied, which keeps the OS permission prompts away and agrees with Notification.permission. */
export const PERMISSIONS = [
    { name: "clipboard-write", setting: "granted" },
    { name: "storage-access", setting: "granted" },
    { name: "top-level-storage-access", setting: "granted" },
    { name: "persistent-storage", setting: "granted" },
    { name: "background-sync", setting: "granted" },
    { name: "notifications", setting: "denied" },
    { name: "geolocation", setting: "denied" },
    { name: "camera", setting: "denied" },
    { name: "microphone", setting: "denied" },
    { name: "clipboard-read", setting: "denied" },
    { name: "midi", setting: "denied" },
    { name: "midi", setting: "denied", extra: { sysex: true } },
    { name: "accelerometer", setting: "denied" },
    { name: "gyroscope", setting: "denied" },
    { name: "magnetometer", setting: "denied" },
    { name: "ambient-light-sensor", setting: "denied" },
    { name: "idle-detection", setting: "denied" },
    { name: "local-network-access", setting: "denied" },
    { name: "window-management", setting: "denied" },
    { name: "display-capture", setting: "denied" },
    { name: "nfc", setting: "denied" },
    { name: "payment-handler", setting: "denied" },
];
/** Returns the permission names this Chrome does not know. */
export async function applyPermissions(root) {
    const results = await Promise.allSettled(PERMISSIONS.map(({ name, setting, extra }) => root.send("Browser.setPermission", { permission: { name, ...extra }, setting })));
    return PERMISSIONS.filter((_, i) => results[i].status === "rejected").map(({ name }) => name);
}
