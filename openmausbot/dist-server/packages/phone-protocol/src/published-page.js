/** The MausBot pages Worker's page ids: one DNS label of lowercase letters and digits. */
export const PAGE_ID = /^[a-z0-9]{20,63}$/;
/** What a page's files may be, by extension, and the Content-Type each is served with: the same list as the pages
 * Worker's (openmaus-cloud pages-worker/src/files.ts refuses the rest). */
export const PAGE_FILE_TYPES = {
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8", ndjson: "application/x-ndjson; charset=utf-8", md: "text/markdown; charset=utf-8",
    geojson: "application/geo+json", topojson: "application/json; charset=utf-8",
    parquet: "application/vnd.apache.parquet", arrow: "application/vnd.apache.arrow.file", svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};
export const PAGE_FILE_EXTENSIONS = new Set(Object.keys(PAGE_FILE_TYPES));
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PAGE_MAX_FILES = 200;
