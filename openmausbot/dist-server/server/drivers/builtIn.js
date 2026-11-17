import { AntigravityDriver } from "./antigravity.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { GrokDriver } from "./grok.js";
import { GrokAgentDriver } from "./acp/grok.js";
import { GeminiAgentDriver } from "./acp/gemini.js";
import { KimiAgentDriver } from "./acp/kimi.js";
import { DroidAgentDriver } from "./acp/droid.js";
import { CursorAgentDriver } from "./acp/cursor.js";
import { OpenCodeDriver } from "./acp/opencode-go.js";
import { QwenAgentDriver } from "./acp/qwen.js";
import { CustomAcpDriver } from "./acp/custom.js";
import { HermesAgentDriver } from "./acp/hermes.js";
import { DeepSeekAgentDriver } from "./acp/deepseek.js";
import { ClineAgentDriver } from "./acp/cline.js";
import { CopilotAgentDriver } from "./acp/copilot.js";
import { CommandCodeAgentDriver } from "./acp/command-code.js";
import { KiroAgentDriver } from "./acp/kiro.js";
import { DevinAgentDriver } from "./acp/devin.js";
import { OmpAgentDriver } from "./acp/omp.js";
import { MistralVibeAgentDriver } from "./acp/mistral-vibe.js";
import { OpenAICompatDriver } from "./openai-compat.js";
import { PiDriver } from "./pi.js";
import { MistralDriver } from "./mistral.js";
import { CerebrasDriver } from "./cerebras.js";
import { GroqDriver } from "./groq.js";
import { GreenferenceDriver } from "./greenference.js";
import { ModelgoDriver } from "./modelgo.js";
import { MetaDriver } from "./meta.js";
import { MuseCodeDriver } from "./muse-code.js";
import { MinimaxDriver } from "./minimax.js";
export const BUILT_IN_DRIVERS = [
    GrokDriver,
    GrokAgentDriver,
    GeminiAgentDriver,
    KimiAgentDriver,
    DroidAgentDriver,
    CursorAgentDriver,
    OpenCodeDriver,
    QwenAgentDriver,
    HermesAgentDriver,
    ClineAgentDriver,
    CopilotAgentDriver,
    CommandCodeAgentDriver,
    KiroAgentDriver,
    DevinAgentDriver,
    OmpAgentDriver,
    MistralVibeAgentDriver,
    CustomAcpDriver,
    PiDriver,
    OpenAICompatDriver,
    ClaudeDriver,
    CodexDriver,
    AntigravityDriver,
    MinimaxDriver,
    MistralDriver,
    CerebrasDriver,
    GroqDriver,
    GreenferenceDriver,
    ModelgoDriver,
    MetaDriver,
    MuseCodeDriver,
    DeepSeekAgentDriver,
];
