'use strict';
// Lässt Bots komplette Partien auf allen Szenarien spielen und prüft Invarianten.
const test = require('node:test');
const assert = require('node:assert');
const G = require('../server/game');
const Bot = require('../server/bot');
const { SCENARIOS } = require('../server/maps');

function checkInvariants(st) {
  const bankStart = st.players.length > 4 ? 24 : 19;
  for (const k of G.RES) {
    const sum = st.bank[k] + st.players.reduce((s, p) => s + p.res[k], 0);
    assert.strictEqual(sum, bankStart, `Rohstoff ${k} nicht erhalten`);
    assert.ok(st.bank[k] >= 0);
    st.players.forEach(p => assert.ok(p.res[k] >= 0));
  }
  st.players.forEach(p => {
    Object.values(p.pieces).forEach(n => assert.ok(n >= 0, 'negative Figuren'));
  });
  for (const k in st.roads) assert.ok(st.ships[k] === undefined, 'Straße und Schiff auf derselben Kante');
}

function playGame(scenario, n, maxSteps = 20000) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ name: 'Bot' + i, bot: true });
  const st = G.newGame({ scenario, players });
  let steps = 0;
  while (st.phase !== 'ended' && steps < maxSteps) {
    let acted = false;
    for (let s = 0; s < n; s++) {
      const a = Bot.decide(st, s);
      if (!a) continue;
      const r = G.act(st, s, a);
      assert.ok(r.ok, `Bot-Aktion abgelehnt (${scenario}): ${JSON.stringify(a)} -> ${r.error}`);
      acted = true;
      steps++;
      checkInvariants(st);
      break;
    }
    assert.ok(acted, 'Spiel hängt: niemand kann handeln. pending=' + JSON.stringify(st.pending));
  }
  return { st, steps };
}

for (const key of Object.keys(SCENARIOS)) {
  const sc = SCENARIOS[key];
  for (const n of [...new Set([Math.max(sc.minPlayers, 3), sc.maxPlayers])]) {
    test(`Bots spielen ${key} mit ${n} Spielern zu Ende`, () => {
      for (let g = 0; g < 3; g++) {
        const { st } = playGame(key, n);
        assert.strictEqual(st.phase, 'ended', 'Spiel wurde nicht beendet');
        assert.ok(G.victoryPoints(st, st.winner, true) >= st.scenario.vpTarget);
      }
    });
  }
}

test('Regeln: Abstandsregel, Bauen, Kosten', () => {
  const st = G.newGame({ scenario: 'classic', players: [{ name: 'A' }, { name: 'B' }] });
  const spots = G.settlementSpots(st, 0, true);
  const v = spots[0];
  assert.ok(G.act(st, 0, { type: 'build', what: 'settlement', id: v }).ok);
  const adj = st.board.vertices[v].adj[0];
  assert.ok(!G.settlementSpots(st, 1, true).includes(adj), 'Abstandsregel verletzt');
  // falscher Spieler
  assert.strictEqual(G.act(st, 1, { type: 'build', what: 'road', id: st.board.vertices[v].edges[0] }).ok, false);
  const e = G.roadSpots(st, 0, v)[0];
  assert.ok(G.act(st, 0, { type: 'build', what: 'road', id: e }).ok);
});

test('Längste Straße wird erkannt und durch fremde Siedlung unterbrochen', () => {
  const st = G.newGame({ scenario: 'classic', players: [{ name: 'A' }, { name: 'B' }] });
  G.act(st, 0, { type: 'edit', op: 'toggle' });
  // Weg aus 6 Kanten suchen
  const land = st.board.edges.filter(e => e.hexes.every(h => st.board.hexes[h].type !== 'sea') && e.hexes.length === 2);
  let path = null;
  const dfs = (v, used, edges) => {
    if (edges.length === 6) { path = edges.slice(); return true; }
    for (const e of st.board.vertices[v].edges) {
      if (used.has(e) || !land.some(x => x.id === e)) continue;
      const ed = st.board.edges[e];
      const o = ed.v[0] === v ? ed.v[1] : ed.v[0];
      if (edges.some(x => st.board.edges[x].v.includes(o))) continue;
      used.add(e); edges.push(e);
      if (dfs(o, used, edges)) return true;
      used.delete(e); edges.pop();
    }
    return false;
  };
  for (const ed of land) { if (dfs(ed.v[0], new Set(), [])) break; }
  assert.ok(path);
  path.forEach(e => G.act(st, 0, { type: 'edit', op: 'place', what: 'road', id: e, owner: 0 }));
  assert.strictEqual(G.longestRoute(st, 0), 6);
  assert.strictEqual(st.longestRoad, 0);
  // fremde Siedlung in die Mitte
  const e2 = st.board.edges[path[2]], e3 = st.board.edges[path[3]];
  const mid = e2.v.find(x => e3.v.includes(x));
  G.act(st, 0, { type: 'edit', op: 'place', what: 'settlement', id: mid, owner: 1 });
  assert.strictEqual(G.longestRoute(st, 0), 3);
  assert.strictEqual(st.longestRoad, null);
});

test('Spielstand kann gespeichert und geladen werden', () => {
  const { st } = playGame('archipel', 3, 300);
  const copy = G.validateLoaded(JSON.parse(JSON.stringify(st)));
  assert.deepStrictEqual(copy.buildings, st.buildings);
  assert.strictEqual(copy.players.length, 3);
});

test('Editor: Häfen setzen, ändern, entfernen – Handelsverhältnis greift', () => {
  const st = G.newGame({ scenario: 'classic', players: [{ name: 'A' }, { name: 'B' }] });
  const isSea = (h) => st.board.hexes[h].type === 'sea';
  // Küstenkante ohne bestehenden Hafen suchen
  const coast = st.board.edges.find(e => e.hexes.some(isSea) && e.hexes.some(h => !isSea(h))
    && !st.board.harbors.some(hb => hb.edge === e.id));
  const inland = st.board.edges.find(e => e.hexes.length === 2 && e.hexes.every(h => !isSea(h)));
  assert.strictEqual(G.act(st, 0, { type: 'edit', op: 'harbor', edge: coast.id, harborType: 'ore' }).ok, false, 'nur im Editor');
  G.act(st, 0, { type: 'edit', op: 'toggle' });
  const n = st.board.harbors.length;
  assert.ok(G.act(st, 0, { type: 'edit', op: 'harbor', edge: coast.id, harborType: 'ore' }).ok);
  assert.strictEqual(st.board.harbors.length, n + 1);
  // Siedlung an den Hafen -> 2:1 für Erz
  G.act(st, 0, { type: 'edit', op: 'place', what: 'settlement', id: coast.v[0], owner: 0 });
  assert.strictEqual(G.tradeRatios(st, 0).ore, 2);
  assert.strictEqual(G.tradeRatios(st, 0).wood, 4);
  // Typ ändern ersetzt statt zu verdoppeln
  assert.ok(G.act(st, 0, { type: 'edit', op: 'harbor', edge: coast.id, harborType: 'any' }).ok);
  assert.strictEqual(st.board.harbors.length, n + 1);
  assert.strictEqual(G.tradeRatios(st, 0).wood, 3);
  // Entfernen
  assert.ok(G.act(st, 0, { type: 'edit', op: 'harbor', edge: coast.id, harborType: null }).ok);
  assert.strictEqual(st.board.harbors.length, n);
  assert.strictEqual(G.tradeRatios(st, 0).wood, 4);
  // Ungültig: Binnenkante, falscher Typ
  assert.strictEqual(G.act(st, 0, { type: 'edit', op: 'harbor', edge: inland.id, harborType: 'any' }).ok, false);
  assert.strictEqual(G.act(st, 0, { type: 'edit', op: 'harbor', edge: coast.id, harborType: '__proto__' }).ok, false);
});
