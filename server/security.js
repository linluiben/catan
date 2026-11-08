'use strict';
// Sicherheits- und Datenschutz-Helfer: Header, Passwortvergleich, Origin-Prüfung, Ratenbegrenzung.
const crypto = require('crypto');

const env = process.env;
const bool = (v, def) => (v === undefined || v === '' ? def : !/^(0|false|no|nein|off)$/i.test(v));

const CONFIG = {
  password: env.SERVER_PASSWORD || '',
  // Öffentliche Raumliste auf der Startseite anzeigen? (Namen der Mitspieler werden dort sichtbar)
  roomList: bool(env.ROOM_LIST, true),
  maxRooms: Number(env.MAX_ROOMS) || 50,
  roomTtlDays: Number(env.ROOM_TTL_DAYS) || 30,
  // Zusätzlich erlaubte Origins für WebSockets (kommagetrennt), z. B. "https://spiel.example.de"
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Hinter einem Reverse Proxy: X-Forwarded-For für die Ratenbegrenzung auswerten
  trustProxy: bool(env.TRUST_PROXY, false),
  maxConnPerIp: Number(env.MAX_CONN_PER_IP) || 20,
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Farben der Spieler werden als Inline-Style gesetzt
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function clientIp(req) {
  if (CONFIG.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}

// Verhindert, dass fremde Webseiten im Browser eines Spielers eine WebSocket-Verbindung aufbauen.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Nicht-Browser-Clients (z. B. Tests) senden keinen Origin
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (host === reqHost) return true;
  return CONFIG.allowedOrigins.includes(origin.toLowerCase());
}

// Token-Bucket: erlaubt kurze Spitzen, begrenzt die Dauerlast.
class Bucket {
  constructor(rate, burst) { this.rate = rate; this.burst = burst; this.tokens = burst; this.last = Date.now(); }
  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / 1000 * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

// Pro IP: Verbindungen zählen, Fehlversuche beim Passwort sperren. Gespeichert wird nur im RAM.
const ipState = new Map();
function ipEntry(ip) {
  let e = ipState.get(ip);
  if (!e) { e = { conns: 0, fails: 0, lockedUntil: 0, creates: new Bucket(1 / 60, 5), seen: Date.now() }; ipState.set(ip, e); }
  e.seen = Date.now();
  return e;
}
setInterval(() => {
  const old = Date.now() - 3600 * 1000;
  for (const [ip, e] of ipState) if (e.conns === 0 && e.seen < old) ipState.delete(ip);
}, 10 * 60 * 1000).unref();

function checkPassword(ip, given) {
  if (!CONFIG.password) return { ok: true };
  // Leere Eingabe zählt nicht als Fehlversuch (z. B. Seitenaufruf ohne eingetipptes Passwort)
  if (!given) return { ok: false, msg: 'Dieser Server benötigt ein Passwort.' };
  const e = ipEntry(ip);
  if (e.lockedUntil > Date.now()) return { ok: false, msg: 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.' };
  if (safeEqual(given, CONFIG.password)) { e.fails = 0; return { ok: true }; }
  e.fails++;
  if (e.fails >= 10) { e.lockedUntil = Date.now() + 10 * 60 * 1000; e.fails = 0; }
  return { ok: false, msg: 'Falsches Server-Passwort.' };
}

module.exports = { CONFIG, SECURITY_HEADERS, safeEqual, clientIp, originAllowed, Bucket, ipEntry, checkPassword };
