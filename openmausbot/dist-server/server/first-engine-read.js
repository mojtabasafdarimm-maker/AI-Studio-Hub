// On a cold start the engines' and the browser's binaries are read from a slow disk; work that reads them in the
// background (model catalogs, the browser's version) waits until the engine a first turn most likely needs is probed.
let held = Promise.resolve();
/** Until the returned release runs, `afterFirstEngineRead()` waits. */
export function holdUntilFirstEngineRead() {
    let release;
    held = new Promise((resolve) => (release = resolve));
    return release;
}
export function afterFirstEngineRead() {
    return held;
}
