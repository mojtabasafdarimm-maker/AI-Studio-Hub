// hub-auth.mjs — Remote access gate for AI Studio Hub.
//
// The Hub is reachable from the internet through the Cloudflare tunnel + workers.dev gateway.
// Requests made on this PC (127.0.0.1, no Cloudflare headers) keep working exactly as before.
// Requests that arrive through the tunnel must prove they are Moji's device:
//   - the existing long-lived session cookie (value == master token), or
//   - Authorization: Bearer <master token>, or
//   - a one-time pairing code (issued on this PC) redeemed at /pair/<CODE>.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './hub-core.mjs';

const PAIR_FILE = path.join(DATA_DIR, 'hub-pair-codes.json');
const PAIR_TTL_MS = 24 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Public, harmless files the pairing page / installed PWA may request before sign-in.
const PUBLIC_PATHS = new Set(['/favicon.ico', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest', '/manifest.json', '/robots.txt']);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isRemoteRequest(req) {
  const h = req.headers || {};
  if (h['cf-ray'] || h['cf-connecting-ip'] || h['cdn-loop'] || h['x-forwarded-for'] || h['cf-worker']) return true;
  const addr = req.socket?.remoteAddress || '';
  return addr !== '' && !LOOPBACK.has(addr);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function hasValidCredential(req, masterToken, cookieName) {
  if (!masterToken) return false;
  const auth = String(req.headers?.authorization || '');
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), masterToken)) return true;
  const cookies = parseCookies(req.headers?.cookie);
  return safeEqual(cookies[cookieName], masterToken);
}

/** true when the request may proceed (local, or remote with a valid credential). */
export function isAllowed(req, masterToken, cookieName) {
  if (!isRemoteRequest(req)) return true;
  return hasValidCredential(req, masterToken, cookieName);
}

export function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname);
}

function readCodes() {
  try {
    const list = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((c) => c.expiresAt > Date.now() && !c.usedAt) : [];
  } catch {
    return [];
  }
}

function writeCodes(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PAIR_FILE, JSON.stringify(list, null, 2), 'utf8');
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

export function issuePairCode(label = 'Phone / Remote Browser') {
  const bytes = crypto.randomBytes(12);
  let raw = '';
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  const list = readCodes();
  list.push({ hash: hashCode(code), label, createdAt: Date.now(), expiresAt: Date.now() + PAIR_TTL_MS });
  writeCodes(list);
  return { code, expiresAt: Date.now() + PAIR_TTL_MS };
}

/** Consumes a one-time code. Returns true once per valid code. */
export function redeemPairCode(code) {
  const h = hashCode(code);
  const list = readCodes();
  const hit = list.find((c) => c.hash === h);
  if (!hit) return false;
  hit.usedAt = Date.now();
  writeCodes(list.filter((c) => c !== hit));
  return true;
}

// Simple in-memory brute-force brake for /pair attempts from the internet.
const attempts = new Map();
export function pairAttemptAllowed(req) {
  const ip = String(req.headers?.['cf-connecting-ip'] || req.headers?.['x-forwarded-for'] || 'remote').split(',')[0].trim();
  const now = Date.now();
  const rec = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  rec.push(now);
  attempts.set(ip, rec);
  return rec.length <= 10;
}

export function renderPairPage(message = '') {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Studio Hub · Sign in</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#18181b}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#f4f4f5}.card{background:#18181b!important;border-color:#27272a!important}input{background:#09090b!important;color:#f4f4f5!important;border-color:#3f3f46!important}}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:24px;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
h1{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.5;margin:0 0 16px;opacity:.8}
input{width:100%;box-sizing:border-box;font-size:18px;letter-spacing:2px;text-transform:uppercase;padding:10px 12px;border-radius:10px;border:1px solid #d4d4d8;margin-bottom:12px}
button{width:100%;min-height:40px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:15px;font-weight:600}
.err{color:#dc2626;font-size:14px;margin-bottom:12px}
</style></head><body><form class="card" onsubmit="event.preventDefault();var c=document.getElementById('c').value.trim();if(c)location.href='/pair/'+encodeURIComponent(c);">
<h1>AI Studio Hub</h1>
<p>This device isn't signed in. On your PC, open the Hub and tap <b>Pair phone</b> to get a one-time code, then enter it here.</p>
${message ? `<div class="err">${esc(message)}</div>` : ''}
<input id="c" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX" aria-label="Pairing code">
<button type="submit">Sign in</button></form></body></html>`;
}
