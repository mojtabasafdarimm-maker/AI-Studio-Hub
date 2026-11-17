import { createHash } from "node:crypto";
export const emptyObservationMetrics = () => ({
    screenshotsCaptured: 0,
    screenshotsSentToModel: 0,
    fullScreenObservations: 0,
    croppedObservations: 0,
    structuredBrowserObservations: 0,
    computerActions: 0,
    retries: 0,
    verificationSuccesses: 0,
    verificationFailures: 0,
});
/** Every observation captures fresh pixels (pages change without input); byte-identical frames are not sent twice. */
export class ObservationCoordinator {
    metrics = emptyObservationMetrics();
    lastObservation = null;
    noteAction(count = 1) {
        this.metrics.computerActions += Math.max(0, Math.trunc(count));
    }
    noteRetry() {
        this.metrics.retries += 1;
    }
    /** canonicalFrame must describe the full screenshot, even when the image
     * returned to the model is cropped. A boat-provided full-frame hash works. */
    observeFrame(canonicalFrame, crop) {
        this.metrics.screenshotsCaptured += 1;
        const hash = canonicalFrame
            ? createHash("sha256").update(canonicalFrame).digest("hex")
            : null;
        const view = crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : "full";
        const signature = hash ? `${hash}:${view}` : null;
        // No full-frame hash: fail open and send the image; suppressing a possibly new crop would be worse.
        const changed = signature === null || signature !== this.lastObservation;
        if (signature)
            this.lastObservation = signature;
        if (changed) {
            this.metrics.screenshotsSentToModel += 1;
            if (crop)
                this.metrics.croppedObservations += 1;
            else
                this.metrics.fullScreenObservations += 1;
        }
        return { changed, hash };
    }
    noteStructuredObservation() {
        this.metrics.structuredBrowserObservations += 1;
    }
    noteVerification(ok) {
        if (ok)
            this.metrics.verificationSuccesses += 1;
        else
            this.metrics.verificationFailures += 1;
    }
}
