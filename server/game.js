'use strict';
// Spiel-Engine: komplette Regeln inkl. Seefahrt (Schiffe, Pirat, Goldflüsse, Inselbonus).
// Der Zustand ist reines JSON, damit er gespeichert/geladen werden kann.

const { SCENARIOS, buildScenario, computeIslands, shuffle, RES } = require('./maps');

const RES_DE = { wood: 'Holz', brick: 'Lehm', wool: 'Wolle', grain: 'Getreide', ore: 'Erz' };
const COST = {
  road: { wood: 1, brick: 1 },
  ship: { wood: 1, wool: 1 },
  settlement: { wood: 1, brick: 1, wool: 1, grain: 1 },
  city: { grain: 2, ore: 3 },
  dev: { wool: 1, grain: 1, ore: 1 },
};
const DEV_DE = { knight: 'Ritter', vp: 'Siegpunkt', roadBuilding: 'Straßenbau', yearOfPlenty: 'Erfindung', monopoly: 'Monopol' };
const PIECE_DE = { road: 'Straße', ship: 'Schiff', settlement: 'Siedlung', city: 'Stadt' };
const COLORS = ['#d63031', '#0984e3', '#f39c12', '#ecf0f1', '#00b894', '#8e44ad'];

class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

const emptyRes = () => ({ wood: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const total = (r) => RES.reduce((s, k) => s + (r[k] || 0), 0);
const hasRes = (r, c) => RES.every(k => (r[k] || 0) >= (c[k] || 0));
function cleanRes(obj) {
  const r = emptyRes();
  if (!obj || typeof obj !== 'object') return r;
  RES.forEach(k => {
    const n = Math.floor(Number(obj[k]) || 0);
    if (n < 0) fail('Ungültige Anzahl');
    r[k] = n;
  });
  return r;
}
function moveRes(from, to, c) { RES.forEach(k => { from[k] -= c[k] || 0; to[k] += c[k] || 0; }); }
function resText(r) {
  return RES.filter(k => r[k]).map(k => `${r[k]} ${RES_DE[k]}`).join(', ') || 'nichts';
}

// ---------------------------------------------------------------- Erstellung
function newGame({ scenario = 'classic', players, vpTarget, rng = Math.random }) {
  const sc = SCENARIOS[scenario];
  if (!sc) fail('Unbekanntes Szenario');
  if (!players || players.length < 1 || players.length > 6) fail('1–6 Spieler erlaubt');
  const large = players.length > 4;
  const board = buildScenario(scenario, players.length, rng);
  const bankN = large ? 24 : 19;
  const bank = {}; RES.forEach(k => { bank[k] = bankN; });
  const deck = [];
  const add = (t, n) => { for (let i = 0; i < n; i++) deck.push(t); };
  add('knight', large ? 20 : 14); add('vp', 5);
  add('roadBuilding', large ? 3 : 2); add('yearOfPlenty', large ? 3 : 2); add('monopoly', large ? 3 : 2);
  shuffle(deck, rng);
  const n = players.length;
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (let i = n - 1; i >= 0; i--) order.push(i);
  const st = {
    version: 1,
    scenario: { key: scenario, name: sc.name, seafarers: !!sc.seafarers, islandBonus: sc.islandBonus || 0, vpTarget: Number(vpTarget) || sc.vp },
    board,
    players: players.map((p, i) => ({
      seat: i, name: String(p.name || `Spieler ${i + 1}`).slice(0, 24), color: p.color || COLORS[i], bot: !!p.bot,
      res: emptyRes(), dev: [], knights: 0,
      pieces: { road: 15, settlement: 5, city: 4, ship: sc.seafarers ? 15 : 0 },
      homeIslands: [], bonusIslands: [], bonusVP: 0,
    })),
    buildings: {}, roads: {}, ships: {},
    bank, devDeck: deck,
    phase: 'setup',
    setup: { order, idx: 0, step: 'settlement', lastVertex: null },
    turn: 0, turnNumber: 0, rolled: false, dice: null,
    pending: [], devPlayed: false, shipMoved: false, trade: null,
    longestRoad: null, largestArmy: null, roadLengths: players.map(() => 0),
    log: [], logSeq: 0, winner: null, editor: false,
  };
  log(st, `Neues Spiel: ${sc.name}. Ziel: ${st.scenario.vpTarget} Siegpunkte.`);
  log(st, `${st.players[0].name} beginnt mit der Gründungsphase.`);
  return st;
}

function log(st, text) {
  st.logSeq = (st.logSeq || 0) + 1;
  st.log.push({ n: st.logSeq, t: text });
  if (st.log.length > 300) st.log.splice(0, st.log.length - 300);
}

// ---------------------------------------------------------------- Geometrie-Helfer
const B = (st) => st.board;
const isLandHex = (st, h) => st.board.hexes[h].type !== 'sea';
const vertexLand = (st, v) => st.board.vertices[v].hexes.some(h => isLandHex(st, h));
const edgeRoadOK = (st, e) => st.board.edges[e].hexes.some(h => isLandHex(st, h));
const edgeShipOK = (st, e) => st.scenario.seafarers && st.board.edges[e].hexes.some(h => !isLandHex(st, h));
const edgeNearPirate = (st, e) => st.board.pirate !== null && st.board.edges[e].hexes.includes(st.board.pirate);
const edgeFree = (st, e) => st.roads[e] === undefined && st.ships[e] === undefined;
const otherEnd = (st, e, v) => { const ev = st.board.edges[e].v; return ev[0] === v ? ev[1] : ev[0]; };
function vertexIsland(st, v) {
  const h = st.board.vertices[v].hexes.find(x => isLandHex(st, x));
  return h === undefined ? -1 : st.board.islandOf[h];
}
function distanceOK(st, v) {
  if (st.buildings[v]) return false;
  return st.board.vertices[v].adj.every(a => !st.buildings[a]);
}
function connectsRoad(st, seat, e) {
  return st.board.edges[e].v.some(v => {
    const b = st.buildings[v];
    if (b) return b.owner === seat;
    return st.board.vertices[v].edges.some(e2 => e2 !== e && st.roads[e2] === seat);
  });
}
function connectsShip(st, seat, e) {
  return st.board.edges[e].v.some(v => {
    const b = st.buildings[v];
    if (b) return b.owner === seat;
    return st.board.vertices[v].edges.some(e2 => e2 !== e && st.ships[e2] && st.ships[e2].owner === seat);
  });
}

// ---------------------------------------------------------------- Legale Bauplätze
function settlementSpots(st, seat, setup) {
  const out = [];
  for (const vx of st.board.vertices) {
    const v = vx.id;
    if (!vertexLand(st, v) || !distanceOK(st, v)) continue;
    if (!setup) {
      const linked = vx.edges.some(e => st.roads[e] === seat || (st.ships[e] && st.ships[e].owner === seat));
      if (!linked) continue;
    }
    out.push(v);
  }
  return out;
}
function citySpots(st, seat) {
  return Object.keys(st.buildings).map(Number)
    .filter(v => st.buildings[v].owner === seat && st.buildings[v].type === 'settlement');
}
function roadSpots(st, seat, fromVertex) {
  const out = [];
  const list = fromVertex !== undefined && fromVertex !== null ? st.board.vertices[fromVertex].edges : st.board.edges.map(e => e.id);
  for (const e of list) {
    if (!edgeFree(st, e) || !edgeRoadOK(st, e)) continue;
    if (fromVertex === undefined || fromVertex === null) { if (!connectsRoad(st, seat, e)) continue; }
    out.push(e);
  }
  return out;
}
function shipSpots(st, seat, fromVertex) {
  if (!st.scenario.seafarers) return [];
  const out = [];
  const list = fromVertex !== undefined && fromVertex !== null ? st.board.vertices[fromVertex].edges : st.board.edges.map(e => e.id);
  for (const e of list) {
    if (!edgeFree(st, e) || !edgeShipOK(st, e) || edgeNearPirate(st, e)) continue;
    if (fromVertex === undefined || fromVertex === null) { if (!connectsShip(st, seat, e)) continue; }
    out.push(e);
  }
  return out;
}
function movableShips(st, seat) {
  const out = [];
  for (const k of Object.keys(st.ships)) {
    const e = Number(k), s = st.ships[k];
    if (s.owner !== seat || s.turn === st.turnNumber || edgeNearPirate(st, e)) continue;
    const open = st.board.edges[e].v.some(v => {
      const b = st.buildings[v];
      if (b && b.owner === seat) return false;
      return !st.board.vertices[v].edges.some(e2 => e2 !== e && st.ships[e2] && st.ships[e2].owner === seat);
    });
    if (open) out.push(e);
  }
  return out;
}
function robberSpots(st) {
  return st.board.hexes.filter(h => {
    if (h.type === 'sea') return st.scenario.seafarers && st.board.pirate !== null && h.id !== st.board.pirate;
    return h.id !== st.board.robber;
  }).map(h => h.id);
}
function tradeRatios(st, seat) {
  const r = {}; RES.forEach(k => { r[k] = 4; });
  for (const h of st.board.harbors) {
    const owned = st.board.edges[h.edge].v.some(v => st.buildings[v] && st.buildings[v].owner === seat);
    if (!owned) continue;
    if (h.type === 'any') RES.forEach(k => { r[k] = Math.min(r[k], 3); });
    else r[h.type] = 2;
  }
  return r;
}

// ---------------------------------------------------------------- Punkte & Sonderkarten
function victoryPoints(st, seat, hidden) {
  let vp = 0;
  for (const k in st.buildings) {
    const b = st.buildings[k];
    if (b.owner === seat) vp += b.type === 'city' ? 2 : 1;
  }
  if (st.longestRoad === seat) vp += 2;
  if (st.largestArmy === seat) vp += 2;
  const p = st.players[seat];
  vp += p.bonusVP || 0;
  if (hidden) vp += p.dev.filter(d => d.type === 'vp').length;
  return vp;
}

function longestRoute(st, seat) {
  const mine = {};
  for (const k in st.roads) if (st.roads[k] === seat) mine[k] = 'r';
  for (const k in st.ships) if (st.ships[k].owner === seat) mine[k] = 's';
  let best = 0;
  const used = new Set();
  const dfs = (v, kind, len) => {
    if (len > best) best = len;
    const b = st.buildings[v];
    if (b && b.owner !== seat) return;
    for (const e of st.board.vertices[v].edges) {
      const k = mine[e];
      if (!k || used.has(e)) continue;
      if (k !== kind && !(b && b.owner === seat)) continue; // Wechsel Straße<->Schiff nur an eigener Siedlung
      used.add(e);
      dfs(otherEnd(st, e, v), k, len + 1);
      used.delete(e);
    }
  };
  for (const k in mine) {
    const e = Number(k);
    for (const v of st.board.edges[e].v) {
      used.add(e);
      dfs(otherEnd(st, e, v), mine[k], 1);
      used.delete(e);
    }
  }
  return best;
}

function updateSpecials(st) {
  const lens = st.players.map(p => longestRoute(st, p.seat));
  st.roadLengths = lens;
  const holder = st.longestRoad;
  const others = (s) => Math.max(0, ...lens.filter((_, i) => i !== s));
  if (holder !== null && lens[holder] >= 5 && lens[holder] >= others(holder)) {
    // bleibt
  } else {
    const max = Math.max(...lens);
    const who = lens.map((l, i) => l === max ? i : -1).filter(i => i >= 0);
    const next = max >= 5 && who.length === 1 ? who[0] : null;
    if (next !== holder) {
      st.longestRoad = next;
      if (next !== null) log(st, `${st.players[next].name} hat jetzt die längste Handelsstraße (${max}).`);
      else if (holder !== null) log(st, `Niemand hat mehr die längste Handelsstraße.`);
    }
  }
  // größte Rittermacht
  let army = st.largestArmy;
  for (const p of st.players) {
    if (p.knights >= 3 && (army === null || p.knights > st.players[army].knights)) army = p.seat;
  }
  if (army !== null && st.players[army].knights < 3) army = null;
  if (army !== st.largestArmy) {
    st.largestArmy = army;
    if (army !== null) log(st, `${st.players[army].name} hat jetzt die größte Rittermacht.`);
  }
}

function checkWin(st) {
  if (st.phase !== 'play' || st.editor) return;
  const vp = victoryPoints(st, st.turn, true);
  if (vp >= st.scenario.vpTarget) {
    st.phase = 'ended';
    st.winner = st.turn;
    st.pending = [];
    log(st, `🏆 ${st.players[st.turn].name} gewinnt mit ${vp} Siegpunkten!`);
  }
}

// ---------------------------------------------------------------- Aktionen
function act(st, seat, action) {
  action = action || {};
  try {
    doAct(st, seat, action);
    if (action.type !== 'edit') { updateSpecials(st); checkWin(st); }
    return { ok: true };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
}

function doAct(st, seat, a) {
  if (a.type === 'edit') return editAction(st, a);
  if (st.editor) fail('Editor-Modus ist aktiv – erst beenden.');
  if (st.phase === 'ended') fail('Das Spiel ist beendet.');
  const p = st.players[seat];
  if (!p) fail('Du sitzt nicht am Tisch.');
  const pend = st.pending[0];
  if (pend) return pendingAction(st, seat, a, pend);
  if (st.phase === 'setup') return setupAction(st, seat, a);
  if (a.type === 'respondTrade') return respondTrade(st, seat, a);
  if (seat !== st.turn) fail('Du bist nicht am Zug.');
  switch (a.type) {
    case 'roll': return roll(st);
    case 'build': return build(st, seat, a, false);
    case 'buyDev': return buyDev(st, seat);
    case 'playDev': return playDev(st, seat, a);
    case 'bankTrade': return bankTrade(st, seat, a);
    case 'offerTrade': return offerTrade(st, seat, a);
    case 'acceptTrade': return acceptTrade(st, seat, a);
    case 'cancelTrade': st.trade = null; return;
    case 'moveShip': return moveShip(st, seat, a);
    case 'endTurn': return endTurn(st);
    default: fail('Unbekannte Aktion.');
  }
}

function setupAction(st, seat, a) {
  const s = st.setup;
  const cur = s.order[s.idx];
  if (seat !== cur) fail('Du bist nicht am Zug.');
  if (a.type !== 'build') fail('In der Gründungsphase kannst du nur bauen.');
  const p = st.players[seat];
  if (s.step === 'settlement') {
    if (a.what !== 'settlement') fail('Setze zuerst eine Siedlung.');
    const v = Number(a.id);
    if (!st.board.vertices[v] || !settlementSpots(st, seat, true).includes(v)) fail('Hier darf keine Siedlung stehen.');
    st.buildings[v] = { owner: seat, type: 'settlement' };
    p.pieces.settlement--;
    const isl = vertexIsland(st, v);
    if (isl >= 0 && !p.homeIslands.includes(isl)) p.homeIslands.push(isl);
    log(st, `${p.name} gründet eine Siedlung.`);
    if (s.idx >= st.players.length) {
      const gain = emptyRes();
      let gold = 0;
      for (const h of st.board.vertices[v].hexes) {
        const t = st.board.hexes[h].type;
        if (RES.includes(t) && st.bank[t] > 0) gain[t]++;
        else if (t === 'gold') gold++;
      }
      moveRes(st.bank, p.res, gain);
      log(st, `${p.name} erhält ${resText(gain)}.`);
      gold = Math.min(gold, total(st.bank));
      if (gold > 0) st.pending.push({ type: 'gold', need: { [seat]: gold } });
    }
    s.lastVertex = v;
    s.step = 'road';
  } else {
    const e = Number(a.id);
    if (!st.board.edges[e]) fail('Ungültige Kante.');
    if (a.what === 'road') {
      if (!roadSpots(st, seat, s.lastVertex).includes(e)) fail('Die Straße muss an deiner neuen Siedlung liegen.');
      st.roads[e] = seat; p.pieces.road--;
    } else if (a.what === 'ship') {
      if (!shipSpots(st, seat, s.lastVertex).includes(e)) fail('Das Schiff muss an deiner neuen Siedlung im Wasser liegen.');
      st.ships[e] = { owner: seat, turn: 0 }; p.pieces.ship--;
    } else fail('Setze jetzt eine Straße oder ein Schiff.');
    log(st, `${p.name} baut ${a.what === 'road' ? 'eine Straße' : 'ein Schiff'}.`);
    s.idx++;
    s.step = 'settlement';
    s.lastVertex = null;
    if (s.idx >= s.order.length) {
      st.phase = 'play';
      st.setup = null;
      st.turn = 0;
      st.turnNumber = 1;
      st.rolled = false;
      log(st, `Gründungsphase beendet. ${st.players[0].name} würfelt zuerst.`);
    }
  }
}

function pendingAction(st, seat, a, pend) {
  if (a.type === 'respondTrade') fail('Gerade nicht möglich.');
  switch (pend.type) {
    case 'discard': {
      if (a.type !== 'discard') fail('Es müssen erst Karten abgeworfen werden.');
      const need = pend.need[seat];
      if (!need) fail('Du musst nichts abwerfen.');
      const r = cleanRes(a.res);
      if (total(r) !== need) fail(`Du musst genau ${need} Karten abwerfen.`);
      const p = st.players[seat];
      if (!hasRes(p.res, r)) fail('So viele Karten hast du nicht.');
      moveRes(p.res, st.bank, r);
      delete pend.need[seat];
      log(st, `${p.name} wirft ${need} Karten ab.`);
      if (!Object.keys(pend.need).length) st.pending.shift();
      return;
    }
    case 'gold': {
      if (a.type !== 'gold') fail('Es wird noch Gold eingelöst.');
      const need = pend.need[seat];
      if (!need) fail('Du hast kein Gold zu wählen.');
      const r = cleanRes(a.res);
      if (total(r) !== need) fail(`Wähle genau ${need} Rohstoffe.`);
      if (!hasRes(st.bank, r)) fail('Die Bank hat nicht genug davon.');
      const p = st.players[seat];
      moveRes(st.bank, p.res, r);
      delete pend.need[seat];
      log(st, `${p.name} wählt aus dem Goldfluss: ${resText(r)}.`);
      if (!Object.keys(pend.need).length) st.pending.shift();
      return;
    }
    case 'robber': {
      if (seat !== pend.seat) fail(`${st.players[pend.seat].name} versetzt gerade den Räuber.`);
      if (a.type !== 'moveRobber') fail('Versetze zuerst den Räuber' + (st.scenario.seafarers ? ' oder den Piraten.' : '.'));
      const h = Number(a.hex);
      if (!robberSpots(st).includes(h)) fail('Dorthin geht das nicht.');
      const hex = st.board.hexes[h];
      let victims;
      if (hex.type === 'sea') {
        st.board.pirate = h;
        victims = hex.edges.map(e => st.ships[e] && st.ships[e].owner).filter(o => o !== undefined);
        log(st, `${st.players[seat].name} versetzt den Piraten.`);
      } else {
        st.board.robber = h;
        victims = hex.vertices.map(v => st.buildings[v] && st.buildings[v].owner).filter(o => o !== undefined);
        log(st, `${st.players[seat].name} versetzt den Räuber.`);
      }
      victims = [...new Set(victims)].filter(o => o !== seat && total(st.players[o].res) > 0);
      st.pending.shift();
      if (victims.length === 1) steal(st, seat, victims[0]);
      else if (victims.length > 1) st.pending.unshift({ type: 'steal', seat, targets: victims });
      return;
    }
    case 'steal': {
      if (seat !== pend.seat) fail('Gerade nicht möglich.');
      if (a.type !== 'steal') fail('Wähle, bei wem du eine Karte ziehst.');
      const t = Number(a.target);
      if (!pend.targets.includes(t)) fail('Bei diesem Spieler geht das nicht.');
      st.pending.shift();
      steal(st, seat, t);
      return;
    }
    case 'roadBuilding': {
      if (seat !== pend.seat) fail('Gerade nicht möglich.');
      if (a.type === 'endRoadBuilding') { st.pending.shift(); return; }
      if (a.type !== 'build' || (a.what !== 'road' && a.what !== 'ship')) fail('Baue deine kostenlosen Straßen/Schiffe.');
      build(st, seat, a, true);
      pend.left--;
      const p = st.players[seat];
      const more = (p.pieces.road > 0 && roadSpots(st, seat).length) || (p.pieces.ship > 0 && shipSpots(st, seat).length);
      if (pend.left <= 0 || !more) st.pending.shift();
      return;
    }
    default: fail('Unbekannter Zustand.');
  }
}

function steal(st, thief, victim) {
  const vr = st.players[victim].res;
  const cards = [];
  RES.forEach(k => { for (let i = 0; i < vr[k]; i++) cards.push(k); });
  if (!cards.length) return;
  const k = cards[Math.floor(Math.random() * cards.length)];
  vr[k]--; st.players[thief].res[k]++;
  log(st, `${st.players[thief].name} zieht eine Karte von ${st.players[victim].name}.`);
}

function roll(st) {
  if (st.rolled) fail('Du hast schon gewürfelt.');
  const d1 = 1 + Math.floor(Math.random() * 6), d2 = 1 + Math.floor(Math.random() * 6);
  st.dice = [d1, d2];
  st.rolled = true;
  const sum = d1 + d2;
  const p = st.players[st.turn];
  log(st, `${p.name} würfelt ${d1} + ${d2} = ${sum}.`);
  if (sum === 7) {
    const need = {};
    st.players.forEach(pl => { const t = total(pl.res); if (t > 7) need[pl.seat] = Math.floor(t / 2); });
    if (Object.keys(need).length) st.pending.push({ type: 'discard', need });
    st.pending.push({ type: 'robber', seat: st.turn });
    st.trade = null;
  } else produce(st, sum);
}

function produce(st, sum) {
  const gains = st.players.map(() => emptyRes());
  const gold = {};
  for (const h of st.board.hexes) {
    if (h.number !== sum || h.id === st.board.robber || h.type === 'sea' || h.type === 'desert') continue;
    for (const v of h.vertices) {
      const b = st.buildings[v];
      if (!b) continue;
      const n = b.type === 'city' ? 2 : 1;
      if (h.type === 'gold') gold[b.owner] = (gold[b.owner] || 0) + n;
      else gains[b.owner][h.type] += n;
    }
  }
  for (const k of RES) {
    const need = gains.reduce((s, g) => s + g[k], 0);
    if (!need) continue;
    if (need <= st.bank[k]) continue;
    const who = gains.filter(g => g[k] > 0);
    if (who.length === 1) who[0][k] = st.bank[k];
    else gains.forEach(g => { g[k] = 0; });
    log(st, `Die Bank hat nicht genug ${RES_DE[k]}.`);
  }
  gains.forEach((g, i) => {
    if (!total(g)) return;
    moveRes(st.bank, st.players[i].res, g);
    log(st, `${st.players[i].name} erhält ${resText(g)}.`);
  });
  let bankLeft = total(st.bank);
  const need = {};
  for (const s of Object.keys(gold)) {
    const n = Math.min(gold[s], bankLeft);
    bankLeft -= n;
    if (n > 0) need[s] = n;
  }
  if (Object.keys(need).length) st.pending.push({ type: 'gold', need });
}

function build(st, seat, a, free) {
  if (!free && !st.rolled) fail('Erst würfeln.');
  const p = st.players[seat];
  const what = a.what;
  if (!COST[what] || what === 'dev') fail('Unbekanntes Bauwerk.');
  if (p.pieces[what] <= 0) fail(`Du hast keine ${PIECE_DE[what]} mehr übrig.`);
  if (!free && !hasRes(p.res, COST[what])) fail('Dafür fehlen dir Rohstoffe.');
  const id = Number(a.id);
  if (what === 'settlement') {
    if (!settlementSpots(st, seat, false).includes(id)) fail('Hier darfst du keine Siedlung bauen.');
    st.buildings[id] = { owner: seat, type: 'settlement' };
    const isl = vertexIsland(st, id);
    if (st.scenario.islandBonus && isl >= 0 && !p.homeIslands.includes(isl) && !p.bonusIslands.includes(isl)) {
      p.bonusIslands.push(isl);
      p.bonusVP += st.scenario.islandBonus;
      log(st, `${p.name} besiedelt eine neue Insel: +${st.scenario.islandBonus} Siegpunkte!`);
    }
  } else if (what === 'city') {
    if (!citySpots(st, seat).includes(id)) fail('Eine Stadt kann nur auf eigener Siedlung entstehen.');
    st.buildings[id] = { owner: seat, type: 'city' };
    p.pieces.settlement++;
  } else if (what === 'road') {
    if (!roadSpots(st, seat).includes(id)) fail('Hier darfst du keine Straße bauen.');
    st.roads[id] = seat;
  } else if (what === 'ship') {
    if (!shipSpots(st, seat).includes(id)) fail('Hier darfst du kein Schiff bauen.');
    st.ships[id] = { owner: seat, turn: st.turnNumber };
  }
  p.pieces[what]--;
  if (!free) moveRes(p.res, st.bank, COST[what]);
  log(st, `${p.name} baut ${what === 'city' ? 'eine Stadt' : what === 'settlement' ? 'eine Siedlung' : what === 'road' ? 'eine Straße' : 'ein Schiff'}${free ? ' (kostenlos)' : ''}.`);
}

function buyDev(st, seat) {
  if (!st.rolled) fail('Erst würfeln.');
  const p = st.players[seat];
  if (!st.devDeck.length) fail('Keine Entwicklungskarten mehr.');
  if (!hasRes(p.res, COST.dev)) fail('Dafür fehlen dir Rohstoffe.');
  moveRes(p.res, st.bank, COST.dev);
  const type = st.devDeck.pop();
  p.dev.push({ type, turn: st.turnNumber });
  log(st, `${p.name} kauft eine Entwicklungskarte.`);
}

function playDev(st, seat, a) {
  if (st.devPlayed) fail('Pro Zug nur eine Entwicklungskarte.');
  const p = st.players[seat];
  const card = a.card;
  if (card === 'vp') fail('Siegpunktkarten zählen automatisch.');
  const idx = p.dev.findIndex(d => d.type === card && d.turn < st.turnNumber);
  if (idx < 0) fail('Diese Karte kannst du gerade nicht ausspielen.');
  // Validierung vor dem Entfernen
  if (card === 'yearOfPlenty') {
    const r1 = a.res1, r2 = a.res2;
    if (!RES.includes(r1) || !RES.includes(r2)) fail('Wähle zwei Rohstoffe.');
    const want = emptyRes(); want[r1]++; want[r2]++;
    if (!hasRes(st.bank, want)) fail('Die Bank hat nicht genug davon.');
    p.dev.splice(idx, 1);
    moveRes(st.bank, p.res, want);
    log(st, `${p.name} spielt Erfindung: ${resText(want)}.`);
  } else if (card === 'monopoly') {
    if (!RES.includes(a.res)) fail('Wähle einen Rohstoff.');
    p.dev.splice(idx, 1);
    let sum = 0;
    st.players.forEach(o => { if (o.seat !== seat) { sum += o.res[a.res]; p.res[a.res] += o.res[a.res]; o.res[a.res] = 0; } });
    log(st, `${p.name} spielt Monopol auf ${RES_DE[a.res]} und erhält ${sum} Karten.`);
  } else if (card === 'knight') {
    p.dev.splice(idx, 1);
    p.knights++;
    st.trade = null;
    st.pending.unshift({ type: 'robber', seat });
    log(st, `${p.name} spielt einen Ritter.`);
  } else if (card === 'roadBuilding') {
    p.dev.splice(idx, 1);
    log(st, `${p.name} spielt Straßenbau.`);
    const can = (p.pieces.road > 0 && roadSpots(st, seat).length) || (p.pieces.ship > 0 && shipSpots(st, seat).length);
    if (can) st.pending.unshift({ type: 'roadBuilding', seat, left: 2 });
  } else fail('Unbekannte Karte.');
  st.devPlayed = true;
}

function bankTrade(st, seat, a) {
  if (!st.rolled) fail('Erst würfeln.');
  const { give, get } = a;
  if (!RES.includes(give) || !RES.includes(get) || give === get) fail('Ungültiger Tausch.');
  const p = st.players[seat];
  const ratio = tradeRatios(st, seat)[give];
  if (p.res[give] < ratio) fail(`Du brauchst ${ratio} ${RES_DE[give]}.`);
  if (st.bank[get] < 1) fail('Die Bank hat davon nichts mehr.');
  p.res[give] -= ratio; st.bank[give] += ratio;
  p.res[get]++; st.bank[get]--;
  log(st, `${p.name} tauscht ${ratio} ${RES_DE[give]} gegen 1 ${RES_DE[get]} mit der Bank.`);
}

function offerTrade(st, seat, a) {
  if (!st.rolled) fail('Erst würfeln.');
  const give = cleanRes(a.give), get = cleanRes(a.get);
  if (!total(give) || !total(get)) fail('Ein Angebot braucht Geben und Nehmen.');
  if (!hasRes(st.players[seat].res, give)) fail('So viel hast du nicht.');
  st.trade = { from: seat, give, get, responses: {} };
  log(st, `${st.players[seat].name} bietet ${resText(give)} für ${resText(get)}.`);
}
function respondTrade(st, seat, a) {
  const t = st.trade;
  if (!t || st.phase !== 'play') fail('Kein Angebot offen.');
  if (seat === t.from) fail('Das ist dein eigenes Angebot.');
  if (a.accept && !hasRes(st.players[seat].res, t.get)) fail('Dafür fehlen dir die Rohstoffe.');
  t.responses[seat] = !!a.accept;
}
function acceptTrade(st, seat, a) {
  const t = st.trade;
  if (!t || t.from !== seat) fail('Kein eigenes Angebot offen.');
  const o = Number(a.with);
  if (t.responses[o] !== true) fail('Dieser Spieler hat nicht zugestimmt.');
  const me = st.players[seat], other = st.players[o];
  if (!hasRes(me.res, t.give) || !hasRes(other.res, t.get)) { t.responses[o] = false; fail('Jemandem fehlen inzwischen die Rohstoffe.'); }
  moveRes(me.res, other.res, t.give);
  moveRes(other.res, me.res, t.get);
  log(st, `${me.name} handelt mit ${other.name}: ${resText(t.give)} gegen ${resText(t.get)}.`);
  st.trade = null;
}

function moveShip(st, seat, a) {
  if (!st.scenario.seafarers) fail('Keine Schiffe in diesem Szenario.');
  if (!st.rolled) fail('Erst würfeln.');
  if (st.shipMoved) fail('Pro Zug darfst du nur ein Schiff versetzen.');
  const from = Number(a.from), to = Number(a.to);
  if (!movableShips(st, seat).includes(from)) fail('Dieses Schiff kann nicht versetzt werden.');
  const saved = st.ships[from];
  delete st.ships[from];
  if (to === from || !shipSpots(st, seat).includes(to)) { st.ships[from] = saved; fail('Dorthin kann das Schiff nicht fahren.'); }
  st.ships[to] = { owner: seat, turn: saved.turn };
  st.shipMoved = true;
  log(st, `${st.players[seat].name} versetzt ein Schiff.`);
}

function endTurn(st) {
  if (!st.rolled) fail('Erst würfeln.');
  st.turn = (st.turn + 1) % st.players.length;
  st.turnNumber++;
  st.rolled = false;
  st.devPlayed = false;
  st.shipMoved = false;
  st.trade = null;
  log(st, `${st.players[st.turn].name} ist am Zug.`);
}

// ---------------------------------------------------------------- Editor (freie Stellung)
function editAction(st, a) {
  const op = a.op;
  if (op === 'toggle') {
    st.editor = !st.editor;
    log(st, st.editor ? '✏️ Editor-Modus aktiviert.' : '✏️ Editor-Modus beendet.');
    if (!st.editor) { updateSpecials(st); checkWin(st); }
    return;
  }
  if (!st.editor) fail('Editor-Modus ist nicht aktiv.');
  const seatOK = (s) => { if (!st.players[s]) fail('Ungültiger Spieler.'); return st.players[s]; };
  const refundVertex = (v) => {
    const b = st.buildings[v];
    if (!b) return;
    st.players[b.owner].pieces[b.type]++;
    delete st.buildings[v];
  };
  const refundEdge = (e) => {
    if (st.roads[e] !== undefined) { st.players[st.roads[e]].pieces.road++; delete st.roads[e]; }
    if (st.ships[e] !== undefined) { st.players[st.ships[e].owner].pieces.ship++; delete st.ships[e]; }
  };
  switch (op) {
    case 'place': {
      const p = seatOK(Number(a.owner));
      const id = Number(a.id);
      if (a.what === 'settlement' || a.what === 'city') {
        if (!st.board.vertices[id] || !vertexLand(st, id)) fail('Ungültige Ecke.');
        refundVertex(id);
        if (p.pieces[a.what] <= 0) fail('Keine Figuren mehr übrig.');
        st.buildings[id] = { owner: p.seat, type: a.what };
        p.pieces[a.what]--;
      } else if (a.what === 'road' || a.what === 'ship') {
        if (!st.board.edges[id]) fail('Ungültige Kante.');
        if (a.what === 'road' && !edgeRoadOK(st, id)) fail('Straßen nur an Land.');
        if (a.what === 'ship' && !edgeShipOK(st, id)) fail('Schiffe nur am/im Wasser (Seefahrt-Szenario).');
        refundEdge(id);
        if (p.pieces[a.what] <= 0) fail('Keine Figuren mehr übrig.');
        if (a.what === 'road') st.roads[id] = p.seat; else st.ships[id] = { owner: p.seat, turn: 0 };
        p.pieces[a.what]--;
      } else fail('Unbekannt.');
      break;
    }
    case 'remove': {
      const id = Number(a.id);
      if (a.kind === 'vertex') refundVertex(id); else refundEdge(id);
      break;
    }
    case 'robber': {
      const h = st.board.hexes[Number(a.hex)];
      if (!h) fail('Ungültiges Feld.');
      if (h.type === 'sea') { if (!st.scenario.seafarers) fail('Pirat nur in Seefahrt-Szenarien.'); st.board.pirate = h.id; }
      else st.board.robber = h.id;
      break;
    }
    case 'res': {
      const p = seatOK(Number(a.seat));
      if (!RES.includes(a.res)) fail('Ungültiger Rohstoff.');
      const d = Math.trunc(Number(a.delta) || 0);
      if (d > 0 && st.bank[a.res] < d) fail('Bank ist leer.');
      if (d < 0 && p.res[a.res] < -d) fail('Nicht genug Karten.');
      p.res[a.res] += d; st.bank[a.res] -= d;
      break;
    }
    case 'dev': {
      const p = seatOK(Number(a.seat));
      if (!DEV_DE[a.card]) fail('Ungültige Karte.');
      if (Number(a.delta) > 0) {
        const i = st.devDeck.lastIndexOf(a.card);
        if (i < 0) fail('Keine solche Karte mehr im Stapel.');
        st.devDeck.splice(i, 1);
        p.dev.push({ type: a.card, turn: 0 });
      } else {
        const i = p.dev.findIndex(d => d.type === a.card);
        if (i < 0) fail('Spieler hat diese Karte nicht.');
        p.dev.splice(i, 1);
        st.devDeck.push(a.card);
        shuffle(st.devDeck);
      }
      break;
    }
    case 'knights': {
      const p = seatOK(Number(a.seat));
      p.knights = Math.max(0, p.knights + Math.trunc(Number(a.delta) || 0));
      break;
    }
    case 'bonus': {
      const p = seatOK(Number(a.seat));
      p.bonusVP = Math.max(0, (p.bonusVP || 0) + Math.trunc(Number(a.delta) || 0));
      break;
    }
    case 'hex': {
      const h = st.board.hexes[Number(a.hex)];
      if (!h) fail('Ungültiges Feld.');
      const types = ['sea', 'desert', 'gold', ...RES];
      if (a.hexType !== undefined) {
        if (!types.includes(a.hexType)) fail('Ungültiger Feldtyp.');
        h.type = a.hexType;
        if (h.type === 'sea' || h.type === 'desert') h.number = null;
        else if (h.number === null) h.number = 6;
        st.board.harbors = st.board.harbors.filter(hb => st.board.edges[hb.edge].hexes.some(x => st.board.hexes[x].type !== 'sea'));
        if (st.board.robber === h.id && h.type === 'sea') st.board.robber = null;
        if (st.board.pirate === h.id && h.type !== 'sea') st.board.pirate = null;
        computeIslands(st.board);
      }
      if (a.number !== undefined) {
        const n = a.number === null ? null : Number(a.number);
        if (n !== null && (n < 2 || n > 12 || n === 7)) fail('Ungültige Zahl.');
        if (h.type === 'sea' || h.type === 'desert') fail('Dieses Feld hat keine Zahl.');
        h.number = n;
      }
      break;
    }
    case 'vpTarget': {
      const n = Math.trunc(Number(a.value));
      if (!(n >= 3 && n <= 30)) fail('Ungültiges Siegpunktziel.');
      st.scenario.vpTarget = n;
      break;
    }
    case 'startAt': {
      const p = seatOK(Number(a.seat));
      // Heimatinseln aus der aktuellen Stellung ableiten, falls noch keine bekannt
      st.players.forEach(pl => {
        if (pl.homeIslands.length) return;
        for (const k in st.buildings) {
          if (st.buildings[k].owner !== pl.seat) continue;
          const isl = vertexIsland(st, Number(k));
          if (isl >= 0 && !pl.homeIslands.includes(isl) && !pl.bonusIslands.includes(isl)) pl.homeIslands.push(isl);
        }
      });
      st.phase = 'play';
      st.setup = null;
      st.winner = null;
      st.turn = p.seat;
      st.turnNumber = (st.turnNumber || 0) + 1;
      st.rolled = !!a.rolled;
      st.pending = [];
      st.trade = null;
      st.devPlayed = false;
      st.shipMoved = false;
      st.editor = false;
      updateSpecials(st);
      log(st, `▶️ Spiel wird von dieser Stellung fortgesetzt. ${p.name} ist am Zug.`);
      return;
    }
    default: fail('Unbekannte Editor-Aktion.');
  }
  updateSpecials(st);
}

// ---------------------------------------------------------------- Sicht für einen Spieler
function legalFor(st, seat) {
  const L = {};
  if (seat === null || seat === undefined || !st.players[seat] || st.phase === 'ended' || st.editor) return L;
  const p = st.players[seat];
  const pend = st.pending[0];
  if (pend) {
    if (pend.type === 'discard' && pend.need[seat]) L.discard = pend.need[seat];
    if (pend.type === 'gold' && pend.need[seat]) L.gold = pend.need[seat];
    if (pend.type === 'robber' && pend.seat === seat) L.robber = robberSpots(st);
    if (pend.type === 'steal' && pend.seat === seat) L.steal = pend.targets;
    if (pend.type === 'roadBuilding' && pend.seat === seat) {
      L.roadBuilding = pend.left;
      if (p.pieces.road > 0) L.road = roadSpots(st, seat);
      if (p.pieces.ship > 0) L.ship = shipSpots(st, seat);
    }
    return L;
  }
  if (st.phase === 'setup') {
    const s = st.setup;
    if (s.order[s.idx] !== seat) return L;
    if (s.step === 'settlement') L.settlement = settlementSpots(st, seat, true);
    else {
      L.road = roadSpots(st, seat, s.lastVertex);
      L.ship = shipSpots(st, seat, s.lastVertex);
    }
    L.setup = s.step;
    return L;
  }
  if (st.turn !== seat) return L;
  L.myTurn = true;
  if (!st.rolled) L.canRoll = true;
  if (!st.devPlayed) {
    L.playable = [...new Set(p.dev.filter(d => d.turn < st.turnNumber && d.type !== 'vp').map(d => d.type))];
  }
  if (st.rolled) {
    L.canEnd = true;
    if (p.pieces.settlement > 0) L.settlement = settlementSpots(st, seat, false);
    if (p.pieces.city > 0) L.city = citySpots(st, seat);
    if (p.pieces.road > 0) L.road = roadSpots(st, seat);
    if (p.pieces.ship > 0) L.ship = shipSpots(st, seat);
    if (st.scenario.seafarers && !st.shipMoved) L.movableShips = movableShips(st, seat);
  }
  return L;
}

function viewFor(st, seat) {
  const ended = st.phase === 'ended';
  return {
    scenario: st.scenario,
    board: st.board,
    players: st.players.map(p => ({
      seat: p.seat, name: p.name, color: p.color, bot: p.bot,
      knights: p.knights, pieces: p.pieces, bonusVP: p.bonusVP,
      cardCount: total(p.res), devCount: p.dev.length,
      res: p.seat === seat || ended || st.editor ? p.res : null,
      dev: p.seat === seat || ended || st.editor ? p.dev : null,
      vp: victoryPoints(st, p.seat, p.seat === seat || ended),
      roadLength: st.roadLengths[p.seat] || 0,
    })),
    buildings: st.buildings, roads: st.roads, ships: st.ships,
    bank: st.bank, devDeckCount: st.devDeck.length,
    phase: st.phase, setup: st.setup, turn: st.turn, turnNumber: st.turnNumber,
    rolled: st.rolled, dice: st.dice, pending: st.pending, devPlayed: st.devPlayed, shipMoved: st.shipMoved,
    trade: st.trade, longestRoad: st.longestRoad, largestArmy: st.largestArmy,
    log: st.log.slice(-120), winner: st.winner, editor: st.editor,
    you: seat,
    ratios: st.players[seat] ? tradeRatios(st, seat) : null,
    legal: legalFor(st, seat),
  };
}

// Geladenen Spielstand prüfen und in einen sauberen Zustand überführen.
// Es werden nur bekannte Felder mit geprüften Typen übernommen – eine manipulierte
// Datei kann so weder HTML einschleusen noch die Engine zum Absturz bringen.
const HEX_TYPES = ['sea', 'desert', 'gold', ...RES];
const NUMBERS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
const PENDING_TYPES = ['discard', 'gold', 'robber', 'steal', 'roadBuilding'];
function validateLoaded(raw) {
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  if (!isObj(raw) || !isObj(raw.board) || !Array.isArray(raw.players)) fail('Ungültige Spielstand-Datei.');
  const rb = raw.board;
  if (!Array.isArray(rb.hexes) || !Array.isArray(rb.vertices) || !Array.isArray(rb.edges)) fail('Ungültige Spielstand-Datei (Spielbrett).');
  const n = raw.players.length;
  if (n < 1 || n > 6) fail('Spielstand: 1–6 Spieler erforderlich.');
  const nh = rb.hexes.length, nv = rb.vertices.length, ne = rb.edges.length;
  if (!nh || nh > 1000 || nv > 3000 || ne > 4000) fail('Spielbrett hat eine ungültige Größe.');
  const int = (v, d = 0, min = -Infinity, max = Infinity) => {
    const x = Number(v);
    return Number.isInteger(x) && x >= min && x <= max ? x : d;
  };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const arr = (a) => (Array.isArray(a) ? a : []);
  const okH = (x) => Number.isInteger(x) && x >= 0 && x < nh;
  const okV = (x) => Number.isInteger(x) && x >= 0 && x < nv;
  const okE = (x) => Number.isInteger(x) && x >= 0 && x < ne;
  const okS = (x) => Number.isInteger(x) && x >= 0 && x < n;
  const ints = (a, ok) => arr(a).map(Number).filter(ok);
  const seatOrNull = (x) => (okS(x) ? x : null);

  const board = {
    hexes: rb.hexes.map((h, i) => {
      h = isObj(h) ? h : {};
      const hex = {
        id: i, q: int(h.q), r: int(h.r), x: num(h.x), y: num(h.y),
        type: HEX_TYPES.includes(h.type) ? h.type : 'sea',
        number: NUMBERS.includes(Number(h.number)) ? Number(h.number) : null,
        vertices: ints(h.vertices, okV), edges: ints(h.edges, okE),
      };
      if (hex.vertices.length !== 6 || hex.edges.length !== 6) fail('Spielbrett ist beschädigt.');
      if (hex.type === 'sea' || hex.type === 'desert') hex.number = null;
      return hex;
    }),
    vertices: rb.vertices.map((v, i) => {
      v = isObj(v) ? v : {};
      return { id: i, x: num(v.x), y: num(v.y), hexes: ints(v.hexes, okH), edges: ints(v.edges, okE), adj: ints(v.adj, okV) };
    }),
    edges: rb.edges.map((e, i) => {
      e = isObj(e) ? e : {};
      const ev = ints(e.v, okV);
      if (ev.length !== 2) fail('Spielbrett ist beschädigt.');
      return { id: i, v: ev, hexes: ints(e.hexes, okH) };
    }),
    harbors: arr(rb.harbors).filter(isObj)
      .map(h => ({ hex: Number(h.hex), edge: Number(h.edge), type: h.type === 'any' || RES.includes(h.type) ? h.type : null }))
      .filter(h => okH(h.hex) && okE(h.edge) && h.type),
    robber: okH(Number(rb.robber)) && rb.robber !== null ? Number(rb.robber) : null,
    pirate: okH(Number(rb.pirate)) && rb.pirate !== null ? Number(rb.pirate) : null,
  };
  computeIslands(board);

  const rs = isObj(raw.scenario) ? raw.scenario : {};
  const key = typeof rs.key === 'string' && SCENARIOS[rs.key] ? rs.key : 'classic';
  const scenario = {
    key, name: String(rs.name || SCENARIOS[key].name).replace(/[<>]/g, '').slice(0, 80),
    seafarers: !!rs.seafarers, islandBonus: int(rs.islandBonus, 0, 0, 5), vpTarget: int(rs.vpTarget, 10, 3, 30),
  };
  const res = (r) => { const o = emptyRes(); if (isObj(r)) RES.forEach(k => { o[k] = int(r[k], 0, 0, 999); }); return o; };

  const players = raw.players.map((p, i) => {
    p = isObj(p) ? p : {};
    const pc = isObj(p.pieces) ? p.pieces : {};
    return {
      seat: i,
      name: String(p.name || `Spieler ${i + 1}`).replace(/[<>]/g, '').trim().slice(0, 24) || `Spieler ${i + 1}`,
      color: /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : COLORS[i],
      bot: !!p.bot,
      res: res(p.res),
      dev: arr(p.dev).filter(d => isObj(d) && DEV_DE[d.type]).map(d => ({ type: d.type, turn: int(d.turn, 0, 0) })),
      knights: int(p.knights, 0, 0, 99),
      pieces: {
        road: int(pc.road, 15, 0, 15), settlement: int(pc.settlement, 5, 0, 5),
        city: int(pc.city, 4, 0, 4), ship: scenario.seafarers ? int(pc.ship, 15, 0, 15) : 0,
      },
      homeIslands: ints(p.homeIslands, x => Number.isInteger(x) && x >= 0),
      bonusIslands: ints(p.bonusIslands, x => Number.isInteger(x) && x >= 0),
      bonusVP: int(p.bonusVP, 0, 0, 30),
    };
  });

  const buildings = {}, roads = {}, ships = {};
  if (isObj(raw.buildings)) for (const k of Object.keys(raw.buildings)) {
    const b = raw.buildings[k], v = Number(k);
    if (okV(v) && isObj(b) && okS(b.owner) && (b.type === 'settlement' || b.type === 'city')) buildings[v] = { owner: b.owner, type: b.type };
  }
  if (isObj(raw.roads)) for (const k of Object.keys(raw.roads)) {
    const e = Number(k);
    if (okE(e) && okS(raw.roads[k])) roads[e] = raw.roads[k];
  }
  if (isObj(raw.ships)) for (const k of Object.keys(raw.ships)) {
    const e = Number(k), sh = raw.ships[k];
    if (okE(e) && isObj(sh) && okS(sh.owner) && roads[e] === undefined) ships[e] = { owner: sh.owner, turn: int(sh.turn, 0, 0) };
  }

  let phase = ['setup', 'play', 'ended'].includes(raw.phase) ? raw.phase : 'play';
  let setup = null;
  if (phase === 'setup' && isObj(raw.setup)) {
    const order = ints(raw.setup.order, okS);
    const idx = int(raw.setup.idx, 0, 0);
    if (order.length && idx < order.length) {
      setup = {
        order, idx, step: raw.setup.step === 'road' ? 'road' : 'settlement',
        lastVertex: okV(Number(raw.setup.lastVertex)) && raw.setup.lastVertex !== null ? Number(raw.setup.lastVertex) : null,
      };
      if (setup.step === 'road' && setup.lastVertex === null) setup.step = 'settlement';
    }
  }
  if (phase === 'setup' && !setup) phase = 'play';

  const pending = arr(raw.pending).filter(x => isObj(x) && PENDING_TYPES.includes(x.type)).map(x => {
    if (x.type === 'discard' || x.type === 'gold') {
      const need = {};
      if (isObj(x.need)) for (const k of Object.keys(x.need)) { const s2 = Number(k); const v = int(x.need[k], 0, 1, 99); if (okS(s2) && v) need[s2] = v; }
      return { type: x.type, need };
    }
    if (x.type === 'steal') return { type: 'steal', seat: int(x.seat, -1), targets: ints(x.targets, okS) };
    if (x.type === 'roadBuilding') return { type: 'roadBuilding', seat: int(x.seat, -1), left: int(x.left, 0, 0, 2) };
    return { type: 'robber', seat: int(x.seat, -1) };
  }).filter(x => (x.need ? Object.keys(x.need).length : okS(x.seat)) && (!x.targets || x.targets.length));

  const bank = res(raw.bank);
  const dice = Array.isArray(raw.dice) && raw.dice.length === 2 ? raw.dice.map(d => int(d, 1, 1, 6)) : null;
  const st = {
    version: 1, scenario, board, players, buildings, roads, ships, bank,
    devDeck: arr(raw.devDeck).filter(d => typeof d === 'string' && DEV_DE[d]),
    phase, setup,
    turn: int(raw.turn, 0, 0, n - 1), turnNumber: int(raw.turnNumber, 1, 0),
    rolled: !!raw.rolled, dice, pending,
    devPlayed: !!raw.devPlayed, shipMoved: !!raw.shipMoved, trade: null,
    longestRoad: seatOrNull(raw.longestRoad), largestArmy: seatOrNull(raw.largestArmy), roadLengths: players.map(() => 0),
    log: arr(raw.log).slice(-300).filter(isObj).map((l, i) => ({ n: int(l.n, i + 1, 0), t: String(l.t || '').slice(0, 300) })),
    logSeq: 0, winner: seatOrNull(raw.winner), editor: !!raw.editor,
  };
  st.logSeq = Math.max(int(raw.logSeq, 0, 0), ...st.log.map(l => l.n), 0);
  if (st.phase === 'ended' && st.winner === null) st.phase = 'play';
  updateSpecials(st);
  return st;
}

module.exports = {
  newGame, act, viewFor, legalFor, victoryPoints, validateLoaded, tradeRatios, longestRoute,
  settlementSpots, roadSpots, shipSpots, citySpots, movableShips, robberSpots,
  RES, RES_DE, COST, DEV_DE, COLORS, total, hasRes, emptyRes,
};
