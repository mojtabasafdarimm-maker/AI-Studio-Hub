// Security invariant: reserve before dispatch, including concurrent batches and uncertain upstream failures.
export function reserveGmailDrafts(calls, reserved) {
    const keys = [];
    for (const call of calls) {
        if (call.slug !== "GMAIL_CREATE_EMAIL_DRAFT")
            continue;
        const args = call.arguments;
        const thread = args && typeof args.thread_id === "string" ? args.thread_id : "";
        if (!thread)
            continue;
        const key = JSON.stringify([args?.user_id ?? "me", thread]);
        if (reserved.has(key) || keys.includes(key))
            return "Draft creation for this Gmail thread was already attempted in this request. Read the existing drafts and update the intended draft by ID; do not create another, including after a timeout.";
        keys.push(key);
    }
    for (const key of keys)
        reserved.add(key);
    return null;
}
