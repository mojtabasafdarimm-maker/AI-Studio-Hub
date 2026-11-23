// hub-mcp.mjs — Stdio MCP server exposing AI Studio Hub superpowers to every OpenMausBot agent:
// • hub_stalled_tasks: Unfinished/stalled tasks across Antigravity, Codex, and VS Code
// • hub_search_conversations: Full-text search across all native chats
// • hub_read_conversation: Read recent turns from any native Antigravity/Codex/VS Code chat
// • hub_quota_status: Real-time Antigravity & Codex 5h/7d quotas + Auto-Pilot recommendation
// • hub_calendar_and_reminders: Check upcoming calendar events & reminders, or add a reminder
import readline from 'node:readline';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import {
  buildStalledRadar,
  findAgyBin,
  getAutoPilotRecommendation,
  getBestCodexBin,
  getUnifiedAccountAllowances,
  loadMuseState,
  readNativeTranscript,
  saveMuseState,
  searchNativeConversations,
  syncHubCalendars
} from './hub-core.mjs';

const TOOLS = [
  {
    name: 'hub_stalled_tasks',
    description: 'Scan all recent conversations across Antigravity, Codex CLI, and VS Code to find tasks the user started and left unfinished or paused mid-flight.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'hub_search_conversations',
    description: 'Search across all native Antigravity, Codex, and VS Code conversations by keyword or topic.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or topic to search for (e.g. "VCWG", "external examiners", "cloudflare")' },
        limit: { type: 'number', description: 'Max results to return (default 8)' }
      },
      required: ['query']
    }
  },
  {
    name: 'hub_read_conversation',
    description: 'Read the recent messages of a native Antigravity, Codex, or VS Code conversation by its thread ID so you can summarize it or continue the work.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Thread ID returned by hub_search_conversations or hub_stalled_tasks' },
        maxMessages: { type: 'number', description: 'Max recent messages to read (default 20)' }
      },
      required: ['threadId']
    }
  },
  {
    name: 'hub_send_prompt',
    description: 'Send a prompt directly into an existing native Antigravity, Codex, or VS Code conversation by its thread ID and return the reply.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Thread ID (e.g. agy-... or codex-... or vscode-...) from hub_search_conversations' },
        prompt: { type: 'string', description: 'The prompt/message to send into that conversation' }
      },
      required: ['threadId', 'prompt']
    }
  },
  {
    name: 'hub_quota_status',
    description: 'Get live remaining allowances, per-model quotas, and exact reset times across ALL connected accounts (OpenAI Codex + all Google Gemini / Antigravity accounts) plus smart routing recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Force a live refresh from provider quota endpoints (default true)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'hub_account_allowances',
    description: 'Inspect live remaining allowance percentages, 5-hour and weekly reset timestamps, per-model pools, assigned bots, and smart account-selection advice across ALL connected Codex and Google/Antigravity accounts. Use this to decide which account/model to use based on remaining allowance and reset timing.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Force live refresh (default true)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'hub_switch_bot_account',
    description: 'Switch any OpenMausBot agent to a different connected AI account/instance and model (e.g., moving a bot from a low-quota Codex account to a fresh Antigravity/Gemini account based on hub_account_allowances).',
    inputSchema: {
      type: 'object',
      properties: {
        botName: { type: 'string', description: 'Bot name (e.g. "Grader", "Parlez", "GlenNeely", "khadang") or botId' },
        account: { type: 'string', description: 'Target account email (e.g. "mojtaba.safdari.mm@gmail.com", "mojtaba.safdari.ms@gmail.com", "mina.khoshbazmf@gmail.com"), displayName (e.g. "Mojtaba.mm", "mojtaba", "Codex"), or instanceId' },
        model: { type: 'string', description: 'Optional model ID (e.g. "gemini-3.8-flash", "gemini-4-neon", "gpt-6.2-sol", "gpt-6-luna"). Defaults to the account default model.' },
        effort: { type: 'string', description: 'Optional Codex effort level (low, medium, high)' },
        variant: { type: 'string', description: 'Optional Antigravity model variant (low, medium, high)' }
      },
      required: ['botName', 'account']
    }
  },
  {
    name: 'hub_calendar_and_reminders',
    description: 'List upcoming calendar events and personal reminders, or add a new reminder.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add_reminder'], description: 'Action to perform (default list)' },
        title: { type: 'string', description: 'Reminder title when action is add_reminder' },
        dueAt: { type: 'string', description: 'Optional ISO-8601 due date/time for the reminder' }
      }
    }
  },
  {
    name: 'hub_outlook_emails',
    description: 'Access the user\'s work/university Outlook (Classic Outlook on Windows) inbox without Microsoft cloud OAuth: list recent emails, search by keyword, read full email body, create a draft, or send an email.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read', 'draft', 'send'], description: 'Action to perform (default list)' },
        query: { type: 'string', description: 'Search text for subject, sender, or body (for action=search)' },
        entryId: { type: 'string', description: 'Email EntryID returned by list/search (for action=read)' },
        to: { type: 'string', description: 'Recipient email address(es), semicolon-separated (for draft/send)' },
        from: { type: 'string', description: 'Optional sender email address (e.g. msafdari@uoguelph.ca) to explicitly pick the Outlook sending account' },
        subject: { type: 'string', description: 'Email subject (for draft/send)' },
        body: { type: 'string', description: 'Email body text (for draft/send)' },
        limit: { type: 'number', description: 'Max emails to return for list/search (default 15, max 40)' }
      }
    }
  },
  {
    name: 'hub_outlook_calendar',
    description: 'Read or create events in the user\'s work/university Classic Outlook calendar on Windows.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create'], description: 'Action to perform (default list)' },
        days: { type: 'number', description: 'Number of days ahead to list (default 7)' },
        subject: { type: 'string', description: 'Event title (for action=create)' },
        start: { type: 'string', description: 'Start date/time ISO or local string (for action=create)' },
        end: { type: 'string', description: 'End date/time ISO or local string (for action=create)' },
        location: { type: 'string', description: 'Optional event location' },
        body: { type: 'string', description: 'Optional event description' }
      }
    }
  }
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleToolCall(name, args = {}) {
  if (name === 'hub_stalled_tasks') {
    const radar = buildStalledRadar();
    return { content: [{ type: 'text', text: JSON.stringify(radar, null, 2) }] };
  }
  if (name === 'hub_search_conversations') {
    const matches = searchNativeConversations(args.query || '', Math.min(20, Number(args.limit || 8)));
    return { content: [{ type: 'text', text: JSON.stringify({ query: args.query, matches }, null, 2) }] };
  }
  if (name === 'hub_read_conversation') {
    const conv = readNativeTranscript(args.threadId || '', Math.min(40, Number(args.maxMessages || 20)));
    if (!conv) return { content: [{ type: 'text', text: `Conversation not found: ${args.threadId}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(conv, null, 2) }] };
  }
  if (name === 'hub_send_prompt') {
    const threadId = String(args.threadId || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!threadId || !prompt) {
      return { content: [{ type: 'text', text: 'threadId and prompt are required.' }], isError: true };
    }
    const conv = readNativeTranscript(threadId, 16);
    if (!conv) {
      return { content: [{ type: 'text', text: `Conversation not found: ${threadId}` }], isError: true };
    }
    const cwd = conv.projectPath && fs.existsSync(conv.projectPath) ? conv.projectPath : process.cwd();
    const isAgy = conv.origin === 'antigravity';
    const bin = isAgy ? findAgyBin() : getBestCodexBin();
    const cliArgs = isAgy
      ? ['--conversation', conv.nativeId, '--print', prompt, '--dangerously-skip-permissions']
      : ['exec', 'resume', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', conv.nativeId, prompt];

    const runCli = (exe, args) => new Promise((resolve, reject) => {
      execFile(
        exe,
        args,
        { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const out = (stdout || '').trim();
          const errText = (stderr || err?.message || '').trim();
          if (err && !out) return reject(new Error(errText || 'CLI execution failed'));
          resolve(out || errText);
        }
      );
    });

    try {
      const output = await runCli(bin, cliArgs);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, mode: 'direct-resume', origin: conv.origin, threadId: conv.id, title: conv.title, reply: output }, null, 2) }] };
    } catch (firstErr) {
      // Antigravity IDE conversations (.db) cannot always be attached directly via `agy --conversation`.
      // Fall back to continuing with the conversation's recent transcript in the exact project workspace.
      const historyText = (conv.messages || [])
        .slice(-12)
        .map((m) => `[${m.role.toUpperCase()}]: ${String(m.content || '').slice(0, 800)}`)
        .join('\n\n');
      const continuationPrompt = [
        `Continue this ${conv.origin.toUpperCase()} conversation ("${conv.title}", workspace: ${cwd}).`,
        historyText ? `\nRecent conversation context:\n${historyText}` : '',
        `\nNew user instruction to execute now:\n${prompt}`
      ].filter(Boolean).join('\n');

      try {
        const fallbackArgs = isAgy
          ? ['--print', continuationPrompt, '--dangerously-skip-permissions']
          : ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', continuationPrompt];
        const output = await runCli(bin, fallbackArgs);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, mode: 'context-continuation', origin: conv.origin, threadId: conv.id, title: conv.title, reply: output }, null, 2) }] };
      } catch (secondErr) {
        // Final fallback to Codex CLI if agy CLI is unavailable or errored
        const codexBin = getBestCodexBin();
        const output = await runCli(codexBin, ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', continuationPrompt]);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, mode: 'codex-continuation', origin: conv.origin, threadId: conv.id, title: conv.title, reply: output }, null, 2) }] };
      }
    }
  }
  if (name === 'hub_quota_status' || name === 'hub_account_allowances') {
    const refresh = args.refresh !== false;
    try {
      const res = await fetch(`http://127.0.0.1:4747/api/hub/allowances?refresh=${refresh ? '1' : '0'}`, {
        signal: AbortSignal.timeout(18000)
      });
      if (res.ok) {
        const data = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
    } catch {}
    const fallback = await getUnifiedAccountAllowances({ refresh });
    return { content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }] };
  }
  if (name === 'hub_switch_bot_account') {
    try {
      const res = await fetch('http://127.0.0.1:4747/api/hub/switch-bot-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botName: args.botName,
          account: args.account,
          model: args.model,
          effort: args.effort,
          variant: args.variant
        }),
        signal: AbortSignal.timeout(12000)
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: !res.ok };
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  }
  if (name === 'hub_calendar_and_reminders') {
    if (args.action === 'add_reminder' && args.title) {
      const state = loadMuseState();
      const rem = {
        id: `rem_${Date.now().toString(36)}`,
        title: String(args.title).trim(),
        dueAt: args.dueAt ? new Date(args.dueAt).toISOString() : null,
        completed: false,
        notified: false,
        createdAt: new Date().toISOString()
      };
      state.reminders.unshift(rem);
      saveMuseState({ reminders: state.reminders });
      return { content: [{ type: 'text', text: `Added reminder: ${JSON.stringify(rem)}` }] };
    }
    const events = await syncHubCalendars(false);
    const state = loadMuseState();
    const now = Date.now();
    const upcoming = (events || []).filter((e) => (e.endMs || 0) >= now - 1800000).slice(0, 15);
    return { content: [{ type: 'text', text: JSON.stringify({ upcomingEvents: upcoming, reminders: state.reminders || [] }, null, 2) }] };
  }
  if (name === 'hub_outlook_emails' || name === 'hub_outlook_calendar') {
    const action = String(args.action || 'list');
    const payloadB64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    const psHeader = `
$ErrorActionPreference = 'Stop'
$rawJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payloadB64}'))
$argsObj = $rawJson | ConvertFrom-Json
try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { $ol = New-Object -ComObject Outlook.Application }
$ns = $ol.GetNamespace('MAPI')
`;
    const psBody = name === 'hub_outlook_emails' ? `
$inbox = $ns.GetDefaultFolder(6)
$act = if ($argsObj.action) { [string]$argsObj.action } else { 'list' }
$limit = if ($argsObj.limit) { [Math]::Min(40, [Math]::Max(1, [int]$argsObj.limit)) } else { 15 }
if ($act -eq 'read') {
  $item = $ns.GetItemFromID([string]$argsObj.entryId)
  $out = [ordered]@{
    entryId = $item.EntryID
    subject = $item.Subject
    from = $item.SenderName
    fromEmail = $item.SenderEmailAddress
    to = $item.To
    receivedAt = if ($item.ReceivedTime) { $item.ReceivedTime.ToString('o') } else { $null }
    unread = [bool]$item.UnRead
    body = $item.Body
  }
  $out | ConvertTo-Json -Depth 4
} elseif ($act -eq 'draft' -or $act -eq 'send') {
  $mail = $ol.CreateItem(0)
  $targetFrom = if ($argsObj.from) { [string]$argsObj.from } else { '' }
  $chosenAcct = $null
  foreach ($acct in $ns.Accounts) {
    if ($targetFrom -and $acct.SmtpAddress -ieq $targetFrom) { $chosenAcct = $acct; break }
    if (-not $targetFrom -and -not $chosenAcct) { $chosenAcct = $acct }
  }
  if ($targetFrom -and -not $chosenAcct) {
    throw "Outlook account '$targetFrom' not found. Available: $(($ns.Accounts | ForEach-Object { $_.SmtpAddress }) -join ', ')"
  }
  if ($chosenAcct) { $mail.SendUsingAccount = $chosenAcct }
  $mail.To = [string]$argsObj.to
  $mail.Subject = [string]$argsObj.subject
  $mail.Body = [string]$argsObj.body
  $fromAddr = if ($chosenAcct) { $chosenAcct.SmtpAddress } else { ($ns.Accounts | Select-Object -First 1).SmtpAddress }
  if ($act -eq 'send') { $mail.Send(); $status = 'sent' } else { $mail.Save(); $status = 'saved_draft' }
  [ordered]@{ ok = $true; status = $status; from = $fromAddr; to = [string]$argsObj.to; subject = [string]$argsObj.subject } | ConvertTo-Json
} else {
  $items = $inbox.Items
  $items.Sort('[ReceivedTime]', $true)
  $q = if ($argsObj.query) { [string]$argsObj.query } else { '' }
  $res = @()
  $scanned = 0
  foreach ($it in $items) {
    if ($scanned -ge 250 -and $q) { break }
    $scanned++
    if ($it.Class -ne 43) { continue }
    $subj = [string]$it.Subject
    $sndr = [string]$it.SenderName
    $sndEmail = [string]$it.SenderEmailAddress
    if ($q) {
      $bodySnippet = [string]$it.Body
      if ($subj -notmatch [regex]::Escape($q) -and $sndr -notmatch [regex]::Escape($q) -and $sndEmail -notmatch [regex]::Escape($q) -and $bodySnippet -notmatch [regex]::Escape($q)) {
        continue
      }
    }
    $preview = ([string]$it.Body -replace '\\s+', ' ').Trim()
    if ($preview.Length -gt 220) { $preview = $preview.Substring(0, 220) + '...' }
    $res += [ordered]@{
      entryId = $it.EntryID
      subject = $subj
      from = $sndr
      fromEmail = $sndEmail
      receivedAt = if ($it.ReceivedTime) { $it.ReceivedTime.ToString('o') } else { $null }
      unread = [bool]$it.UnRead
      preview = $preview
    }
    if ($res.Count -ge $limit) { break }
  }
  [ordered]@{ account = ($ns.Accounts | ForEach-Object { $_.SmtpAddress }) -join ', '; offline = [bool]$ns.Offline; connectionMode = [int]$ns.ExchangeConnectionMode; count = $res.Count; emails = @($res) } | ConvertTo-Json -Depth 4
}
` : `
$cal = $ns.GetDefaultFolder(9)
$act = if ($argsObj.action) { [string]$argsObj.action } else { 'list' }
if ($act -eq 'create') {
  $appt = $ol.CreateItem(1)
  $appt.Subject = [string]$argsObj.subject
  $appt.Start = [datetime]::Parse([string]$argsObj.start)
  $appt.End = if ($argsObj.end) { [datetime]::Parse([string]$argsObj.end) } else { $appt.Start.AddHours(1) }
  if ($argsObj.location) { $appt.Location = [string]$argsObj.location }
  if ($argsObj.body) { $appt.Body = [string]$argsObj.body }
  $appt.Save()
  [ordered]@{ ok = $true; subject = $appt.Subject; start = $appt.Start.ToString('o'); end = $appt.End.ToString('o') } | ConvertTo-Json
} else {
  $days = if ($argsObj.days) { [Math]::Min(60, [Math]::Max(1, [int]$argsObj.days)) } else { 7 }
  $now = Get-Date
  $endDt = $now.AddDays($days)
  $items = $cal.Items
  $items.IncludeRecurrences = $true
  $items.Sort('[Start]')
  $filter = "[Start] >= '" + $now.AddHours(-2).ToString('g') + "' AND [Start] <= '" + $endDt.ToString('g') + "'"
  $restricted = $items.Restrict($filter)
  $evts = @()
  foreach ($e in $restricted) {
    if ($e.Class -ne 26) { continue }
    $evts += [ordered]@{
      subject = [string]$e.Subject
      start = $e.Start.ToString('o')
      end = $e.End.ToString('o')
      location = [string]$e.Location
      organizer = [string]$e.Organizer
    }
    if ($evts.Count -ge 40) { break }
  }
  [ordered]@{ account = ($ns.Accounts | ForEach-Object { $_.SmtpAddress }) -join ', '; count = $evts.Count; events = @($evts) } | ConvertTo-Json -Depth 4
}
`;
    const encoded = Buffer.from(psHeader + '\n' + psBody, 'utf16le').toString('base64');
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          if (err && !stdout.trim()) return reject(new Error(stderr || err.message));
          resolve(stdout.trim());
        });
      });
      return { content: [{ type: 'text', text: out || '{}' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Classic Outlook error (make sure Outlook Classic is open): ${err.message}` }], isError: true };
    }
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notification

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ai-studio-hub', version: '1.0.0' }
        }
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const result = await handleToolCall(params?.name, params?.arguments);
      send({ jsonrpc: '2.0', id, result });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: err?.message || String(err) } });
  }
});
