'use strict';
// HTTP + WebSocket-Server: Lobby, Räume, Spielablauf, Bots, Speicherung.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');
const Bot = require('./bot');
const { listScenarios, SCENARIOS, shuffle } = require('./maps');
const Sec = require('./security');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = Sec.CONFIG.password;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BOT_DELAY = Number(process.env.BOT_DELAY_MS) || 700;

fs.mkdirSync(path.join(DATA_DIR, 'rooms'), { recursive: true });

const rooms = new Map();
const token = () => crypto.randomBytes(16).toString('hex');
function roomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do { id = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (rooms.has(id));
  return id;
}

// ------------------------------------------------------------ Speicherung
const saveTimers = new Map();
function saveRoom(room) {
  clearTimeout(saveTimers.get(room.id));
  saveTimers.set(room.id, setTimeout(() => {
    saveTimers.delete(room.id);
    const data = {
      id: room.id, name: room.name, options: room.options, hostToken: room.hostToken,
      seats: room.seats.map(s => ({ name: s.name, token: s.token, bot: s.bot, color: s.color })),
      game: room.game, chat: room.chat.slice(-100), updated: Date.now(),
    };
    const file = path.join(DATA_DIR, 'rooms', room.id + '.json');
    fs.writeFile(file + '.tmp', JSON.stringify(data), (err) => {
      if (err) return console.error('Speichern fehlgeschlagen', err);
      fs.rename(file + '.tmp', file, () => {});
    });
  }, 500));
}
function loadRooms() {
  const dir = path.join(DATA_DIR, 'rooms');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const room = {
        id: d.id, name: d.name, options: d.options, hostToken: d.hostToken,
        seats: d.seats.map(s => ({ ...s, ws: new Set() })), game: d.game, chat: d.chat || [],
        spectators: new Set(), botTimer: null, updated: d.updated || Date.now(),
      };
      if (room.game) room.game = G.validateLoaded(room.game);
      rooms.set(room.id, room);
    } catch (e) { console.error('Raum konnte nicht geladen werden:', f, e.message); }
  }
  console.log(`${rooms.size} gespeicherte Räume geladen.`);
}
function deleteRoom(room) {
  rooms.delete(room.id);
  clearTimeout(room.botTimer);
  fs.unlink(path.join(DATA_DIR, 'rooms', room.id + '.json'), () => {});
}

// ------------------------------------------------------------ HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(Sec.SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ scenarios: listScenarios(), passwordRequired: !!PASSWORD, roomList: Sec.CONFIG.roomList }));
  }
  if (url.pathname === '/api/rooms') {
    res.setHeader('Cache-Control', 'no-store');
    if (!Sec.CONFIG.roomList) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]'); }
    // Passwort im Header (nicht in der URL, damit es nicht in Proxy-Logs landet)
    const pw = Sec.checkPassword(Sec.clientIp(req), req.headers['x-server-password']);
    if (!pw.ok) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('[]'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([...rooms.values()].map(roomSummary)));
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function roomSummary(r) {
  return {
    id: r.id, name: r.name, scenario: SCENARIOS[r.options.scenario] ? SCENARIOS[r.options.scenario].name : r.options.scenario,
    players: r.seats.map(s => s.name), started: !!r.game, ended: !!(r.game && r.game.phase === 'ended'),
    online: r.seats.filter(s => s.ws.size).length,
  };
}

// ------------------------------------------------------------ WebSocket
const wss = new WebSocketServer({
  server,
  maxPayload: 2 * 1024 * 1024, // reicht für große Spielstände
  verifyClient: (info, cb) => {
    if (!Sec.originAllowed(info.req)) return cb(false, 403, 'Origin nicht erlaubt');
    const e = Sec.ipEntry(Sec.clientIp(info.req));
    if (e.conns >= Sec.CONFIG.maxConnPerIp) return cb(false, 429, 'Zu viele Verbindungen');
    cb(true);
  },
});

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function broadcast(room) {
  const base = {
    id: room.id, name: room.name, options: room.options, started: !!room.game,
    seats: room.seats.map((s, i) => ({ seat: i, name: s.name, bot: s.bot, color: s.color, online: s.bot || s.ws.size > 0 })),
    chat: room.chat.slice(-60), spectators: room.spectators.size,
  };
  room.seats.forEach((s, i) => {
    if (!s.ws.size) return;
    const msg = JSON.stringify({ t: 'room', room: { ...base, you: i, host: s.token === room.hostToken }, game: room.game ? G.viewFor(room.game, i) : null });
    s.ws.forEach(ws => ws.readyState === 1 && ws.send(msg));
  });
  if (room.spectators.size) {
    const msg = JSON.stringify({ t: 'room', room: { ...base, you: null, host: false }, game: room.game ? G.viewFor(room.game, null) : null });
    room.spectators.forEach(ws => ws.readyState === 1 && ws.send(msg));
  }
  room.updated = Date.now();
  saveRoom(room);
  scheduleBots(room);
}

function scheduleBots(room) {
  if (room.botTimer || !room.game) return;
  const st = room.game;
  const actor = room.seats.findIndex((s, i) => s.bot && Bot.decide(st, i));
  if (actor < 0) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!rooms.has(room.id) || !room.game) return;
    let acted = false;
    for (let i = 0; i < room.seats.length; i++) {
      if (!room.seats[i].bot) continue;
      const a = Bot.decide(room.game, i);
      if (!a) continue;
      const r = G.act(room.game, i, a);
      if (!r.ok) {
        console.warn('Bot-Aktion abgelehnt:', a, r.error);
        // Notfall: Zug beenden, damit das Spiel nicht hängt
        if (room.game.turn === i) G.act(room.game, i, { type: 'endTurn' });
      }
      acted = true;
      break;
    }
    if (acted) broadcast(room);
  }, BOT_DELAY);
}

const COLORS = G.COLORS;
function freeColor(room) { return COLORS.find(c => !room.seats.some(s => s.color === c)) || COLORS[room.seats.length % COLORS.length]; }
const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 20);

wss.on('connection', (ws, req) => {
  ws.room = null; ws.seat = null; ws.isAlive = true;
  ws.ip = Sec.clientIp(req);
  const ipE = Sec.ipEntry(ws.ip);
  ipE.conns++;
  ws.bucket = new Sec.Bucket(15, 40); // max. ~15 Nachrichten/s, kurze Spitzen bis 40
  ws.strikes = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { ipE.conns = Math.max(0, ipE.conns - 1); });
  ws.on('message', (raw) => {
    if (!ws.bucket.take()) {
      if (++ws.strikes > 50) ws.terminate();
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try { handle(ws, m); } catch (e) {
      console.error(e);
      send(ws, { t: 'error', msg: 'Interner Serverfehler.' });
    }
  });
  ws.on('close', () => detach(ws));
});

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.seat !== null && room.seats[ws.seat]) room.seats[ws.seat].ws.delete(ws);
  room.spectators.delete(ws);
  ws.room = null; ws.seat = null;
  broadcast(room);
}

function attach(ws, room, seat) {
  detach(ws);
  ws.room = room;
  ws.seat = seat;
  if (seat === null) room.spectators.add(ws);
  else room.seats[seat].ws.add(ws);
  send(ws, { t: 'joined', room: room.id, token: seat === null ? null : room.seats[seat].token, seat });
  broadcast(room);
}

function handle(ws, m) {
  const err = (msg) => send(ws, { t: 'error', msg });
  if (m.t === 'create' || m.t === 'join') {
    // Wer ein gültiges Platz-Token hat, war schon berechtigt (Wiederverbinden ohne Passwort)
    const r = m.t === 'join' && rooms.get(String(m.room || '').toUpperCase());
    const hasToken = r && m.token && r.seats.some(s => Sec.safeEqual(s.token, m.token));
    if (!hasToken) {
      const pw = Sec.checkPassword(ws.ip, m.password);
      if (!pw.ok) return err(pw.msg);
    }
  }
  if (m.t === 'create') {
    if (rooms.size >= Sec.CONFIG.maxRooms) return err('Der Server hat die maximale Anzahl an Räumen erreicht. Bitte alte Räume löschen.');
    if (!Sec.ipEntry(ws.ip).creates.take()) return err('Bitte warte kurz, bevor du weitere Räume erstellst.');
  }
  if (m.t === 'create') {
    const name = cleanName(m.name);
    if (!name) return err('Bitte gib deinen Namen ein.');
    const scenario = SCENARIOS[m.scenario] ? m.scenario : 'classic';
    const room = {
      id: roomId(), name: cleanName(m.roomName) || `${name}s Spiel`,
      options: { scenario, vpTarget: Number(m.vpTarget) || SCENARIOS[scenario].vp },
      seats: [], hostToken: null, game: null, chat: [], spectators: new Set(), botTimer: null, updated: Date.now(),
    };
    if (m.state) {
      try {
        room.game = G.validateLoaded(m.state);
        room.options.scenario = room.game.scenario.key;
        room.options.vpTarget = room.game.scenario.vpTarget;
        room.seats = room.game.players.map(p => ({ name: p.name, token: token(), bot: p.bot, color: p.color, ws: new Set() }));
      } catch (e) { return err(e.message || 'Spielstand ungültig.'); }
      let idx = room.seats.findIndex(s => !s.bot && s.name.toLowerCase() === name.toLowerCase());
      if (idx < 0) idx = room.seats.findIndex(s => !s.bot);
      if (idx < 0) idx = 0;
      room.hostToken = room.seats[idx].token;
      rooms.set(room.id, room);
      return attach(ws, room, idx);
    }
    const seat = { name, token: token(), bot: false, color: COLORS[0], ws: new Set() };
    room.seats.push(seat);
    room.hostToken = seat.token;
    rooms.set(room.id, room);
    return attach(ws, room, 0);
  }
  if (m.t === 'join') {
    const room = rooms.get(String(m.room || '').toUpperCase());
    if (!room) return err('Raum nicht gefunden.');
    // Wiederverbinden per Token
    if (m.token) {
      const idx = room.seats.findIndex(s => Sec.safeEqual(s.token, m.token));
      if (idx >= 0) return attach(ws, room, idx);
    }
    const name = cleanName(m.name);
    if (m.spectate) return attach(ws, room, null);
    if (!name) return err('Bitte gib deinen Namen ein.');
    // freien Platz mit gleichem Namen übernehmen (z. B. nach geladenem Spielstand)
    const same = room.seats.findIndex(s => !s.bot && s.name.toLowerCase() === name.toLowerCase());
    if (same >= 0) {
      if (room.seats[same].ws.size && !m.force) return err('Dieser Name ist bereits verbunden. Wähle einen anderen Namen.');
      return attach(ws, room, same);
    }
    if (room.game) {
      return err('Das Spiel läuft schon. Du kannst einen Platz mit genau dem Namen eines Spielers übernehmen oder zuschauen.');
    }
    if (room.seats.length >= 6) return err('Der Raum ist voll (max. 6).');
    room.seats.push({ name, token: token(), bot: false, color: freeColor(room), ws: new Set() });
    return attach(ws, room, room.seats.length - 1);
  }

  const room = ws.room;
  if (!room) return err('Du bist in keinem Raum.');
  const seat = ws.seat;
  const isHost = seat !== null && room.seats[seat] && room.seats[seat].token === room.hostToken;

  switch (m.t) {
    case 'leave': {
      detach(ws);
      return send(ws, { t: 'left' });
    }
    case 'chat': {
      const text = String(m.text || '').slice(0, 300).trim();
      if (!text) return;
      room.chat.push({ from: seat !== null ? room.seats[seat].name : 'Zuschauer', color: seat !== null ? room.seats[seat].color : '#999', text, at: Date.now() });
      if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
      return broadcast(room);
    }
    case 'action': {
      if (!room.game) return err('Das Spiel hat noch nicht begonnen.');
      if (seat === null) return err('Zuschauer können nicht spielen.');
      const a = m.action || {};
      if (a.type === 'edit' && !isHost) return err('Nur der Gastgeber kann den Editor benutzen.');
      const r = G.act(room.game, seat, a);
      if (!r.ok) err(r.error);
      return broadcast(room);
    }
    case 'export': {
      if (!room.game) return err('Noch kein Spiel gestartet.');
      if (!isHost && room.game.phase !== 'ended') return err('Nur der Gastgeber kann den vollständigen Spielstand exportieren.');
      return send(ws, { t: 'export', state: room.game, name: room.name });
    }
  }
  // Ab hier: nur Gastgeber
  if (!isHost) return err('Nur der Gastgeber darf das.');
  switch (m.t) {
    case 'options': {
      if (room.game) return err('Das Spiel läuft bereits.');
      if (m.scenario && SCENARIOS[m.scenario]) {
        if (room.options.scenario !== m.scenario) room.options.vpTarget = SCENARIOS[m.scenario].vp;
        room.options.scenario = m.scenario;
      }
      if (m.vpTarget) room.options.vpTarget = Math.max(3, Math.min(30, Number(m.vpTarget) || 10));
      if (m.roomName) room.name = cleanName(m.roomName) || room.name;
      return broadcast(room);
    }
    case 'addBot': {
      if (room.game) return err('Das Spiel läuft bereits.');
      if (room.seats.length >= 6) return err('Maximal 6 Spieler.');
      const names = ['Ada', 'Bruno', 'Clara', 'Dieter', 'Erna', 'Fritz'];
      const n = names.find(x => !room.seats.some(s => s.name === x + ' (Bot)')) || 'Bot';
      room.seats.push({ name: n + ' (Bot)', token: token(), bot: true, color: freeColor(room), ws: new Set() });
      return broadcast(room);
    }
    case 'kick': {
      const i = Number(m.seat);
      if (room.game) return err('Während des Spiels kann niemand entfernt werden (Platz kann per Bot übernommen werden).');
      if (!room.seats[i] || room.seats[i].token === room.hostToken) return err('Ungültig.');
      const s = room.seats.splice(i, 1)[0];
      s.ws.forEach(w => { w.room = null; w.seat = null; send(w, { t: 'kicked' }); });
      // Seat-Indizes der verbleibenden Verbindungen aktualisieren
      room.seats.forEach((st, idx) => st.ws.forEach(w => { w.seat = idx; }));
      return broadcast(room);
    }
    case 'toggleBot': {
      // Platz eines (abwesenden) Spielers von einem Bot übernehmen lassen – oder zurück
      const i = Number(m.seat);
      const s = room.seats[i];
      if (!s || s.token === room.hostToken) return err('Ungültig.');
      s.bot = !s.bot;
      if (room.game) room.game.players[i].bot = s.bot;
      return broadcast(room);
    }
    case 'color': {
      const i = Number(m.seat);
      if (!room.seats[i] || !COLORS.includes(m.color)) return err('Ungültig.');
      room.seats[i].color = m.color;
      if (room.game) room.game.players[i].color = m.color;
      return broadcast(room);
    }
    case 'start': {
      if (room.game && room.game.phase !== 'ended') return err('Das Spiel läuft bereits.');
      const sc = SCENARIOS[room.options.scenario];
      if (room.seats.length < 1) return err('Keine Spieler.');
      if (room.seats.length > sc.maxPlayers) return err(`Dieses Szenario ist für höchstens ${sc.maxPlayers} Spieler.`);
      if (!m.keepOrder) {
        // Sitzreihenfolge zufällig; Verbindungen mitnehmen
        shuffle(room.seats);
        room.seats.forEach((s, idx) => s.ws.forEach(w => { w.seat = idx; }));
      }
      room.game = G.newGame({
        scenario: room.options.scenario, vpTarget: room.options.vpTarget,
        players: room.seats.map(s => ({ name: s.name, color: s.color, bot: s.bot })),
      });
      return broadcast(room);
    }
    case 'load': {
      try {
        const st = G.validateLoaded(m.state);
        const old = room.seats;
        room.seats = st.players.map((p, i) => {
          const prev = old.find(s => s.name.toLowerCase() === p.name.toLowerCase());
          return prev ? { ...prev, color: p.color, bot: p.bot } : { name: p.name, token: token(), bot: p.bot, color: p.color, ws: new Set() };
        });
        // Gastgeber muss einen Platz behalten
        if (!room.seats.some(s => s.token === room.hostToken)) {
          const hostSeat = old.find(s => s.token === room.hostToken);
          const idx = room.seats.findIndex(s => !s.bot && !s.ws.size);
          if (idx >= 0 && hostSeat) room.seats[idx] = { ...room.seats[idx], token: hostSeat.token, ws: hostSeat.ws };
          else if (hostSeat) room.seats[0] = { ...room.seats[0], token: hostSeat.token, ws: hostSeat.ws, bot: false };
        }
        // Spieler ohne Platz werden Zuschauer
        old.forEach(s => { if (!room.seats.includes(s) && !room.seats.some(n => n.token === s.token)) s.ws.forEach(w => { w.seat = null; room.spectators.add(w); }); });
        room.seats.forEach((s, idx) => { s.ws.forEach(w => { w.seat = idx; }); st.players[idx].bot = s.bot; });
        room.game = st;
        room.options.scenario = st.scenario.key;
        room.options.vpTarget = st.scenario.vpTarget;
        room.game.log.push({ n: (room.game.logSeq = (room.game.logSeq || 0) + 1), t: '📂 Spielstand geladen.' });
        room.seats.forEach((s, idx) => s.ws.forEach(w => send(w, { t: 'joined', room: room.id, token: s.token, seat: idx })));
        return broadcast(room);
      } catch (e) { return err(e.message || 'Spielstand ungültig.'); }
    }
    case 'reset': {
      room.game = null;
      return broadcast(room);
    }
    case 'deleteRoom': {
      room.seats.forEach(s => s.ws.forEach(w => { w.room = null; send(w, { t: 'kicked', msg: 'Der Raum wurde gelöscht.' }); }));
      room.spectators.forEach(w => { w.room = null; send(w, { t: 'kicked', msg: 'Der Raum wurde gelöscht.' }); });
      return deleteRoom(room);
    }
    default: return err('Unbekannte Nachricht.');
  }
}

// Verbindungen am Leben halten / tote entfernen
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30000);

// Alte, verlassene Räume aufräumen (30 Tage)
setInterval(() => {
  const limit = Date.now() - Sec.CONFIG.roomTtlDays * 24 * 3600 * 1000;
  for (const r of rooms.values()) {
    if (r.updated < limit && !r.seats.some(s => s.ws.size)) deleteRoom(r);
  }
}, 6 * 3600 * 1000);

loadRooms();
for (const r of rooms.values()) scheduleBots(r);
server.listen(PORT, HOST, () => {
  console.log(`Inselreich läuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Server-Passwort: ${PASSWORD ? 'aktiv' : 'AUS'} · Raumliste: ${Sec.CONFIG.roomList ? 'sichtbar' : 'versteckt'} · Räume werden nach ${Sec.CONFIG.roomTtlDays} Tagen Inaktivität gelöscht`);
});
