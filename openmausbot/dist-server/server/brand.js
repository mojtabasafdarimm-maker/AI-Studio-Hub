// White-label: a brand.json next to the data dir, applied only with the `whitelabel` entitlement (an unlicensed server
// reports what it found and keeps the default). Read on every request, so an edit shows on the next reload.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "./config.js";
import { entitled } from "./enterprise.js";
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const MAX_LOGO_CHARS = 300_000;
const MAX_FAVICON_CHARS = 120_000;
export const brandSchema = z
    .object({
    /** Product name shown in the window title, onboarding and settings. */
    name: z.string().trim().min(1, "name must not be empty").max(40, "name must be 40 characters or fewer"),
    /** One line under the name on the welcome screen. */
    tagline: z.string().trim().max(120, "tagline must be 120 characters or fewer").optional(),
    /** Accent colour for buttons, links and focus rings; text on it is derived for contrast. */
    accent: z.string().regex(HEX_COLOUR, "accent must be a 6-digit hex colour such as #C2510A").optional(),
    /** Welcome-screen mark: an inline data:image/... URI or an https:// URL. */
    logo: z
        .string()
        .max(MAX_LOGO_CHARS, `logo must be under ${MAX_LOGO_CHARS} characters (inline a small SVG or link an https:// image)`)
        .refine((v) => v.startsWith("data:image/") || v.startsWith("https://"), "logo must be a data:image/... URI or an https:// URL")
        .optional(),
    /** Where "get help" points for this deployment. */
    supportUrl: z.string().url().startsWith("https://", "supportUrl must be an https:// URL").optional(),
    /** Tab and home-screen icon: an inline data:image/... URI (PNG or SVG, small) or an https:// URL. */
    favicon: z
        .string()
        .max(MAX_FAVICON_CHARS, `favicon must be under ${MAX_FAVICON_CHARS} characters (a 64px PNG or a small SVG)`)
        .refine((v) => v.startsWith("data:image/") || v.startsWith("https://"), "favicon must be a data:image/... URI or an https:// URL")
        .optional(),
})
    .strict();
export const DEFAULT_BRAND = { name: "OpenMausBot" };
/** The product's name wherever a person reads it. OpenMausBot names only the open-source project and its repository. */
export const PRODUCT_NAME = "MausBot";
export function brandFile() {
    return process.env.OMB_BRAND_FILE || join(DATA_DIR, "brand.json");
}
/** Never throws. */
export function loadBrand(options = {}) {
    const file = options.file ?? brandFile();
    const isEntitled = options.isEntitled ?? entitled;
    const fallback = (notice) => notice ? { brand: DEFAULT_BRAND, source: "default", file, notice } : { brand: DEFAULT_BRAND, source: "default", file };
    if (!existsSync(file))
        return fallback();
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (error) {
        return fallback(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); using the default brand`);
    }
    const parsed = brandSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        return fallback(`${file}: ${where}${issue?.message ?? "invalid"}; using the default brand`);
    }
    if (!isEntitled("whitelabel")) {
        return fallback(`${file} found but this server is not licensed for whitelabel; using the default brand`);
    }
    return { brand: parsed.data, source: "file", file };
}
export function describeBrand(status) {
    if (status.source === "file")
        return `brand: ${status.brand.name} (from ${status.file})`;
    return `brand: default${status.notice ? ` (${status.notice})` : ""}`;
}
/** The name a person reads: an applied brand file's own name, else MausBot. `DEFAULT_BRAND.name` stays the project's name. */
export function productName(status = loadBrand()) {
    return status.source === "file" ? status.brand.name : PRODUCT_NAME;
}
