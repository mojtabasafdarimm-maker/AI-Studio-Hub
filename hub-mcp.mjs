// hub-mcp.mjs — Stdio MCP server exposing AI Studio Hub superpowers to every OpenMausBot agent:
// • hub_stalled_tasks: Unfinished/stalled tasks across Antigravity, Codex, and VS Code
// • hub_search_conversations: Full-text search across all native chats
// • hub_read_conversation: Read recent turns from any native Antigravity/Codex/VS Code chat
// • hub_quota_status: Real-time Antigravity & Codex 5h/7d quotas + Auto-Pilot recommendation
// • hub_calendar_and_reminders: Check upcoming calendar events & reminders, or add a reminder
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  OMB_DATA_DIR,
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
import { applyRoute, routeTask } from './hub-router.mjs';

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
    name: 'hub_route_task',
    description: 'Automatically pick the best account and model for a task using live account allowances (5h/weekly headroom, reset times) and online OpenRouter $/1M token pricing as a cost weight. Set apply=true to immediately switch the bot to the chosen account and model.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Task description or prompt to classify (light / standard / heavy)' },
        botName: { type: 'string', description: 'Target bot name (e.g. "khadang", "Grader", "GlenNeely")' },
        tier: { type: 'string', enum: ['light', 'standard', 'heavy'], description: 'Optional override for task complexity tier' },
        apply: { type: 'boolean', description: 'If true, immediately switch botName to the recommended account and model (default false)' }
      },
      required: ['text']
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
    description: 'Access the user\'s work/university Outlook (Classic Outlook on Windows) without Microsoft cloud OAuth: list or search Inbox, Sent Items, or Drafts with reply-status verification, read full email bodies, run audit_open_loops across read & unread emails to catch academic peer reviews and open student/colleague loops, create drafts, or send emails.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read', 'draft', 'send', 'audit_open_loops'], description: 'Action to perform (default list)' },
        folder: { type: 'string', enum: ['inbox', 'sent', 'drafts'], description: 'Outlook folder for list/search (default inbox)' },
        query: { type: 'string', description: 'Search text for subject, sender, or body (for action=search)' },
        days: { type: 'number', description: 'Lookback window in days (1-90; default 30 for audit_open_loops; optional date restriction for list/search)' },
        unrepliedOnly: { type: 'boolean', description: 'For inbox list/search: return only emails with no reply sent yet' },
        entryId: { type: 'string', description: 'Email EntryID returned by list/search (for action=read)' },
        to: { type: 'string', description: 'Recipient email address(es), semicolon-separated (for draft/send)' },
        from: { type: 'string', description: 'Optional sender email address (e.g. msafdari@uoguelph.ca) to explicitly pick the Outlook sending account' },
        subject: { type: 'string', description: 'Email subject (for draft/send)' },
        body: { type: 'string', description: 'Email body text (for draft/send)' },
        limit: { type: 'number', description: 'Max emails to return for list/search (default 15, max 50; max 30 per bucket for audit_open_loops)' }
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
        signal: AbortSignal.timeout(26000)
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && ((Array.isArray(data.accounts) && data.accounts.length > 0) || (data.disconnected || []).length > 0)) {
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
      }
    } catch {}
    let authHeaders = {};
    try {
      const tokenPath = path.join(OMB_DATA_DIR, 'master-token.txt');
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        if (token) authHeaders = { Authorization: `Bearer ${token}` };
      }
    } catch {}
    const fallback = await getUnifiedAccountAllowances({ refresh, authHeaders });
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
  if (name === 'hub_route_task') {
    try {
      const result = await routeTask({ text: args.text, botName: args.botName, tier: args.tier });
      if (args.apply && result.ok && result.recommendation && args.botName) {
        result.applied = await applyRoute(args.botName, result.recommendation);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.ok };
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
function Get-SmtpAddress($it) {
  $addr = [string]$it.SenderEmailAddress
  try {
    if ([string]$it.SenderEmailType -eq 'EX' -and $it.Sender) {
      $ex = $it.Sender.GetExchangeUser()
      if ($ex -and $ex.PrimarySmtpAddress) { return [string]$ex.PrimarySmtpAddress }
    }
  } catch {}
  return $addr
}
function Get-VerbCode($it) {
  try {
    $v = $it.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x10810003')
    if ($null -ne $v) { return [int]$v }
  } catch {}
  return 0
}
function Get-SentConvData($ns, [int]$lookbackDays, [bool]$collectHuman) {
  $sentFolder = $ns.GetDefaultFolder(5)
  $cutoffStr = (Get-Date).AddDays(-$lookbackDays).ToString('g')
  $sitems = $sentFolder.Items.Restrict("[SentOn] >= '$cutoffStr'")
  $sitems.Sort('[SentOn]', $true)
  $convMap = @{}
  $humanList = @()
  foreach ($sit in $sitems) {
    if ($sit.Class -ne 43) { continue }
    $cid = [string]$sit.ConversationID
    $sentOn = $sit.SentOn
    if ($cid -and $sentOn) {
      if (-not $convMap.ContainsKey($cid) -or $sentOn -gt $convMap[$cid]) {
        $convMap[$cid] = $sentOn
      }
    }
    if ($collectHuman -and $sentOn) {
      $humanList += [PSCustomObject]@{
        conversationId = $cid
        subject = [string]$sit.Subject
        to = [string]$sit.To
        sentOn = $sentOn
        body = [string]$sit.Body
      }
    }
  }
  return @{ convMap = $convMap; humanList = $humanList }
}

$act = if ($argsObj.action) { [string]$argsObj.action } else { 'list' }
if ($act -eq 'read') {
  $item = $ns.GetItemFromID([string]$argsObj.entryId)
  $verb = Get-VerbCode $item
  $lastVerb = switch ($verb) { 102 { 'replied' } 103 { 'replied_all' } 104 { 'forwarded' } default { $null } }
  $out = [ordered]@{
    entryId = $item.EntryID
    subject = [string]$item.Subject
    from = [string]$item.SenderName
    fromEmail = (Get-SmtpAddress $item)
    to = [string]$item.To
    receivedAt = if ($item.ReceivedTime) { $item.ReceivedTime.ToString('o') } else { $null }
    unread = [bool]$item.UnRead
    conversationId = [string]$item.ConversationID
    flagStatus = [int]$item.FlagStatus
    lastVerb = $lastVerb
    replied = ($verb -in @(102, 103))
    body = [string]$item.Body
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
} elseif ($act -eq 'audit_open_loops') {
  $now = Get-Date
  $days = if ($argsObj.days) { [Math]::Min(90, [Math]::Max(7, [int]$argsObj.days)) } else { 30 }
  $cap = if ($argsObj.limit) { [Math]::Min(30, [Math]::Max(5, [int]$argsObj.limit)) } else { 25 }
  $inbox = $ns.GetDefaultFolder(6)
  $cutoffStr = $now.AddDays(-$days).ToString('g')
  $items = $inbox.Items.Restrict("[ReceivedTime] >= '$cutoffStr'")
  $items.Sort('[ReceivedTime]', $true)

  $sentData = Get-SentConvData $ns ($days + 14) $true
  $sentConvLatest = $sentData.convMap
  $sentHumanList = $sentData.humanList
  $inboundConvLatest = @{}
  $seenInboundConvs = @{}
  $submittedManuscripts = @{}
  $peerReviews = @()
  $unrepliedHumanLoops = @()

  $prSenderRe = '(?i)(editorialmanager\\.com|manuscriptcentral\\.com|scholarone|eesmail|editorialexpress|reviewerhub|elsevier|springer|wiley|mdpi|tandf|sagepub|frontiersin|ieee|asme|ashrae)'
  $prTextRe = '(?i)(review for |inviting you to review|invitation to review|agree to review|peer review|referee|manuscript number|submit your review|pending assignments|review due|reviewer assignment|thank you for (?:submitting|completing) your review|thank you for reviewing)'
  $prNoiseRe = '(?i)(newsletter|author connect|call for papers|read the first articles|confirm co-authorship|verify your email|frontiers science news|google maps|walmart|purchase|prospectus|job alert|ashrae toronto chapter|defense announcement|listserv\\.uoguelph\\.ca|fasrjobs@uoguelph\\.ca)'
  $noiseSenderRe = '(?i)(no-?reply|noreply|do-?not-?reply|listserv\\.uoguelph\\.ca|fasrjobs@uoguelph\\.ca|newsletter|marketing|notifications?@|updates-noreply|jobalerts|scholaralerts|walmart|homedepot|communauto|editorialmanager\\.com|manuscriptcentral\\.com|scholarone|microsoft|teams|zoom|coursera|linkedin|google\\.com|github\\.com|vercel\\.com|rbc\\.com|wealthsimple|alectra|uhip|cowan|registrar|servicerequest|ithelp|postmaster|mailer-daemon)'
  $noiseSubjRe = '(?i)(confirmation of receipt|defense announcement|newsletter|digest|estatement|order #|verify your email|new sign-in|shared some google account data|sent a message|automatic reply|out of office|accepted:|declined:|canceled:)'
  $humanQuestionRe = '\\?|\\b(help|tutor|fluid|quiz|lab|grade|mark|recommend|meeting|syllabus|extension|transfer|question|clarification|available|availability|schedule|advice|reference|thesis|defense|review)\\b'

  foreach ($it in $items) {
    if ($it.Class -ne 43) { continue }
    $subj = [string]$it.Subject
    $sndr = [string]$it.SenderName
    $rawEmail = [string]$it.SenderEmailAddress
    $cid = [string]$it.ConversationID
    $recvDt = $it.ReceivedTime

    $isFirstForConv = $true
    if ($cid) {
      if ($seenInboundConvs.ContainsKey($cid)) {
        $isFirstForConv = $false
      } else {
        $seenInboundConvs[$cid] = $true
        if ($recvDt) { $inboundConvLatest[$cid] = $recvDt }
      }
    }

    $body = [string]$it.Body
    if ($body.Length -gt 4000) { $bodyHead = $body.Substring(0, 4000) } else { $bodyHead = $body }

    # 1. Peer review detection (across both read & unread)
    $isPrMatch = ($sndr -match $prSenderRe -or $rawEmail -match $prSenderRe -or $subj -match $prTextRe -or $bodyHead -match $prTextRe)
    if ($isPrMatch -and -not ($sndr -match $prNoiseRe -or $rawEmail -match $prNoiseRe -or $subj -match $prNoiseRe)) {
      $msId = $null
      if ($bodyHead -match '(?i)(?:Manuscript(?:\\s+Number|\\s+ID)?\\s*[:#]\\s*)([A-Z0-9][A-Z0-9._-]{3,30})') {
        $msId = $matches[1].Trim()
      } elseif ($bodyHead -match '\\b([A-Z]{2,8}-[A-Z0-9]{1,4}-\\d{2,4}-\\d{3,7}(?:R\\d+)?)\\b') {
        $msId = $matches[1].Trim()
      }
      $dueText = $null
      if ($bodyHead -match '(?i)(?:submit your review by|due(?:\\s+date)?(?:\\s+is|\\s*:)?|review by|deadline(?:\\s+is|\\s*:)?)[\\s:]*([A-Z][a-z]{2,8}\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+[A-Z][a-z]{2,8}\\s+\\d{4})') {
        $dueText = $matches[1].Trim()
      }
      $prStatus = 'review_notice'
      if ($subj -match '(?i)(thank you for (?:submitting|completing) your review|review (?:has been )?submitted|review received|thank you for reviewing)' -or $bodyHead -match '(?i)(thank you for (?:submitting|completing) your review|review (?:has been )?submitted|review received|thank you for reviewing)') {
        $prStatus = 'submitted_confirmation'
        if ($msId) { $submittedManuscripts[$msId] = $true }
      } elseif ($subj -match '(?i)(next steps|thank you(?: very much)? for agreeing|pending assignments|agreed to review)' -or $bodyHead -match '(?i)(thank you(?: very much)? for agreeing|pending assignments|submit your review by)') {
        $prStatus = 'accepted_active'
      } elseif ($subj -match '(?i)(inviting you to review|invitation to review|agree to review)' -or $bodyHead -match '(?i)(inviting you to review|invitation to review|agree to review)') {
        $prStatus = 'invitation'
      }
      $prSmtp = Get-SmtpAddress $it
      $prPreview = ($bodyHead -replace '\\s+', ' ').Trim()
      if ($prPreview.Length -gt 220) { $prPreview = $prPreview.Substring(0, 220) + '...' }
      $peerReviews += [ordered]@{
        entryId = $it.EntryID
        subject = $subj
        from = $sndr
        fromEmail = $prSmtp
        receivedAt = if ($recvDt) { $recvDt.ToString('o') } else { $null }
        unread = [bool]$it.UnRead
        status = $prStatus
        manuscriptId = $msId
        dueDateText = $dueText
        submissionConfirmed = $false
        conversationId = $cid
        preview = $prPreview
      }
    }

    # 2. Unreplied human/student correspondence loops (latest inbound per conversation, read & unread)
    if (-not $isFirstForConv) { continue }
    if ($unrepliedHumanLoops.Count -ge $cap) { continue }
    if ($sndr -match $noiseSenderRe -or $rawEmail -match $noiseSenderRe -or $subj -match $noiseSubjRe) { continue }

    $verb = Get-VerbCode $it
    $lastSent = if ($cid -and $sentConvLatest.ContainsKey($cid)) { $sentConvLatest[$cid] } else { $null }
    $sentAfter = ($null -ne $lastSent -and $recvDt -and $lastSent -gt $recvDt)
    $replied = ($verb -in @(102, 103) -or $sentAfter)
    if ($replied) { continue }

    $isExchange = ([string]$it.SenderEmailType -eq 'EX')
    $isHumanText = ($subj -match $humanQuestionRe -or $bodyHead -match $humanQuestionRe)
    if (-not ($isExchange -or $rawEmail -match '(?i)@uoguelph\\.ca$' -or $isHumanText)) { continue }

    $smtp = Get-SmtpAddress $it
    if ($smtp -match $noiseSenderRe) { continue }

    $ageHrs = if ($recvDt) { [Math]::Round(($now - $recvDt).TotalHours, 1) } else { $null }
    $ageDays = if ($recvDt) { [Math]::Round(($now - $recvDt).TotalDays, 1) } else { $null }
    $preview = ($bodyHead -replace '\\s+', ' ').Trim()
    if ($preview.Length -gt 220) { $preview = $preview.Substring(0, 220) + '...' }
    $unrepliedHumanLoops += [ordered]@{
      entryId = $it.EntryID
      subject = $subj
      from = $sndr
      fromEmail = $smtp
      receivedAt = if ($recvDt) { $recvDt.ToString('o') } else { $null }
      unread = [bool]$it.UnRead
      ageHours = $ageHrs
      ageDays = $ageDays
      flagStatus = [int]$it.FlagStatus
      conversationId = $cid
      lastSentInThread = if ($lastSent) { $lastSent.ToString('o') } else { $null }
      preview = $preview
    }
  }

  foreach ($pr in $peerReviews) {
    if ($pr.manuscriptId -and $submittedManuscripts.ContainsKey($pr.manuscriptId)) {
      $pr.submissionConfirmed = $true
    }
  }
  if ($peerReviews.Count -gt $cap) { $peerReviews = @($peerReviews[0..($cap - 1)]) }

  # 3. Sent follow-ups awaiting their reply
  $sentAwaitingTheirReply = @()
  $seenSentConvs = @{}
  $sentCut = $now.AddDays(-$days)
  $sentFollowRe = '(?i)(schedule|meeting|weekly|follow up|let me know|send me|syllabus|availability|fluid|tutor|recommend|next week|draft)'
  foreach ($sit in $sentHumanList) {
    if ($sit.sentOn -lt $sentCut) { continue }
    $cid = $sit.conversationId
    if ($cid) {
      if ($seenSentConvs.ContainsKey($cid)) { continue }
      $seenSentConvs[$cid] = $true
      if ($inboundConvLatest.ContainsKey($cid) -and $inboundConvLatest[$cid] -ge $sit.sentOn) { continue }
    }
    $toStr = $sit.to
    if ($toStr -match '(?i)(no-?reply|noreply|do-?not-?reply|listserv|notifications?@)') { continue }
    $sBody = if ($sit.body.Length -gt 2000) { $sit.body.Substring(0, 2000) } else { $sit.body }
    if ($sit.subject -notmatch $sentFollowRe -and $sBody -notmatch $sentFollowRe) { continue }
    $sPreview = ($sBody -replace '\\s+', ' ').Trim()
    if ($sPreview.Length -gt 180) { $sPreview = $sPreview.Substring(0, 180) + '...' }
    $sentAwaitingTheirReply += [ordered]@{
      subject = $sit.subject
      to = $toStr
      sentAt = $sit.sentOn.ToString('o')
      ageDays = [Math]::Round(($now - $sit.sentOn).TotalDays, 1)
      conversationId = $cid
      preview = $sPreview
    }
    if ($sentAwaitingTheirReply.Count -ge 10) { break }
  }

  [ordered]@{
    account = ($ns.Accounts | ForEach-Object { $_.SmtpAddress }) -join ', '
    offline = [bool]$ns.Offline
    connectionMode = [int]$ns.ExchangeConnectionMode
    daysScanned = $days
    peerReviewCount = $peerReviews.Count
    peerReviews = @($peerReviews)
    unrepliedHumanLoopCount = $unrepliedHumanLoops.Count
    unrepliedHumanLoops = @($unrepliedHumanLoops)
    sentAwaitingTheirReplyCount = $sentAwaitingTheirReply.Count
    sentAwaitingTheirReply = @($sentAwaitingTheirReply)
  } | ConvertTo-Json -Depth 5
} else {
  $folderName = if ($argsObj.folder) { ([string]$argsObj.folder).ToLower() } else { 'inbox' }
  if ($folderName -eq 'sent') {
    $folderObj = $ns.GetDefaultFolder(5)
    $dateField = 'SentOn'
  } elseif ($folderName -eq 'drafts') {
    $folderObj = $ns.GetDefaultFolder(16)
    $dateField = 'LastModificationTime'
  } else {
    $folderName = 'inbox'
    $folderObj = $ns.GetDefaultFolder(6)
    $dateField = 'ReceivedTime'
  }
  $limit = if ($argsObj.limit) { [Math]::Min(50, [Math]::Max(1, [int]$argsObj.limit)) } else { 15 }
  $items = $folderObj.Items
  $hasDays = ($null -ne $argsObj.days -and [int]$argsObj.days -gt 0)
  $daysVal = if ($hasDays) { [Math]::Min(90, [Math]::Max(1, [int]$argsObj.days)) } else { 30 }
  if ($hasDays -and $folderName -ne 'drafts') {
    $cutoffStr = (Get-Date).AddDays(-$daysVal).ToString('g')
    $items = $items.Restrict("[$dateField] >= '$cutoffStr'")
  }
  $items.Sort("[$dateField]", $true)
  $q = if ($argsObj.query) { [string]$argsObj.query } else { '' }
  $unrepliedOnly = [bool]$argsObj.unrepliedOnly
  $sentConvLatest = @{}
  if ($folderName -eq 'inbox') {
    $sentData = Get-SentConvData $ns ([Math]::Max($daysVal, 30) + 14) $false
    $sentConvLatest = $sentData.convMap
  }
  $maxScan = if ($hasDays) { 1000 } else { 800 }
  $res = @()
  $scanned = 0
  foreach ($it in $items) {
    if ($scanned -ge $maxScan -and ($q -or $unrepliedOnly)) { break }
    $scanned++
    if ($it.Class -ne 43) { continue }
    $subj = [string]$it.Subject
    $bodyText = [string]$it.Body
    if ($folderName -eq 'inbox') {
      $sndr = [string]$it.SenderName
      $rawEmail = [string]$it.SenderEmailAddress
      if ($q) {
        if ($subj -notmatch [regex]::Escape($q) -and $sndr -notmatch [regex]::Escape($q) -and $rawEmail -notmatch [regex]::Escape($q) -and $bodyText -notmatch [regex]::Escape($q)) {
          continue
        }
      }
      $cid = [string]$it.ConversationID
      $verb = Get-VerbCode $it
      $lastSent = if ($cid -and $sentConvLatest.ContainsKey($cid)) { $sentConvLatest[$cid] } else { $null }
      $sentAfter = ($null -ne $lastSent -and $it.ReceivedTime -and $lastSent -gt $it.ReceivedTime)
      $replied = ($verb -in @(102, 103) -or $sentAfter)
      if ($unrepliedOnly -and $replied) { continue }
      $smtp = Get-SmtpAddress $it
      $preview = ($bodyText -replace '\\s+', ' ').Trim()
      if ($preview.Length -gt 220) { $preview = $preview.Substring(0, 220) + '...' }
      $res += [ordered]@{
        entryId = $it.EntryID
        subject = $subj
        from = $sndr
        fromEmail = $smtp
        receivedAt = if ($it.ReceivedTime) { $it.ReceivedTime.ToString('o') } else { $null }
        unread = [bool]$it.UnRead
        replied = $replied
        forwarded = ($verb -eq 104)
        lastSentInThread = if ($lastSent) { $lastSent.ToString('o') } else { $null }
        flagStatus = [int]$it.FlagStatus
        conversationId = $cid
        preview = $preview
      }
    } else {
      $toStr = [string]$it.To
      if ($q) {
        if ($subj -notmatch [regex]::Escape($q) -and $toStr -notmatch [regex]::Escape($q) -and $bodyText -notmatch [regex]::Escape($q)) {
          continue
        }
      }
      $preview = ($bodyText -replace '\\s+', ' ').Trim()
      if ($preview.Length -gt 220) { $preview = $preview.Substring(0, 220) + '...' }
      if ($folderName -eq 'sent') {
        $res += [ordered]@{
          entryId = $it.EntryID
          subject = $subj
          to = $toStr
          sentAt = if ($it.SentOn) { $it.SentOn.ToString('o') } else { $null }
          conversationId = [string]$it.ConversationID
          preview = $preview
        }
      } else {
        $res += [ordered]@{
          entryId = $it.EntryID
          subject = $subj
          to = $toStr
          modifiedAt = if ($it.LastModificationTime) { $it.LastModificationTime.ToString('o') } else { $null }
          conversationId = [string]$it.ConversationID
          preview = $preview
        }
      }
    }
    if ($res.Count -ge $limit) { break }
  }
  [ordered]@{ account = ($ns.Accounts | ForEach-Object { $_.SmtpAddress }) -join ', '; folder = $folderName; offline = [bool]$ns.Offline; connectionMode = [int]$ns.ExchangeConnectionMode; count = $res.Count; emails = @($res) } | ConvertTo-Json -Depth 4
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
    const encodedUtf8 = Buffer.from(psHeader + '\n' + psBody, 'utf8').toString('base64');
    try {
      const out = await new Promise((resolve, reject) => {
        const psCmd = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $b=[Console]::In.ReadToEnd(); Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.Trim())))';
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let totalBytes = 0;
        let settled = false;
        const maxBytes = 4 * 1024 * 1024;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill(); } catch {}
          reject(new Error('PowerShell execution timed out after 45000ms'));
        }, 45000);
        child.stdout.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes <= maxBytes) stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0 && !stdout.trim()) {
            return reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
          }
          resolve(stdout.trim());
        });
        child.stdin.end(encodedUtf8);
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
