'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../server/game');
const Bot = require('../server/bot');
const P = require('../server/position');
const { SCENARIOS } = require('../server/maps');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function play(scenario, n, steps) {
  const st = G.newGame({ scenario, players: Array.from({ length: n }, (_, i) => ({ name: 'Spieler ' + i, bot: true })) });
  let k = 0;
  while (st.phase !== 'ended' && k++ < steps) {
    for (let s = 0; s < n; s++) { const a = Bot.decide(st, s); if (a) { G.act(st, s, a); break; } }
  }
  return st;
}

for (const key of Object.keys(SCENARIOS)) {
  test(`Stellungscode-Rundreise: ${key}`, async () => {
    for (const steps of [0, 15, 200, 5000]) {
      const st = play(key, Math.min(4, SCENARIOS[key].maxPlayers), steps);
      const code = await P.encode(st);
      assert.ok(code.startsWith('IR1.'));
      assert.ok(code.length < 3000, 'Code zu lang: ' + code.length);
      const back = await P.decode(code);
      assert.ok(same(back.buildings, st.buildings), 'Gebäude');
      assert.ok(same(back.roads, st.roads), 'Straßen');
      assert.ok(same(Object.keys(back.ships), Object.keys(st.ships)), 'Schiffe');
      assert.ok(same(back.board.hexes.map(h => [h.type, h.number]), st.board.hexes.map(h => [h.type, h.number])), 'Felder');
      assert.ok(same(back.board.vertices.map(v => v.edges), st.board.vertices.map(v => v.edges)), 'Geometrie');
      assert.ok(same(back.board.harbors, st.board.harbors), 'Häfen');
      assert.ok(same(back.players.map(p => [p.name, p.res, p.pieces, p.knights, p.bonusVP, p.dev.map(d => d.type)]),
        st.players.map(p => [p.name, p.res, p.pieces, p.knights, p.bonusVP, p.dev.map(d => d.type)])), 'Spieler');
      assert.deepStrictEqual(back.bank, st.bank);
      assert.strictEqual(back.devDeck.length, st.devDeck.length);
      assert.strictEqual(back.phase, st.phase);
      assert.strictEqual(back.longestRoad, st.longestRoad);
      st.players.forEach(p => assert.ok(same(G.legalFor(back, p.seat), G.legalFor(st, p.seat)), 'erlaubte Züge'));
    }
  });
}

test('Aus einem Code geht das Spiel normal weiter', async () => {
  const st = play('archipel', 3, 60);
  const back = await P.decode(await P.encode(st));
  let steps = 0;
  while (back.phase !== 'ended' && steps++ < 20000) {
    let acted = false;
    for (let s = 0; s < 3; s++) {
      const a = Bot.decide(back, s);
      if (!a) continue;
      const r = G.act(back, s, a);
      assert.ok(r.ok, r.error);
      acted = true;
      break;
    }
    assert.ok(acted);
  }
  assert.strictEqual(back.phase, 'ended');
});

test('Code verträgt Zeilenumbrüche und Links', async () => {
  const st = play('classic', 3, 30);
  const code = await P.encode(st);
  const wrapped = code.replace(/(.{60})/g, '$1\n  ');
  assert.ok(same((await P.decode(wrapped)).buildings, st.buildings));
  assert.ok(same((await P.decode('https://example.de/inselreich/#pos=' + code)).buildings, st.buildings));
  assert.ok(same((await P.decode(code.slice(4))).buildings, st.buildings), 'ohne Präfix');
});

test('Kaputte oder bösartige Codes werden sauber abgelehnt', async () => {
  const bads = ['', 'hallo', 'IR1.', 'IR1.!!!!', 'IR1.AAAA', 'IR1.' + 'A'.repeat(300000)];
  for (const b of bads) await assert.rejects(P.decode(b), P.CodeError, JSON.stringify(b.slice(0, 20)));
  // "Zip-Bombe": winzig gepackt, riesig entpackt
  const huge = new TextEncoder().encode(JSON.stringify({ v: 1, x: ' '.repeat(5 * 1024 * 1024) }));
  const stream = new Blob([huge]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  packed.forEach(b => { s += String.fromCharCode(b); });
  const bomb = 'IR1.' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await assert.rejects(P.decode(bomb), /zu groß/);
  // Gültig gepackt, aber manipulierter Inhalt: zu viele Siedlungen
  const st = play('classic', 2, 0);
  for (let v = 0; v < 40; v += 3) st.buildings[v] = { owner: 0, type: 'settlement' };
  await assert.rejects(P.decode(await P.encode(st)), /Figuren/);
  // HTML im Namen wird entschärft
  const st2 = play('classic', 2, 0);
  st2.players[0].name = '<img src=x onerror=alert(1)>';
  st2.players[0].color = 'red;" onmouseover="alert(1)';
  const back = await P.decode(await P.encode(st2));
  assert.ok(!back.players[0].name.includes('<'));
  assert.match(back.players[0].color, /^#[0-9a-f]{6}$/i);
});
