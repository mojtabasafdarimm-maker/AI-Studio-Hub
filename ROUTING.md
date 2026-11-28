# AI Studio Hub — Routing Table

Which account and model each kind of work should use, what happens when an account runs low,
and the reserve rules. Source of truth for bots and for the Hub watchdog (`hub-watchdog.mjs`).
Thresholds live in `%LOCALAPPDATA%\AIStudioHub\watchdog-config.json`.

## Accounts

| Account | Instance ID | Plan | Use it for |
|---|---|---|---|
| **Mojtaba.mm** | `antigravity-803cef99-77bf-4686-b428-149233bd1050` | Google AI Pro | Default home for Gemini work. Heavy: `gemini-pro-orchestrator-neon`. Standard: `gemini-4-carbon`. Light: `gemini-3.8-flash`. |
| **Google Gemini (Antigravity)** (Mina) | `antigravity` | Google AI Pro (v1.4.3) | Always-on light watch work (`gemini-3.8-flash`), and second fallback. |
| **mojtaba** (free) | `antigravity-78fdf303-92f9-41a2-bc00-5fc57f32c39c` | Free tier | Last-resort fallback only. No always-on or heavy bots. |
| **Codex** | `codex` | ChatGPT Plus | **Reserved for GlenNeely.** Conserve weekly quota. |
| **Claude** | `claude-4555334c-65b2-45bf-b8ac-49bb946b7364` | Claude subscription | Hub admin, thesis writing, khadang/Comet (Haiku), Neely River engine. |

Never assign `Argon` models unless Moji asks for them.

## Bots: home account and model

| Bot | Work type | Home account / model | Tier |
|---|---|---|---|
| GlenNeely | NEoWave lead architect | Codex / `gpt-6.2-sol` | reserved |
| GlenTween | NEoWave validation | Mojtaba.mm / `gemini-4-carbon` | standard |
| Neely River Engine Builder | Trading engine code | Claude / `claude-sonnet-5` | standard |
| AKTUATE Lead | Web app project lead | Mojtaba.mm / `gemini-4-neon` | heavy |
| AI Studio Hub Lead | Hub admin and code | Claude / `claude-opus-5-5` | heavy |
| Thesis & Research Assistant | Long-form academic writing | Claude / `claude-opus-5-5` | heavy |
| PhD & Defense Coordinator | Planning and coordination | Mojtaba.mm / `gemini-4-carbon` | standard |
| khadang | Chief of Staff, routines, alerts | Claude / `claude-haiku-5-5` | light |
| Comet | Email, calendar, messages | Claude / `claude-haiku-5-5` | light |
| Conference & Career Scout | Scheduled web scouting | Mojtaba.mm / `gemini-3.8-flash` | light |
| Grader | Grading help | Mojtaba.mm / `gemini-3.8-flash` | light |
| Parlez | French practice | Mina / `gemini-3.8-flash` | light |
| AI News Scout | Daily news scan | Codex / `gpt-6-luna` | standard (consider moving off Codex to protect GlenNeely's quota) |

## Automatic quota moves (watchdog, every 5 minutes)

- **Move:** when a bot's account/model has **≤ 8%** left (the lower of its 5-hour and weekly windows).
  Exception: if only the 5-hour window is low and it resets within 45 minutes, the bot waits.
- **Tier** comes from the model name (`modelTiers` in the router policy): Opus, Neon, Orchestrator, gpt-6.2 = heavy; Haiku, Flash = light; everything else = standard.
- **Target:** the first account in the bot's tier chain that has **≥ 25%** left:

| Tier | 1st choice | 2nd | 3rd |
|---|---|---|---|
| heavy | Mojtaba.mm `gemini-pro-orchestrator-neon` | Mina `gemini-4-neon` | mojtaba `gemini-3.8-flash` |
| standard | Mojtaba.mm `gemini-4-carbon` | Mina `gemini-4-carbon` | mojtaba `gemini-3.8-flash` |
| light | Mojtaba.mm `gemini-3.8-flash` | Mina `gemini-3.8-flash` | mojtaba `gemini-3.8-flash` |

- **Restore:** the bot moves back to its home account once that account has **≥ 40%** left and at least 30 minutes have passed.
- **Manual wins:** if Moji changes a moved bot's model by hand, the watchdog cancels its pending restore.
- **Reserve:** GlenNeely stays on Codex unless Codex itself drops to ≤ 2%.
- Every move and restore appears in the dashboard (`/dashboard`) and in khadang's alerts.

## Coordination rules (apply to every bot)

- Bot-to-bot reviews stop after **2 rounds**. Then a short decision summary goes to Moji.
- Bots do not undo automatic quota moves.
- Moji gets alerts for: bots waiting on him for more than 30 minutes, tasks stuck for 2+ hours,
  failed tasks or routines, and accounts that are running out.
