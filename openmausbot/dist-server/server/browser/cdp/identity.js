// A headless Chrome presents exactly what the same binary reports when headed.
// The --user-agent flag alone empties the high-entropy client hints, and the CDP
// override alone leaves "HeadlessChrome" in service workers; only both, with
// the binary's own metadata on every page, frame and worker, agree everywhere
// (measured on Chrome 153).
/** Read in the isolated world: userAgentData exists only in a secure context, such as a loopback page. */
export const IDENTITY_PROBE = `(async () => ({
  userAgent: navigator.userAgent,
  high: await navigator.userAgentData.getHighEntropyValues(["brands", "fullVersionList", "platformVersion", "architecture", "bitness", "model", "uaFullVersion", "wow64", "formFactors", "mobile", "platform"]),
}))()`;
export function headedUserAgent(userAgent) {
    return userAgent.replace("HeadlessChrome/", "Chrome/");
}
export function identityFromProbe(probe, product) {
    const high = probe.high;
    return {
        userAgent: headedUserAgent(probe.userAgent),
        userAgentMetadata: {
            brands: high.brands ?? [],
            fullVersionList: high.fullVersionList ?? [],
            fullVersion: high.uaFullVersion ?? "",
            platform: high.platform ?? "",
            platformVersion: high.platformVersion ?? "",
            architecture: high.architecture ?? "",
            model: high.model ?? "",
            mobile: high.mobile ?? false,
            bitness: high.bitness ?? "",
            wow64: high.wow64 ?? false,
            formFactors: high.formFactors ?? [],
        },
        product: product.replace("HeadlessChrome/", "Chrome/"),
    };
}
export function identityOverride(identity, acceptLanguage) {
    return {
        userAgent: identity.userAgent,
        userAgentMetadata: identity.userAgentMetadata,
        ...(acceptLanguage ? { acceptLanguage } : {}),
    };
}
/** Fields where two identities differ; empty when a page could not tell them apart. */
export function identityDifferences(a, b) {
    const differences = [];
    if (a.userAgent !== b.userAgent)
        differences.push("userAgent");
    for (const key of Object.keys(a.userAgentMetadata)) {
        if (JSON.stringify(a.userAgentMetadata[key]) !== JSON.stringify(b.userAgentMetadata[key]))
            differences.push(`userAgentMetadata.${key}`);
    }
    return differences;
}
