'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const G = require('../server/game');

test('Manipulierter Spielstand wird bereinigt', () => {
  const st = G.newGame({ scenario: 'archipel', players: [{ name: 'A' }, { name: 'B' }] });
  const evil = JSON.parse(JSON.stringify(st));
  evil.players[0].color = '"><script>alert(1)</script>';
  evil.players[0].name = '<img src=x onerror=alert(1)>';
  evil.players[1].res.wood = -50;
  evil.board.hexes[0].number = '<svg onload=alert(1)>';
  evil.board.hexes[1].type = 'constructor';
  evil.buildings['999999'] = { owner: 0, type: 'settlement' };
  evil.buildings['0'] = { owner: 7, type: 'castle' };
  evil.pending = [{ type: 'eval', code: 'x' }];
  evil.__proto__polluted = { a: 1 };
  const clean = G.validateLoaded(evil);
  assert.match(clean.players[0].color, /^#[0-9a-f]{6}$/i);
  assert.ok(!clean.players[0].name.includes('<'));
  assert.strictEqual(clean.players[1].res.wood, 0);
  assert.strictEqual(clean.board.hexes[0].number, null);
  assert.strictEqual(clean.board.hexes[1].type, 'sea');
  assert.deepStrictEqual(clean.buildings, {});
  assert.deepStrictEqual(clean.pending, []);
  assert.strictEqual(clean.__proto__polluted, undefined);
  assert.throws(() => G.validateLoaded({ board: {}, players: [] }));
});

function startServer(env) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inselreich-'));
    const port = 3500 + Math.floor(Math.random() * 400);
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('läuft')) resolve({ proc, port, dir }); });
    proc.on('exit', (c) => reject(new Error('Server beendet: ' + c)));
  });
}
function wsCall(port, msg, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'error' || m.t === 'joined') { ws.close(); resolve(m); } });
    ws.on('unexpected-response', (_req, res) => resolve({ t: 'rejected', status: res.statusCode }));
    ws.on('error', () => {});
  });
}

test('Server: Sicherheits-Header, Passwort, Origin-Prüfung, Sperre', async (t) => {
  const { proc, port } = await startServer({ SERVER_PASSWORD: 'geheim', ROOM_LIST: 'false' });
  t.after(() => proc.kill());
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
  const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
  assert.strictEqual(info.passwordRequired, true);
  assert.strictEqual(info.roomList, false);
  // Pfad-Traversal
  const trav = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
  assert.notStrictEqual(trav.status, 200);
  // Raumliste versteckt, auch mit Passwort
  const list = await (await fetch(`http://127.0.0.1:${port}/api/rooms`, { headers: { 'X-Server-Password': 'geheim' } })).json();
  assert.deepStrictEqual(list, []);
  // Fremde Webseite darf keine WebSocket-Verbindung öffnen
  const evil = await wsCall(port, { t: 'create', name: 'X', password: 'geheim' }, { Origin: 'https://boese.example' });
  assert.strictEqual(evil.t, 'rejected');
  assert.strictEqual(evil.status, 403);
  // Falsches / richtiges Passwort
  assert.strictEqual((await wsCall(port, { t: 'create', name: 'A', password: 'falsch' })).t, 'error');
  const ok = await wsCall(port, { t: 'create', name: 'A', password: 'geheim' }, { Origin: `http://127.0.0.1:${port}` });
  assert.strictEqual(ok.t, 'joined');
  // Wiederverbinden mit Token klappt ohne Passwort
  const again = await wsCall(port, { t: 'join', room: ok.room, token: ok.token });
  assert.strictEqual(again.t, 'joined');
  // Nach 10 Fehlversuchen wird gesperrt – auch das richtige Passwort
  for (let i = 0; i < 10; i++) await wsCall(port, { t: 'join', room: ok.room, name: 'B', password: 'nope' + i });
  const locked = await wsCall(port, { t: 'join', room: ok.room, name: 'B', password: 'geheim' });
  assert.match(locked.msg, /Fehlversuche/);
});

// ---------------------------------------------------------------- Regressionen aus dem Code-Review
test('Engine: ungültiger Bautyp wird abgelehnt, Bot wirft in Randfällen nicht', () => {
  const Bot = require('../server/bot');
  const st = G.newGame({ scenario: 'classic', players: [{ name: 'A' }, { name: 'B' }] });
  while (st.phase === 'setup') { const s = st.setup.order[st.setup.idx]; G.act(st, s, Bot.decide(st, s)); }
  st.rolled = true;
  for (const what of ['__proto__', 'constructor', 'dev', 'toString']) {
    assert.strictEqual(G.act(st, st.turn, { type: 'build', what, id: 0 }).ok, false, what);
  }
  const st2 = G.newGame({ scenario: 'classic', players: [{ name: 'A', bot: true }, { name: 'B' }] });
  const v = G.settlementSpots(st2, 0, true)[0];
  G.act(st2, 0, { type: 'build', what: 'settlement', id: v });
  st2.board.vertices[v].edges.forEach(e => { st2.roads[e] = 1; });
  assert.doesNotThrow(() => Bot.decide(st2, 0));
});

test('Server: übersteht kaputte Requests, Plätze nicht per Name kaperbar, Brett nur bei Änderung', async (t) => {
  const { proc, port } = await startServer({});
  t.after(() => proc.kill());
  for (const bad of ['/%E0%A4%A', '/%', '/a%00b', '/..%2f..%2fetc%2fpasswd']) {
    const r = await fetch(`http://127.0.0.1:${port}${bad}`);
    assert.ok([400, 403, 404].includes(r.status), bad + ' -> ' + r.status);
  }
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/`)).status, 200, 'Server lebt noch');

  // Zwei Spieler, Ben trennt die Verbindung, Mallory versucht seinen Platz per Name zu übernehmen
  const conn = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
    ws.on('open', () => resolve({ ws, msgs }));
  });
  const until = async (c, pred) => { for (let i = 0; i < 100; i++) { const m = c.msgs.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timeout'); };
  const host = await conn();
  host.ws.send(JSON.stringify({ t: 'create', name: 'Anna' }));
  const joined = await until(host, m => m.t === 'joined');
  const ben = await conn();
  ben.ws.send(JSON.stringify({ t: 'join', room: joined.room, name: 'Ben' }));
  await until(ben, m => m.t === 'joined');
  host.ws.send(JSON.stringify({ t: 'start', keepOrder: true }));
  await until(host, m => m.t === 'room' && m.game);
  ben.ws.close();
  await new Promise(r => setTimeout(r, 100));
  const mal = await conn();
  mal.ws.send(JSON.stringify({ t: 'join', room: joined.room, name: 'ben' }));
  const denied = await until(mal, m => m.t === 'error' || m.t === 'joined');
  assert.strictEqual(denied.t, 'error', 'Platz durfte nicht per Name übernommen werden');
  // Gastgeber gibt frei -> jetzt klappt es
  host.ws.send(JSON.stringify({ t: 'release', seat: 1 }));
  await new Promise(r => setTimeout(r, 100));
  mal.msgs.length = 0;
  mal.ws.send(JSON.stringify({ t: 'join', room: joined.room, name: 'Ben' }));
  assert.strictEqual((await until(mal, m => m.t === 'error' || m.t === 'joined')).t, 'joined');

  // Brett nur beim ersten Mal bzw. bei Änderung; Chat-Nachrichten kommen ohne Brett
  host.msgs.length = 0;
  host.ws.send(JSON.stringify({ t: 'chat', text: 'hallo' }));
  const chatMsg = await until(host, m => m.t === 'room' && m.room.chat.some(c => c.text === 'hallo'));
  assert.strictEqual(chatMsg.board, undefined, 'Brett wurde unnötig erneut gesendet');
  const first = mal.msgs.find(m => m.t === 'room' && m.game);
  assert.ok(first && first.board, 'Neue Verbindung bekommt das Brett');
  [host, ben, mal].forEach(c => c.ws.close());
});
