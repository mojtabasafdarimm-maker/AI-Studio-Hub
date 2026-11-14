/**
 * Remote Agent Browser & Phone Takeover Controller (CDP over Node 24 built-in WebSocket).
 * Zero external dependencies. Launches host Chrome/Edge with a persistent profile in DATA_DIR,
 * streams Page.startScreencast JPEG frames over SSE, and dispatches remote touch/mouse/keyboard input.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 412, height: 780, deviceScaleFactor: 1, mobile: true }
};

const KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 }
};

function findBrowserBinary() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.HUB_BROWSER_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

class BrowserController {
  constructor({ dataDir }) {
    this.profileDir = path.join(dataDir, 'browser-profile');
    this.proc = null;
    this.port = null;
    this.ws = null;
    this.nextMsgId = 1;
    this.pending = new Map();
    this.sseClients = new Set();
    this.screencastActive = false;
    this.startingPromise = null;

    this.running = false;
    this.browserName = null;
    this.viewportMode = 'desktop';
    this.controlMode = 'agent'; // 'agent' | 'user'
    this.currentUrl = '';
    this.currentTitle = '';
    this.lastError = null;
    this.latestFrame = null;
    this.lastActivityAt = null;
  }

  getViewport() {
    return VIEWPORTS[this.viewportMode] || VIEWPORTS.desktop;
  }

  getState() {
    const vp = this.getViewport();
    return {
      running: this.running && !!this.ws && this.ws.readyState === WebSocket.OPEN,
      browserName: this.browserName,
      viewportMode: this.viewportMode,
      viewport: { width: vp.width, height: vp.height, mobile: vp.mobile },
      controlMode: this.controlMode,
      url: this.currentUrl,
      title: this.currentTitle,
      lastError: this.lastError,
      lastActivityAt: this.lastActivityAt,
      hasFrame: !!this.latestFrame
    };
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  broadcastState() {
    this.broadcast('state', this.getState());
  }

  addSseClient(res) {
    this.sseClients.add(res);
    try {
      res.write(`event: state\ndata: ${JSON.stringify(this.getState())}\n\n`);
      if (this.latestFrame) {
        res.write(`event: frame\ndata: ${JSON.stringify(this.latestFrame)}\n\n`);
      }
    } catch {
      this.sseClients.delete(res);
      return;
    }
    if (this.running && !this.screencastActive) {
      this.startScreencast().catch(() => {});
    }
  }

  removeSseClient(res) {
    this.sseClients.delete(res);
    if (this.sseClients.size === 0 && this.screencastActive) {
      this.stopScreencast().catch(() => {});
    }
  }

  sendCdp(method, params = {}, timeoutMs = 10000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Browser CDP session is not connected'));
    }
    const id = this.nextMsgId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  handleCdpMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(typeof rawData === 'string' ? rawData : rawData.toString());
    } catch {
      return;
    }

    if (msg.id) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'CDP error'));
        } else {
          entry.resolve(msg.result || {});
        }
      }
      return;
    }

    if (msg.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = msg.params || {};
      this.sendCdp('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (data) {
        this.latestFrame = {
          data,
          metadata: metadata || {},
          ts: Date.now()
        };
        this.broadcast('frame', this.latestFrame);
      }
    } else if (msg.method === 'Page.frameNavigated') {
      const frame = msg.params?.frame;
      if (frame && !frame.parentId && frame.url) {
        this.currentUrl = frame.url;
        this.lastActivityAt = Date.now();
        this.broadcastState();
      }
    } else if (msg.method === 'Page.navigatedWithinDocument') {
      if (msg.params?.url) {
        this.currentUrl = msg.params.url;
        this.lastActivityAt = Date.now();
        this.broadcastState();
      }
    } else if (msg.method === 'Page.loadEventFired') {
      this.refreshPageMeta().catch(() => {});
    }
  }

  async refreshPageMeta() {
    try {
      const res = await this.sendCdp('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true
      }, 4000);
      const val = res?.result?.value;
      if (val) {
        if (val.url) this.currentUrl = val.url;
        if (typeof val.title === 'string') this.currentTitle = val.title;
        this.broadcastState();
      }
    } catch {}
  }

  async applyViewport() {
    const vp = this.getViewport();
    await this.sendCdp('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      mobile: vp.mobile
    });
  }

  async startScreencast() {
    if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const vp = this.getViewport();
    this.screencastActive = true;
    await this.sendCdp('Page.startScreencast', {
      format: 'jpeg',
      quality: 68,
      maxWidth: vp.width,
      maxHeight: vp.height,
      everyNthFrame: 1
    });
  }

  async stopScreencast() {
    this.screencastActive = false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    await this.sendCdp('Page.stopScreencast', {}).catch(() => {});
  }

  async start({ url, viewportMode, headless = true } = {}) {
    if (this.running && this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (viewportMode && VIEWPORTS[viewportMode] && viewportMode !== this.viewportMode) {
        await this.setViewport(viewportMode);
      }
      if (url) {
        await this.navigate(url);
      }
      return this.getState();
    }

    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = (async () => {
      try {
        await this.stop();
        const bin = findBrowserBinary();
        if (!bin) {
          throw new Error('No Chrome or Edge executable found on host machine.');
        }

        fs.mkdirSync(this.profileDir, { recursive: true });
        this.port = await getFreePort();
        this.viewportMode = VIEWPORTS[viewportMode] ? viewportMode : (this.viewportMode || 'desktop');
        const vp = this.getViewport();
        const startUrl = url ? this.normalizeUrl(url) : (this.currentUrl || 'https://www.google.com');

        const args = [
          `--remote-debugging-port=${this.port}`,
          `--user-data-dir=${this.profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-features=TranslateUI',
          '--disable-popup-blocking',
          '--mute-audio',
          `--window-size=${vp.width},${vp.height}`
        ];
        if (headless !== false) {
          args.push('--headless=new');
        }
        args.push(startUrl);

        this.browserName = path.basename(bin, '.exe');
        this.lastError = null;
        this.proc = spawn(bin, args, {
          stdio: 'ignore',
          windowsHide: headless !== false
        });

        this.proc.on('exit', () => {
          this.cleanupConnectionOnly();
          this.running = false;
          this.broadcastState();
        });

        // Poll CDP /json/list until a page target is ready
        const deadline = Date.now() + 12000;
        let wsUrl = null;
        while (Date.now() < deadline) {
          try {
            const resp = await fetch(`http://127.0.0.1:${this.port}/json/list`);
            if (resp.ok) {
              const targets = await resp.json();
              const page = Array.isArray(targets)
                ? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
                : null;
              if (page) {
                wsUrl = page.webSocketDebuggerUrl;
                this.currentUrl = page.url || startUrl;
                this.currentTitle = page.title || '';
                break;
              }
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 200));
        }

        if (!wsUrl) {
          throw new Error('Timed out waiting for browser DevTools endpoint.');
        }

        await new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timer = setTimeout(() => {
            try { ws.close(); } catch {}
            reject(new Error('WebSocket CDP handshake timeout'));
          }, 8000);

          ws.addEventListener('open', () => {
            clearTimeout(timer);
            this.ws = ws;
            resolve();
          });
          ws.addEventListener('message', (ev) => this.handleCdpMessage(ev.data));
          ws.addEventListener('close', () => {
            this.cleanupConnectionOnly();
            this.running = false;
            this.broadcastState();
          });
          ws.addEventListener('error', (err) => {
            clearTimeout(timer);
            reject(new Error(err?.message || 'CDP WebSocket error'));
          });
        });

        this.running = true;
        this.lastActivityAt = Date.now();
        await this.sendCdp('Page.enable');
        await this.sendCdp('Runtime.enable');
        await this.applyViewport();
        await this.snapshot().catch(() => {});
        if (this.sseClients.size > 0) {
          await this.startScreencast();
        }
        await this.refreshPageMeta();
        this.broadcastState();
        return this.getState();
      } catch (err) {
        this.lastError = err.message;
        await this.stop();
        throw err;
      } finally {
        this.startingPromise = null;
      }
    })();

    return this.startingPromise;
  }

  cleanupConnectionOnly() {
    this.screencastActive = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  async stop() {
    this.cleanupConnectionOnly();
    if (this.proc) {
      const pid = this.proc.pid;
      this.proc = null;
      killProcessTree(pid);
    }
    this.running = false;
    this.latestFrame = null;
    this.broadcastState();
    return this.getState();
  }

  normalizeUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'https://www.google.com';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;
    if (s.includes('.') && !s.includes(' ')) return `https://${s}`;
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  }

  async navigate(rawUrl) {
    if (!this.running) await this.start({ url: rawUrl });
    const url = this.normalizeUrl(rawUrl);
    this.lastActivityAt = Date.now();
    await this.sendCdp('Page.navigate', { url });
    this.currentUrl = url;
    this.broadcastState();
    setTimeout(() => this.refreshPageMeta().catch(() => {}), 800);
    return this.getState();
  }

  async back() {
    const hist = await this.sendCdp('Page.getNavigationHistory');
    if (hist && hist.currentIndex > 0 && Array.isArray(hist.entries)) {
      const target = hist.entries[hist.currentIndex - 1];
      if (target) {
        await this.sendCdp('Page.navigateToHistoryEntry', { entryId: target.id });
        this.lastActivityAt = Date.now();
        setTimeout(() => this.refreshPageMeta().catch(() => {}), 500);
      }
    }
    return this.getState();
  }

  async forward() {
    const hist = await this.sendCdp('Page.getNavigationHistory');
    if (hist && Array.isArray(hist.entries) && hist.currentIndex < hist.entries.length - 1) {
      const target = hist.entries[hist.currentIndex + 1];
      if (target) {
        await this.sendCdp('Page.navigateToHistoryEntry', { entryId: target.id });
        this.lastActivityAt = Date.now();
        setTimeout(() => this.refreshPageMeta().catch(() => {}), 500);
      }
    }
    return this.getState();
  }

  async reload() {
    await this.sendCdp('Page.reload', { ignoreCache: false });
    this.lastActivityAt = Date.now();
    setTimeout(() => this.refreshPageMeta().catch(() => {}), 500);
    return this.getState();
  }

  async click(x, y, button = 'left', clickCount = 1) {
    const vp = this.getViewport();
    const cx = Math.max(0, Math.min(vp.width - 1, Math.round(Number(x) || 0)));
    const cy = Math.max(0, Math.min(vp.height - 1, Math.round(Number(y) || 0)));
    this.lastActivityAt = Date.now();
    await this.sendCdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
    await this.sendCdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button, clickCount });
    await this.sendCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button, clickCount });
    return { ok: true, x: cx, y: cy };
  }

  async scroll(x, y, deltaX = 0, deltaY = 0) {
    const vp = this.getViewport();
    const cx = Math.max(0, Math.min(vp.width - 1, Math.round(Number(x) || vp.width / 2)));
    const cy = Math.max(0, Math.min(vp.height - 1, Math.round(Number(y) || vp.height / 2)));
    this.lastActivityAt = Date.now();
    await this.sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: cx,
      y: cy,
      deltaX: Math.round(Number(deltaX) || 0),
      deltaY: Math.round(Number(deltaY) || 0)
    });
    return { ok: true };
  }

  async typeText(text, submit = false) {
    const str = String(text ?? '');
    this.lastActivityAt = Date.now();
    if (str.length > 0) {
      await this.sendCdp('Input.insertText', { text: str });
    }
    if (submit) {
      await this.pressKey('Enter');
    }
    return { ok: true };
  }

  async pressKey(keyName) {
    const name = String(keyName || '');
    const def = KEY_DEFS[name];
    this.lastActivityAt = Date.now();
    if (def) {
      await this.sendCdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        ...(def.text ? { text: def.text, unmodifiedText: def.text } : {})
      });
      await this.sendCdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode
      });
      return { ok: true, key: name };
    }
    if (name.length === 1) {
      await this.sendCdp('Input.insertText', { text: name });
      return { ok: true, key: name };
    }
    throw new Error(`Unsupported key: ${name}`);
  }

  async setControlMode(mode) {
    if (mode !== 'agent' && mode !== 'user') {
      throw new Error('controlMode must be "agent" or "user"');
    }
    this.controlMode = mode;
    this.lastActivityAt = Date.now();
    this.broadcastState();
    return this.getState();
  }

  async setViewport(mode) {
    if (!VIEWPORTS[mode]) throw new Error('viewportMode must be "desktop" or "mobile"');
    this.viewportMode = mode;
    if (this.running) {
      await this.applyViewport();
      if (this.screencastActive) {
        await this.stopScreencast();
        await this.startScreencast();
      }
      await this.snapshot().catch(() => {});
    }
    this.broadcastState();
    return this.getState();
  }

  async snapshot() {
    const res = await this.sendCdp('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
    const vp = this.getViewport();
    if (res?.data) {
      this.latestFrame = {
        data: res.data,
        metadata: { deviceWidth: vp.width, deviceHeight: vp.height },
        ts: Date.now()
      };
      this.broadcast('frame', this.latestFrame);
    }
    return { ok: true, data: res?.data || null, url: this.currentUrl, title: this.currentTitle };
  }

  async extractContext() {
    const res = await this.sendCdp('Runtime.evaluate', {
      expression: `(() => {
        const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 8000);
        const items = [];
        const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
        for (const el of els) {
          if (items.length >= 40) break;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight) continue;
          const label = (el.innerText || el.getAttribute('aria-label') || el.placeholder || el.value || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
          items.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || undefined,
            label,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2)
          });
        }
        return { url: location.href, title: document.title, text, interactive: items };
      })()`,
      returnByValue: true
    }, 6000);
    return res?.result?.value || { url: this.currentUrl, title: this.currentTitle, text: '', interactive: [] };
  }
}

module.exports = { BrowserController };
