# AI Studio Hub ⚡

> **Unified Google Antigravity & OpenAI Codex Controller** with Real-Time Token Telemetry, Zero-Friction Context Handoff, Mobile PWA Interface, and Encrypted Cloudflare Tunnel Remote Access.

---

## 🌟 Key Features

### 1. 🔄 Seamless Antigravity $\leftrightarrow$ Codex Dual-Engine Architecture
* **Single Unified Interface:** Chat with Google Antigravity (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5 / Sonnet 5.5`, `GPT-OSS 120B`) and OpenAI Codex (`GPT-6.1-Sol`, `GPT-6-Astra`, `GPT-6.1 Terra`, `GPT-6-Luna`) side-by-side in one window.
* **Smart Auto-Pilot Failover:** Automatically monitors live remaining quota percentages. When your active engine drops below your chosen threshold (default `< 12%`) or hits a rate limit (429 / quota limit), it seamlessly fails over to the other engine mid-workflow.
* **Zero Re-Explaining:** When switching engines, AI Studio Hub automatically compiles and injects a structured context briefing (`SHARED_CONTEXT.md` & cross-app memory) so the new engine continues mid-thought with full knowledge of past decisions and next steps.

### 2. 🪙 Live Token Tracking & Real-Time Counters
* **Real-Time Ticking Counter:** Watches active turns as they stream (`🪙 X tokens ↑` and `⏱️ Xs`).
* **Turn-Isolated Token Badges:** Every prompt and assistant response displays exact token counts with breakdown tooltips (input vs. output vs. cache).
* **Quota Watchdog Bar:** Real-time quota percentages and reset timers across Antigravity model pools and Codex 5-Hour / 7-Day Rolling Windows.

### 3. 📱 Mobile App (PWA) & Encrypted Cloudflare Tunnel
* **Anywhere Phone Access:** Built-in Cloudflare Tunnel (`trycloudflare.com`) integration lets you control both Antigravity and Codex from your phone on cellular data.
* **Instant QR Code Pairing:** Click **`📱 Phone App`** on desktop, scan the QR code with your phone camera, and immediately open the Hub without typing passwords.
* **Add to Home Screen (PWA):** Installs as a fullscreen, native-feeling mobile app with standalone display, custom app icon, and collapsible touch drawer navigation.
* **6-Digit Mobile PIN Protection:** All remote connections without the pairing token are blocked behind a secure PIN authentication screen.

### 4. 🗂️ Universal Project Manager & File Attachments
* **Cross-App Sync:** Discovers all projects and conversation threads across Antigravity, OpenAI Codex CLI, Codex Desktop, and VS Code.
* **Native Windows Folder Picker:** Browse and select any folder on your machine with one click.
* **Drag-and-Drop Attachments:** Drop screenshots, code files, PDFs, or datasets directly into your prompt.

---

## 🚀 Quick Start

### Prerequisites
* [Node.js](https://nodejs.org/) (v18 or higher)
* [Google Antigravity](https://antigravity.google/) (`agy` CLI)
* [OpenAI Codex](https://github.com/openai/codex) (`codex` CLI)
* [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) (`cloudflared` - optional, for remote phone access)

### Launching

```bash
# Clone the repository
git clone https://github.com/mojtabasafdarimm-maker/AI-Studio-Hub.git
cd AI-Studio-Hub

# Start the Hub server
npm start
```

Or double-click `start-hub.vbs` on Windows for silent background startup without opening a terminal window.

Open [http://127.0.0.1:4747](http://127.0.0.1:4747) in your browser.

---

## 🔒 Security & Privacy

* **Local-First:** All files, conversation states, and session databases stay strictly on your local machine (`%LOCALAPPDATA%\AIStudioHub`).
* **Zero npm Dependencies:** Built using pure Node.js standard libraries (`http`, `fs`, `crypto`, `child_process`) for maximum performance, security, and zero supply-chain risk.
* **Encrypted Remote Tunnels:** Cloudflare Tunnel operates over end-to-end encrypted HTTPS; only paired devices with the authentication token or 6-digit PIN can access API endpoints.

---

## 📄 License

MIT © [Mojtaba Safdari](https://github.com/mojtabasafdarimm-maker)
