// hub-mcp.mjs — Stdio MCP server exposing AI Studio Hub superpowers to every OpenMausBot agent:
// • hub_stalled_tasks: Unfinished/stalled tasks across Antigravity, Codex, and VS Code
// • hub_search_conversations: Full-text search across all native chats
// • hub_read_conversation: Read recent turns from any native Antigravity/Codex/VS Code chat
// • hub_quota_status: Real-time Antigravity & Codex 5h/7d quotas + Auto-Pilot recommendation
// • hub_calendar_and_reminders: Check upcoming calendar events & reminders, or add a reminder
import readline from 'node:readline';
import {
  buildStalledRadar,
  getAutoPilotRecommendation,
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
    name: 'hub_quota_status',
    description: 'Get real-time Antigravity and Codex 5-hour / 7-day remaining quotas plus the Auto-Pilot engine recommendation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
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
  if (name === 'hub_quota_status') {
    const quota = await getAutoPilotRecommendation();
    return { content: [{ type: 'text', text: JSON.stringify(quota, null, 2) }] };
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
