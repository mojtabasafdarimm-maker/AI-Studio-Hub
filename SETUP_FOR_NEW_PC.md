# AI Studio Hub — Complete Setup & Handoff Guide (New Windows PC)

This guide sets up a **100% independent** copy of **AI Studio Hub** (OpenMausBot + Mobile Live Sync + Google Drive Backup + Classic Outlook + My Chrome + Composio Apps + Antigravity/Codex Bridge) on a new Windows computer, with **your own** accounts and **your own** private phone URL.

---

## 1. Install Prerequisites on the New PC

1. **Node.js (v22 or newer):** https://nodejs.org
2. **Git for Windows:** https://git-scm.com
3. **Cloudflare Tunnel (`cloudflared`):**
   ```powershell
   winget install Cloudflare.cloudflared
   ```
4. **Google Chrome:** Install standard Google Chrome (used for **My Chrome**, so bots can share your real signed-in browser tabs).
5. **Classic Outlook (Important for Work / University Email):**
   - If you use **New Outlook**, open Outlook and toggle **"New Outlook" OFF** (top-right switch) so **Classic Outlook** (`OUTLOOK.EXE`) is installed and open, or install Classic Outlook from Microsoft 365.
   - Sign into your work/university/personal email in Classic Outlook and keep it open or minimized in the background.
   - *Why:* Work and university Microsoft accounts block cloud OAuth apps like Composio, whereas Classic Outlook lets the Hub's `hub_outlook_emails` and `hub_outlook_calendar` tools read, search, draft, and send directly from your chosen `from` address.
6. **Google Drive for Desktop (Recommended for Automatic Backup):**
   - Sign into **your** Google Drive (`My Drive`), and put the `AI-Studio-Hub` folder inside `My Drive` (e.g. `C:\Users\<YourName>\My Drive\AI-Studio-Hub`).
   - The server automatically mirrors all bots, memories, sessions, and `messages.db` into `cloud-sync/` every 3 minutes.
7. **AI Engines (at least one):**
   - **OpenAI Codex CLI** (via ChatGPT Plus/Pro or Codex Desktop) — run `codex login` to sign into **your** OpenAI/ChatGPT account.
   - **Google Antigravity** (optional) — install and sign into **your** Google account.

---

## 2. Clone & Install the Package

Open PowerShell in your `My Drive` (or chosen folder):

```powershell
git clone https://github.com/mojtabasafdarimm-maker/AI-Studio-Hub.git
cd AI-Studio-Hub
npm install
cd openmausbot
npm install
cd ..
```

*(Note: Make sure there is no `cloud-sync/` folder or `.env` copied from another person's PC so you start clean with your own data.)*

---

## 3. Create Your Own Permanent Phone URL (Cloudflare Worker)

1. Sign up / log in at https://dash.cloudflare.com (free tier works).
2. In PowerShell inside `AI-Studio-Hub\gateway-worker`:
   ```powershell
   cd gateway-worker
   npx wrangler login
   npx wrangler kv namespace create GATEWAY_KV
   ```
3. Copy the `id = "..."` printed by the command into `gateway-worker\wrangler.toml` (replace the existing KV `id`), and choose a new `GATEWAY_SECRET` string in `wrangler.toml`.
4. Deploy your worker:
   ```powershell
   npx wrangler deploy
   ```
   Save the printed URL (e.g. `https://ai-studio-hub.<your-subdomain>.workers.dev`).

---

## 4. Create Your `.env` File

Create a file named `.env` inside `AI-Studio-Hub\` with **your** values:

```env
GATEWAY_URL=https://ai-studio-hub.<your-subdomain>.workers.dev
GATEWAY_SECRET=<your-gateway-secret-from-wrangler.toml>
COMPOSIO_API_KEY=ak_<your-composio-key>
```

- **Composio API Key (Free, for Gmail / Google Calendar / Google Drive / GitHub / LinkedIn):**
  1. Sign up at https://dashboard.composio.dev
  2. Go to **Project Settings → API Keys** and copy your `ak_...` key into `.env`.

---

## 5. Connect Your Real Google Chrome (`My Chrome`)

Modern Chrome blocks remote debugging on its default `User Data` folder, so create a dedicated Chrome shortcut that keeps all your logins saved:

1. Create a Desktop shortcut named **`Chrome (AI Hub)`** pointing to:
   - **Target:** `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\<YourName>\AppData\Local\AIStudioHub\chrome-ai-hub" --no-first-run`
   *(If Chrome is in `Program Files (x86)`, adjust the path.)*
2. Double-click **`Chrome (AI Hub)`** and sign in once to the websites you want bots to help with (CourseLink, Outlook Web, LinkedIn, etc.).
3. Once the Hub is running, open **Settings → Browser** (or tell your AI assistant) to set:
   - `browserEngine.attachCdpUrl = "http://127.0.0.1:9222"`
   - Add a `My Chrome` profile (`{ id: "my-chrome", name: "My Chrome", browser: "chrome" }`)

---

## 6. Start AI Studio Hub

```powershell
cd "C:\Users\<YourName>\My Drive\AI-Studio-Hub"
node server.js
```

- **On your computer:** Open http://127.0.0.1:4747
- **On your phone:** Open your `https://ai-studio-hub.<your-subdomain>.workers.dev` URL (no pairing code needed—auto-login is built in).

---

## 7. First-Time Checklist Inside the App

1. **Connect Apps (Composio):** Go to **Settings → Connected Apps** and click **Connect** on Gmail, Google Calendar, Google Drive, GitHub, LinkedIn, etc. (if your browser blocks the pop-up, tap **Sign In ↗** in the banner at the top).
2. **Verify Classic Outlook:** Keep Classic Outlook open on your PC—any bot can now use `hub_outlook_emails` and `hub_outlook_calendar` directly.
3. **Full Permissions:** Set each bot's approval mode to **Full** in Bot Settings so it can read/write files in your `My Drive` and run PowerShell commands smoothly.
