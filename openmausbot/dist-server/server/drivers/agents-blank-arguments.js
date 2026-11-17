function jsonRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** The top-level arguments a model may fill with `""` (or spaces) when it means to leave them out, per tool. Only these:
 * elsewhere a blank can be the value itself, such as a cleared room bulletin or a bot's private folder. */
const BLANK_MEANS_LEFT_OUT = {
    coordinate_bots: ["group_id", "reason", "thread", "title", "reply", "done_when", "answers", "files"],
    session_search: ["thread_id", "message_id", "query", "since", "until", "scope"],
    show_html: ["html", "jsx", "path"],
    // A blank text or old_text is a mistake the schema names, not "not given".
    memory_update: ["until"],
};
const blankText = (value) => typeof value === "string" && !value.trim();
const blankOrNull = (value) => value === null || blankText(value);
/** A copy of `record` without the given keys where `blank` says they were left out. */
function withoutBlank(record, keys, blank = blankOrNull) {
    const out = { ...record };
    for (const key of keys)
        if (blank(out[key]))
            delete out[key];
    return out;
}
/** Strict tool-calling engines fill every optional field, so a model choice arrives with effort and variant both set to
 * "" or null; the receiver reads either as a choice and refuses ("choose either a model variant or an effort level"). */
function withoutBlankModelChoice(selection) {
    return jsonRecord(selection) ? withoutBlank(selection, ["effort", "variant"]) : selection;
}
/** Same for team setup: a create also carries a blank botId and an update a blank key, which the receiver refuses as
 * unrecognized keys, and optional fields arrive as null. A non-blank one is kept, so a real mistake is still named; an
 * empty string field (a cleared description) is kept too. */
function withoutBlankTeamSetupFields(input) {
    if (!Array.isArray(input.operations))
        return input;
    return {
        ...input,
        operations: input.operations.map((operation) => {
            if (!jsonRecord(operation))
                return operation;
            const out = withoutBlank(operation, operation.action === "create" ? ["botId"] : operation.action === "update" ? ["key"] : []);
            if (jsonRecord(out.fields)) {
                const fields = withoutBlank(out.fields, Object.keys(out.fields), (value) => value === null);
                if (fields.modelSelection !== undefined)
                    fields.modelSelection = withoutBlankModelChoice(fields.modelSelection);
                out.fields = fields;
            }
            return out;
        }),
    };
}
/** Tools whose model choice (effort / variant) strict engines fill with blanks, and the argument that holds it. */
const MODEL_CHOICE_ARGUMENT = { create_bot: "modelSelection", propose_model: "model_selection", start_thread: "model_selection" };
export function dropBlankArguments(name, input) {
    if (!jsonRecord(input))
        return input;
    if (name === "propose_team_setup")
        return withoutBlankTeamSetupFields(input);
    const selectionKey = Object.hasOwn(MODEL_CHOICE_ARGUMENT, name) ? MODEL_CHOICE_ARGUMENT[name] : undefined;
    if (selectionKey && input[selectionKey] !== undefined)
        return { ...input, [selectionKey]: withoutBlankModelChoice(input[selectionKey]) };
    const keys = Object.hasOwn(BLANK_MEANS_LEFT_OUT, name) ? BLANK_MEANS_LEFT_OUT[name] : undefined;
    return keys ? withoutBlank(input, keys, blankText) : input;
}
