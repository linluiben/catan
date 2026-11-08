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
