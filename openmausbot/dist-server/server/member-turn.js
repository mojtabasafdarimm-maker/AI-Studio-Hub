// Without `model`, Hermes hits OpenRouter with HTTP 401, Qwen dies with Internal error and Grok silently runs its cloud default.
import { isModelVariant } from "./contracts.js";
export function assertModelVariantSupported(selection, capabilities) {
    if (selection.variant !== undefined &&
        (!isModelVariant(selection.variant) || !capabilities.modelVariants || selection.effort !== undefined)) {
        throw Object.assign(new Error("the saved model variant cannot be applied by this AI — choose a variant in model settings"), { status: 409, code: "unsupported_model_variant" });
    }
}
export function memberTurnSelection(selection) {
    return {
        model: selection.model,
        ...(selection.effort ? { effort: selection.effort } : {}),
        ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
    };
}
