export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Health check & status
    if (url.pathname === '/_gateway/status') {
      const activeUrl = env.GATEWAY_KV ? await env.GATEWAY_KV.get('ACTIVE_TUNNEL') : null;
      return new Response(JSON.stringify({ ok: true, activeUrl }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Secret registration endpoint called by your PC's server.js on startup
    if (url.pathname === '/_gateway/register') {
      const token = request.headers.get('Authorization');
      if (token !== `Bearer ${env.GATEWAY_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      const data = await request.json().catch(() => ({}));
      if (!data.url) return new Response('Missing tunnel URL', { status: 400 });

      if (env.GATEWAY_KV) {
        await env.GATEWAY_KV.put('ACTIVE_TUNNEL', data.url);
      }
      return new Response(JSON.stringify({ success: true, url: data.url }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Read the registered active tunnel URL (from KV or GitHub fallback)
    let activeUrl = env.GATEWAY_KV ? await env.GATEWAY_KV.get('ACTIVE_TUNNEL') : null;
    if (!activeUrl) {
      try {
        const ghRes = await fetch(`https://raw.githubusercontent.com/mojtabasafdarimm-maker/AI-Studio-Hub/main/public/active-tunnel.json?_t=${Date.now()}`);
        if (ghRes.ok) {
          const data = await ghRes.json();
          if (data && data.url) activeUrl = data.url;
        }
      } catch {}
    }

    if (!activeUrl) {
      return new Response(renderOfflineHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        status: 503
      });
    }

    // 4. Reverse Proxy to the PC
    try {
      const originUrl = new URL(activeUrl);
      const targetUrl = new URL(request.url);
      targetUrl.protocol = originUrl.protocol;
      targetUrl.host = originUrl.host;
      targetUrl.port = originUrl.port;

      const proxyReq = new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual'
      });

      proxyReq.headers.set('X-Forwarded-Host', url.host);

      const response = await fetch(proxyReq);
      return response;
    } catch (err) {
      return new Response(renderOfflineHtml(err.message), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        status: 502
      });
    }
  }
};

function renderOfflineHtml(errMsg = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Studio Hub — Waiting for PC</title>
  <style>
    body {
      margin: 0;
      padding: 40px 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 80vh;
      text-align: center;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 32px 24px;
      max-width: 420px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(245, 158, 11, 0.2);
      color: #f59e0b;
      margin-bottom: 16px;
    }
    h2 { margin: 0 0 10px 0; font-size: 20px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
    .loader {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 3px solid rgba(255,255,255,0.15);
      border-radius: 50%;
      border-top-color: #38bdf8;
      animation: spin 1s ease-in-out infinite;
      margin-bottom: 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="loader"></div>
    <div class="badge">● Waiting for PC Connection</div>
    <h2>⚡ AI Studio Hub</h2>
    <p>Your computer appears to be sleeping, starting up, or AI Studio Hub has not registered yet.</p>
    ${errMsg ? `<p style="font-size:12px; color:#ef4444; word-break:break-all;">Error: ${errMsg}</p>` : ''}
    <p style="font-size:12px; color:#64748b;">This page will automatically reconnect as soon as the PC is online.</p>
  </div>
  <script>
    setTimeout(() => location.reload(), 4000);
  </script>
</body>
</html>`;
}
