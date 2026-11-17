// Ack pacing and scaled captures follow T3 Code's apps/server/src/preview/
// ServerBrowser.ts and ServerBrowserPage.ts (captureViewport), Copyright 2026
// T3 Tools Inc., used under the MIT License (third_party/t3-code/LICENSE).
/** Chromium keeps at most three frames unacknowledged, so acking 100 ms after arrival caps a stream near 30 fps. */
export const ACK_PACE_MS = 100;
/**
 * The largest picture a bot is sent. Claude's API (2026) shrinks an image past 1568 pixels on its long edge or about 1.2
 * megapixels before the model sees it, without saying so, which would move every point the model reads off it; past
 * 8000 pixels it refuses the image.
 */
export const PICTURE_LIMITS = { maxWidth: 1280, maxHeight: 1568, maxPixels: 1_200_000 };
/** A picture's pixels per CSS pixel of a region of `size`: one, or in hundredths below one as PICTURE_LIMITS needs. */
export function pictureScale(size) {
    const width = Math.max(1, size.width);
    const height = Math.max(1, size.height);
    const fit = Math.min(1, PICTURE_LIMITS.maxWidth / width, PICTURE_LIMITS.maxHeight / height, Math.sqrt(PICTURE_LIMITS.maxPixels / (width * height)));
    return fit >= 1 ? 1 : Math.max(0.01, Math.floor(fit * 100) / 100);
}
/** Page.startScreencast with paced acks. Frames stop arriving while nobody acks them. */
export class Screencast {
    #session;
    #onFrame;
    #off = null;
    #options = {};
    constructor(session, onFrame) {
        this.#session = session;
        this.#onFrame = onFrame;
    }
    get running() {
        return this.#off !== null;
    }
    async start(options = {}) {
        this.#options = options;
        if (!this.#off)
            this.#off = this.#session.on("Page.screencastFrame", (params) => this.#frame(params));
        await this.#session.send("Page.startScreencast", {
            format: options.format ?? "jpeg",
            quality: Math.min(100, Math.max(1, Math.round(options.quality ?? 80))),
            ...(options.maxWidth ? { maxWidth: Math.round(options.maxWidth) } : {}),
            ...(options.maxHeight ? { maxHeight: Math.round(options.maxHeight) } : {}),
            everyNthFrame: options.everyNthFrame ?? 1,
        });
    }
    /** Restarts with new settings (a motion tier, a resized viewer). */
    async restart(options) {
        await this.#session.send("Page.stopScreencast").catch(() => { });
        await this.start({ ...this.#options, ...options });
    }
    async stop() {
        this.#off?.();
        this.#off = null;
        await this.#session.send("Page.stopScreencast").catch(() => { });
    }
    #frame(params) {
        const receivedAt = Date.now();
        const sessionId = params.sessionId;
        try {
            this.#onFrame({ data: Buffer.from(String(params.data ?? ""), "base64"), metadata: params.metadata, receivedAt });
        }
        finally {
            setTimeout(() => {
                void this.#session.send("Page.screencastFrameAck", { sessionId }).catch(() => { });
            }, Math.max(0, receivedAt + ACK_PACE_MS - Date.now()));
        }
    }
}
/**
 * One picture pixel per CSS pixel within PICTURE_LIMITS, of the region it names: the viewport without a classic
 * scrollbar, the whole page, or a clip. The capture is always clipped and so repaints: callers pause a live screencast first.
 */
export async function captureScreenshot(session, devicePixelRatio, options = {}) {
    const format = options.format ?? "png";
    const metrics = await session.send("Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport;
    const region = options.clip
        ?? (options.fullPage
            ? { x: 0, y: 0, width: Math.ceil(metrics.cssContentSize.width), height: Math.min(Math.ceil(metrics.cssContentSize.height), 16_384) }
            : { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight });
    const scale = pictureScale(region);
    const { data } = await session.send("Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: Math.min(100, Math.max(1, Math.round(options.quality ?? 80))) } : {}),
        // Chrome draws a clip at its scale times the device pixel ratio (measured on 156).
        clip: { ...region, scale: scale / devicePixelRatio },
        ...(options.fullPage ? { captureBeyondViewport: true } : {}),
    });
    return {
        data: Buffer.from(data, "base64"),
        format,
        width: Math.round(region.width * scale),
        height: Math.round(region.height * scale),
        scale,
        region: { width: region.width, height: region.height },
    };
}
