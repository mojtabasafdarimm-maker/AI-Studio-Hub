import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import { parseModelManifest } from "./schema.js";
const parsedBundle = parseModelManifest(bundledManifestJson, { strict: true, nowMs: Number.MAX_SAFE_INTEGER / 2 });
if (!parsedBundle.ok)
    throw new Error(`The bundled model manifest is invalid (${parsedBundle.error})`);
export const BUNDLED_MODEL_MANIFEST = parsedBundle.manifest;
/** The manifest's engine as the picker wants it; legacy models stay valid in a saved bot but are not offered for new picks. */
export function engineCatalogFrom(manifest, engine) {
    const section = manifest.engines[engine];
    if (!section)
        return null;
    return {
        default: section.default,
        options: section.models.filter((model) => model.status === "current").map((model) => ({
            id: model.id,
            label: model.name,
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            ...(model.variants?.length ? { variants: model.variants } : {}),
        })),
    };
}
export function bundledEngineCatalog(engine) {
    return engineCatalogFrom(BUNDLED_MODEL_MANIFEST, engine);
}
