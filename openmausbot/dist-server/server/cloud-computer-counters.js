const MAX_COMPUTERS = 20;
const LABELS = [
    ["wakes", "waits for an answer after waking"], ["restoreWaits", "waits on a disk restore"], ["unanswered", "calls unanswered"],
    ["resent", "calls sent again"], ["lostAnswers", "answers lost after the call ran"], ["restarts", "restarts"],
];
export function createCloudComputerCounters(now = Date.now) {
    const rows = new Map();
    function count(boxId, what, waitedMs = 0) {
        let row = rows.get(boxId);
        if (!row) {
            if (rows.size >= MAX_COMPUTERS) {
                const oldest = [...rows].sort(([, a], [, b]) => a.lastAt - b.lastAt)[0];
                if (oldest)
                    rows.delete(oldest[0]);
            }
            rows.set(boxId, row = {
                counts: { wakes: 0, restoreWaits: 0, unanswered: 0, resent: 0, lostAnswers: 0, restarts: 0 },
                waited: { wakes: 0, restoreWaits: 0, restarts: 0 }, lastAt: now(),
            });
        }
        row.counts[what] += 1;
        if (what in row.waited)
            row.waited[what] += Math.max(0, Math.round(waitedMs));
        row.lastAt = now();
    }
    return {
        count,
        snapshot: (boxId) => rows.get(boxId)?.counts ?? null,
        /** One line per computer, most recent first. */
        lines() {
            return [...rows].sort(([, a], [, b]) => b.lastAt - a.lastAt).map(([boxId, row]) => {
                const parts = LABELS.filter(([key]) => row.counts[key] > 0).map(([key, label]) => {
                    const waited = key in row.waited ? row.waited[key] : 0;
                    return `${row.counts[key]} ${label}${waited ? ` (${Math.round(waited / 1_000)}s in all)` : ""}`;
                });
                return `${boxId}: ${parts.join(", ")}; last ${new Date(row.lastAt).toISOString()}`;
            });
        },
        clear: () => rows.clear(),
    };
}
export const cloudComputerCounters = createCloudComputerCounters();
