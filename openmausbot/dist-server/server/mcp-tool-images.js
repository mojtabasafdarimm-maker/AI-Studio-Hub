const asMcpImage = (c) => !!c &&
    typeof c === "object" &&
    c.type === "image" &&
    typeof c.data === "string" &&
    typeof c.mimeType === "string"
    ? c
    : null;
// Claude CLI hands MCP images over in Anthropic Messages shape ({type:"image", source:{type:"base64", media_type, data}});
// codex/acp pass the MCP-native {type, data, mimeType} through.
const asAnthropicImage = (c) => {
    const source = c?.type === "image"
        ? c.source
        : null;
    if (!source || typeof source !== "object")
        return null;
    const { type, media_type, data } = source;
    return type === "base64" && typeof media_type === "string" && typeof data === "string"
        ? { data, mimeType: media_type }
        : null;
};
const asImageBlock = (c) => asMcpImage(c) ?? asAnthropicImage(c);
export function extractMcpImages(value) {
    const arr = Array.isArray(value)
        ? value
        : Array.isArray(value?.content)
            ? value.content
            : null;
    return arr ? arr.map(asImageBlock).filter((v) => v !== null) : [];
}
