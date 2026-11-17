// The events a bot (or the person, for a bot) can watch: only connected apps that bot may use, each with its event
// types from the connected-apps service. Apps it may not use are left out entirely, never listed as refused.
import { botMayWatchApp } from "../shared/app-triggers.js";
/** Asked about most often; shown as "not connected yet" so the bot can offer to connect one. */
const POPULAR = ["gmail", "slack", "googlecalendar", "outlook", "github", "hubspot", "notion", "googlesheets"];
const MAX_APPS = 10;
const MAX_EVENTS = 25;
const DESCRIPTION_MAX = 200;
const label = (slug) => ({ googlecalendar: "Google Calendar", googlesheets: "Google Sheets", github: "GitHub", hubspot: "HubSpot" }[slug]
    ?? slug.split(/[-_]+/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" "));
function eventType(type) {
    const properties = (type.config.properties ?? {});
    const required = new Set(Array.isArray(type.config.required) ? type.config.required : []);
    const payload = (type.payload.properties ?? {});
    return {
        event: type.slug,
        name: type.name,
        description: type.description.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX),
        delivery: type.type === "poll" ? "poll" : "instant",
        configFields: Object.entries(properties).map(([name, field]) => ({
            name,
            type: typeof field.type === "string" ? field.type : "string",
            required: required.has(name) && field.default === undefined,
            ...(typeof field.description === "string" ? { description: field.description.replace(/\s+/g, " ").slice(0, 160) } : {}),
            ...(field.default !== undefined ? { default: field.default } : {}),
        })),
        filterFields: Object.entries(payload).filter(([, field]) => field.type === "string" || field.type === "array").map(([name]) => name).slice(0, 20),
    };
}
export async function appEventCatalog(input) {
    const usable = Object.entries(input.connected)
        .filter(([slug, state]) => state.connected && state.accounts.some((account) => /^active$/i.test(account.status)) && botMayWatchApp(input.bot, slug))
        .map(([slug]) => slug)
        .sort();
    const wanted = input.app?.trim().toLowerCase();
    const apps = (wanted ? usable.filter((slug) => slug === wanted) : usable).slice(0, MAX_APPS);
    const words = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const types = apps.length ? await input.broker.triggerTypes(apps) : {};
    return {
        apps: apps.map((slug) => {
            const loaded = types[slug];
            const events = (loaded?.types ?? []).map(eventType)
                .filter((event) => words.every((word) => `${event.name} ${event.description} ${event.event}`.toLowerCase().includes(word)))
                .slice(0, MAX_EVENTS);
            return {
                app: slug,
                name: label(slug),
                accounts: input.connected[slug].accounts.filter((account) => /^active$/i.test(account.status)).map((account) => ({ id: account.id, ...(account.alias ? { alias: account.alias } : {}) })),
                events,
                ...(loaded?.error ? { error: loaded.error } : {}),
            };
        }),
        notConnected: POPULAR.filter((slug) => !input.connected[slug]?.connected && (!wanted || wanted === slug)).map((slug) => ({ app: slug, name: label(slug) })),
    };
}
export function appLabel(slug) {
    return label(slug);
}
