'use strict';
// Einfacher Computergegner. decide() liefert die nächste Aktion oder null (nichts zu tun).
const G = require('./game');
const { RES, COST, total } = G;

const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const counters = new Map();

function vertexScore(st, v) {
  let s = 0;
  const types = new Set();
  for (const h of st.board.vertices[v].hexes) {
    const hex = st.board.hexes[h];
    if (!hex.number || hex.id === st.board.robber) continue;
    s += PIPS[hex.number] * (hex.type === 'gold' ? 1.3 : 1);
    types.add(hex.type);
  }
  s += types.size * 0.7;
  if (st.board.harbors.some(hb => st.board.edges[hb.edge].v.includes(v))) s += 1;
  return s;
}

function settleable(st, w) {
  const vx = st.board.vertices[w];
  if (st.buildings[w] || vx.adj.some(a => st.buildings[a])) return false;
  return vx.hexes.some(h => st.board.hexes[h].type !== 'sea');
}

function edgeValue(st, seat, e) {
  // Wie gut führt diese Kante zu einem neuen Siedlungsplatz?
  let best = 0;
  const seen = new Set();
  let frontier = st.board.edges[e].v.filter(v => !(st.buildings[v] && st.buildings[v].owner !== seat));
  const weights = [1, 0.75, 0.45, 0.25];
  for (let d = 0; d < weights.length && frontier.length; d++) {
    const next = [];
    for (const v of frontier) {
      if (seen.has(v)) continue;
      seen.add(v);
      if (settleable(st, v)) best = Math.max(best, vertexScore(st, v) * weights[d]);
      st.board.vertices[v].adj.forEach(a => next.push(a));
    }
    frontier = next;
  }
  return best;
}

function pickEdge(st, seat, roads, ships) {
  let best = null;
  const p = st.players[seat];
  const consider = (list, what) => (list || []).forEach(e => {
    const v = edgeValue(st, seat, e) + Math.random() * 0.3;
    if (!best || v > best.v) best = { id: e, what, v };
  });
  if (p.pieces.road > 0) consider(roads, 'road');
  if (p.pieces.ship > 0) consider(ships, 'ship');
  return best && best.v > 0.5 ? best : null;
}

function bestVertex(st, list) {
  let best = null, bs = -1;
  for (const v of list) {
    const s = vertexScore(st, v) + Math.random() * 0.2;
    if (s > bs) { bs = s; best = v; }
  }
  return best;
}

function pickDiscard(res, n) {
  const r = { ...res }, out = { wood: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  for (let i = 0; i < n; i++) {
    const k = RES.reduce((a, b) => (r[b] > r[a] ? b : a));
    r[k]--; out[k]++;
  }
  return out;
}

function pickGold(st, p, n) {
  const r = { ...p.res }, bank = { ...st.bank }, out = { wood: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  for (let i = 0; i < n; i++) {
    const avail = RES.filter(k => bank[k] > 0);
    const k = avail.reduce((a, b) => (r[b] < r[a] ? b : a));
    r[k]++; bank[k]--; out[k]++;
  }
  return out;
}

function pickRobber(st, seat, spots) {
  let best = spots[0], bs = -Infinity;
  for (const h of spots) {
    const hex = st.board.hexes[h];
    let s = Math.random() * 0.1;
    if (hex.type === 'sea') {
      hex.edges.forEach(e => { const sh = st.ships[e]; if (sh) s += sh.owner === seat ? -3 : 1; });
      s -= 0.5;
    } else {
      const pip = PIPS[hex.number] || 0;
      hex.vertices.forEach(v => {
        const b = st.buildings[v];
        if (!b) return;
        const w = (b.type === 'city' ? 2 : 1) * pip;
        s += b.owner === seat ? -3 * w : w;
      });
    }
    if (s > bs) { bs = s; best = h; }
  }
  return best;
}

function tryBankTrade(st, seat, target) {
  const p = st.players[seat];
  const ratios = G.tradeRatios(st, seat);
  const missing = RES.filter(k => p.res[k] < (target[k] || 0) && st.bank[k] > 0);
  if (!missing.length) return null;
  for (const k of RES) {
    if ((target[k] || 0) > 0 && p.res[k] - target[k] < ratios[k]) continue;
    if (p.res[k] - (target[k] || 0) >= ratios[k]) return { type: 'bankTrade', give: k, get: missing[0] };
  }
  return null;
}

// peek=true: nur prüfen, ob der Bot etwas tun würde (ohne Zähler zu verändern)
function decide(st, seat, peek = false) {
  if (st.phase === 'ended' || st.editor) return null;
  const p = st.players[seat];
  const L = G.legalFor(st, seat);
  if (L.discard) return { type: 'discard', res: pickDiscard(p.res, L.discard) };
  if (L.gold) return { type: 'gold', res: pickGold(st, p, L.gold) };
  if (L.robber) return { type: 'moveRobber', hex: pickRobber(st, seat, L.robber) };
  if (L.steal) {
    const t = L.steal.reduce((a, b) => (total(st.players[b].res) > total(st.players[a].res) ? b : a));
    return { type: 'steal', target: t };
  }
  if (L.roadBuilding !== undefined) {
    const e = pickEdge(st, seat, L.road, L.ship) || fallbackEdge(L);
    return e ? { type: 'build', what: e.what, id: e.id } : { type: 'endRoadBuilding' };
  }
  if (st.pending.length) return null;
  if (st.phase === 'play' && st.trade && st.trade.from !== seat && st.trade.responses[seat] === undefined) {
    const t = st.trade;
    const keeps = RES.every(k => p.res[k] - (t.get[k] || 0) >= ((t.get[k] || 0) > 0 ? 1 : 0));
    const gainsNew = RES.some(k => (t.give[k] || 0) > 0 && p.res[k] === 0);
    return { type: 'respondTrade', accept: keeps && gainsNew && total(t.give) >= total(t.get) };
  }
  if (L.setup === 'settlement') return L.settlement.length ? { type: 'build', what: 'settlement', id: bestVertex(st, L.settlement) } : null;
  if (L.setup === 'road') {
    const e = pickEdge(st, seat, L.road, L.ship) || fallbackEdge(L);
    return e ? { type: 'build', what: e.what, id: e.id } : null;
  }
  if (!L.myTurn) return null;

  const key = seat + ':' + st.turnNumber;
  const n = (counters.get(key) || 0) + 1;
  if (!peek) counters.set(key, n);
  if (counters.size > 200) counters.delete(counters.keys().next().value);
  if (n > 40) return L.canEnd ? { type: 'endTurn' } : { type: 'roll' };

  const playable = L.playable || [];
  if (L.canRoll) {
    const robbed = st.board.robber !== null && st.board.hexes[st.board.robber].vertices.some(v => st.buildings[v] && st.buildings[v].owner === seat);
    if (robbed && playable.includes('knight')) return { type: 'playDev', card: 'knight' };
    return { type: 'roll' };
  }
  if (st.trade && st.trade.from === seat) {
    const yes = Object.keys(st.trade.responses).find(s => st.trade.responses[s]);
    return yes !== undefined ? { type: 'acceptTrade', with: Number(yes) } : { type: 'cancelTrade' };
  }
  if (playable.includes('knight') && Math.random() < 0.5) return { type: 'playDev', card: 'knight' };
  if (playable.includes('yearOfPlenty')) {
    const want = RES.filter(k => st.bank[k] > 0).sort((a, b) => p.res[a] - p.res[b]);
    if (want.length) return { type: 'playDev', card: 'yearOfPlenty', res1: want[0], res2: want[Math.min(1, want.length - 1)] };
  }
  if (playable.includes('roadBuilding') && pickEdge(st, seat, L.road, L.ship)) return { type: 'playDev', card: 'roadBuilding' };
  if (playable.includes('monopoly')) {
    const k = RES.reduce((a, b) => {
      const sa = st.players.reduce((s, o) => s + (o.seat !== seat ? o.res[a] : 0), 0);
      const sb = st.players.reduce((s, o) => s + (o.seat !== seat ? o.res[b] : 0), 0);
      return sb > sa ? b : a;
    });
    if (st.players.reduce((s, o) => s + (o.seat !== seat ? o.res[k] : 0), 0) >= 3) return { type: 'playDev', card: 'monopoly', res: k };
  }
  const afford = (c) => G.hasRes(p.res, c);
  if (L.city && L.city.length && afford(COST.city)) return { type: 'build', what: 'city', id: bestVertex(st, L.city) };
  if (L.settlement && L.settlement.length && afford(COST.settlement)) return { type: 'build', what: 'settlement', id: bestVertex(st, L.settlement) };
  const noSpots = !L.settlement || !L.settlement.length;
  if (noSpots) {
    if (L.movableShips && L.movableShips.length && Math.random() < 0.3) {
      // offenes Schiff an bessere Stelle versetzen
      const from = L.movableShips[0];
      const cur = edgeValue(st, seat, from);
      const saved = st.ships[from];
      delete st.ships[from]; // Ziele ohne das zu versetzende Schiff berechnen
      const spots = G.shipSpots(st, seat).filter(e => e !== from);
      const cand = pickEdge(st, seat, [], spots);
      st.ships[from] = saved;
      if (cand && cand.v > cur + 1) return { type: 'moveShip', from, to: cand.id };
    }
    const roadOK = afford(COST.road) && L.road && L.road.length;
    const shipOK = afford(COST.ship) && L.ship && L.ship.length;
    if (roadOK || shipOK) {
      const e = pickEdge(st, seat, roadOK ? L.road : [], shipOK ? L.ship : []);
      if (e) return { type: 'build', what: e.what, id: e.id };
    }
  }
  if (afford(COST.dev) && st.devDeck.length && (p.pieces.city === 0 || !L.city || !L.city.length || Math.random() < 0.4)) {
    return { type: 'buyDev' };
  }
  const targets = [];
  if (L.city && L.city.length) targets.push(COST.city);
  if (L.settlement && L.settlement.length) targets.push(COST.settlement);
  if (noSpots) targets.push(COST.road);
  targets.push(COST.dev);
  for (const t of targets) {
    const tr = tryBankTrade(st, seat, t);
    if (tr) return tr;
  }
  return { type: 'endTurn' };
}

function fallbackEdge(L) {
  if (L.road && L.road.length) return { id: L.road[Math.floor(Math.random() * L.road.length)], what: 'road' };
  if (L.ship && L.ship.length) return { id: L.ship[Math.floor(Math.random() * L.ship.length)], what: 'ship' };
  return null;
}

module.exports = { decide };
