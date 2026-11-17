// The AWS SDK inside Claude Code resolves a profile's SSO or credential_process itself; OpenMausBot stores no AWS secret.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { assertSeparateClaudeAccount } from "./claude-accounts.js";
import { DATA_DIR, persistableInstanceConfigs } from "./config.js";
import { CLAUDE_MODEL_ID } from "./drivers/claude-model-extras.js";
const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value), "Name cannot contain control characters");
const awsProfile = z.string().trim().regex(/^[A-Za-z0-9._+=,@-]{1,128}$/, "Enter the AWS profile name from this computer's ~/.aws config.");
const awsRegion = z.string().trim().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "Enter an AWS region, such as us-east-1.");
const model = z.string().trim().max(160).regex(CLAUDE_MODEL_ID, "Use the model id Bedrock serves.")
    .refine((value) => value !== "default", "Claude Code reserves `default`; use the model id Bedrock serves.");
const optionalModel = z.union([model, z.literal("")]);
export const claudeBedrockSchema = z.object({
    displayName,
    awsProfile,
    awsRegion,
    model,
    opusModel: optionalModel.optional(),
    sonnetModel: optionalModel.optional(),
    haikuModel: optionalModel.optional(),
    smallFastModel: optionalModel.optional(),
}).strict();
export const claudeBedrockUpdateSchema = z.object({
    displayName: displayName.optional(),
    awsProfile: awsProfile.optional(),
    awsRegion: awsRegion.optional(),
    model: model.optional(),
    opusModel: optionalModel.optional(),
    sonnetModel: optionalModel.optional(),
    haikuModel: optionalModel.optional(),
    smallFastModel: optionalModel.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No settings supplied");
const TIERS = [
    ["opusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
    ["sonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
    ["haikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
    ["smallFastModel", "ANTHROPIC_SMALL_FAST_MODEL"],
];
function rawConfig(entry) {
    return entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
        ? entry.config : {};
}
/** A Claude instance that runs Claude Code on Amazon Bedrock, rather than a named Claude account or a custom endpoint. */
export function isClaudeBedrock(entry) {
    return entry?.driver === "claudeAgent" && rawConfig(entry).bedrock === true;
}
/** What the settings UI may know about a Bedrock instance: its profile, region and models; never a secret. */
export function claudeBedrockInfo(entry) {
    const config = rawConfig(entry);
    const environment = entry.environment ?? {};
    return {
        awsProfile: environment.AWS_PROFILE ?? "",
        awsRegion: environment.AWS_REGION ?? "",
        model: environment.ANTHROPIC_MODEL ?? "",
        models: Array.isArray(config.endpointModels) ? [...config.endpointModels] : [],
        opusModel: environment.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "",
        sonnetModel: environment.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "",
        haikuModel: environment.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "",
        smallFastModel: environment.ANTHROPIC_SMALL_FAST_MODEL ?? "",
    };
}
/** Adds each Bedrock instance's profile, region and models to the engine list; no secret ever leaves the server. */
export function withClaudeBedrockInfo(described, configs) {
    if (!Array.isArray(described))
        return described;
    return described.map((instance) => {
        const entry = instance.instanceId ? configs[instance.instanceId] : undefined;
        return entry && isClaudeBedrock(entry) ? { ...instance, claudeBedrock: claudeBedrockInfo(entry) } : instance;
    });
}
function bedrockEnvironment(fields) {
    const environment = {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: fields.awsProfile,
        AWS_REGION: fields.awsRegion,
        ...(fields.model ? { ANTHROPIC_MODEL: fields.model.trim() } : {}),
    };
    for (const [field, key] of TIERS) {
        const value = fields[field]?.trim();
        if (value)
            environment[key] = value;
    }
    return environment;
}
function bedrockModels(fields) {
    const tiers = TIERS.map(([field]) => fields[field]?.trim() ?? "").filter(Boolean);
    return [...new Set([(fields.model ?? "").trim(), ...tiers].filter(Boolean))];
}
function inheritedCli(instances) {
    for (const entry of Object.values(instances)) {
        if (entry.driver !== "claudeAgent" || isClaudeBedrock(entry))
            continue;
        const cli = rawConfig(entry).cli;
        if (typeof cli === "string" && cli)
            return cli;
    }
    return undefined;
}
export function newClaudeBedrock(cfg, body) {
    const instances = persistableInstanceConfigs(cfg);
    const instanceId = `claude-${randomUUID()}`;
    const cli = inheritedCli(instances);
    const entry = {
        driver: "claudeAgent",
        displayName: body.displayName,
        access: "custom",
        config: {
            ...(cli ? { cli } : {}),
            configDir: join(DATA_DIR, "providers", instanceId),
            bedrock: true,
            endpointModels: bedrockModels(body),
        },
        environment: bedrockEnvironment(body),
    };
    assertSeparateClaudeAccount(instances, instanceId, entry);
    instances[instanceId] = entry;
    return { instanceId, instances };
}
export function updateClaudeBedrock(cfg, instanceId, body) {
    const instances = persistableInstanceConfigs(cfg);
    const entry = instances[instanceId];
    if (!entry)
        throw Object.assign(new Error("unknown instance"), { status: 404 });
    if (!isClaudeBedrock(entry))
        throw Object.assign(new Error("This Claude instance is not an Amazon Bedrock engine."), { status: 400 });
    const saved = claudeBedrockInfo(entry);
    if (!saved.awsProfile || !saved.awsRegion)
        throw Object.assign(new Error("This engine is missing its AWS profile or region. Remove it and add it again."), { status: 409 });
    const fields = {
        awsProfile: body.awsProfile ?? saved.awsProfile,
        awsRegion: body.awsRegion ?? saved.awsRegion,
        model: body.model ?? entry.environment?.ANTHROPIC_MODEL,
    };
    if (body.displayName !== undefined)
        fields.displayName = body.displayName;
    for (const [field, key] of TIERS) {
        const value = body[field] !== undefined ? body[field] : entry.environment?.[key];
        if (value !== undefined)
            fields[field] = value;
    }
    instances[instanceId] = {
        ...entry,
        ...(fields.displayName ? { displayName: fields.displayName } : {}),
        environment: bedrockEnvironment(fields),
        config: {
            ...rawConfig(entry),
            bedrock: true,
            endpointModels: fields.model && (body.model !== undefined || TIERS.some(([field]) => body[field] !== undefined))
                ? bedrockModels(fields) : saved.models,
        },
    };
    return { instances };
}
