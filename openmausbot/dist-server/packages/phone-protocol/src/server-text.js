const REFERENCE_PARAMS = new Set(["limit", "meanwhile", "why"]);
const PART_KEY = /^(?:chat\.notice|routines\.server)\.part\.\w+$/;
/** Only these params may name a catalog piece (`chat.notice.part.*`, `routines.server.part.*`) that a client words;
 * every other param is data, such as a name, a quote or a failure, and is shown exactly as sent. */
export function isReferenceParam(name, value) {
    return REFERENCE_PARAMS.has(name) && typeof value === "string" && PART_KEY.test(value);
}
export function formatServerText(template, params = {}) {
    return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
