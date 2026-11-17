export function piModelId(model) {
    const entry = model;
    return typeof entry?.provider === "string" && entry.provider && typeof entry.id === "string" && entry.id
        ? `${entry.provider}/${entry.id}` : null;
}
