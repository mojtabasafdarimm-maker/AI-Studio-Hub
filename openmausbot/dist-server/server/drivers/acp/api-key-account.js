export function keyedBy(env, names) {
    return (names ?? []).some((name) => typeof env[name] === "string" && env[name].trim() !== "");
}
export function apiKeyAccount(env, names, authenticated) {
    return authenticated && keyedBy(env, names) ? { account: { method: "api-key" } } : {};
}
