'use strict';
// Spielfelder / Szenarien. Karten werden als ASCII-Raster in "odd-r"-Versatz beschrieben:
// ungerade Zeilen sind um ein halbes Feld nach rechts verschoben.
//   .  = kein Feld
//   ~  = Meer
//   H  = Meer mit Hafen (Typ zufällig aus dem Hafen-Pool)
//   L  = zufälliges Land (aus dem Rohstoff-Pool)
//   D  = Wüste, G = Goldfluss
//   w b s g o = festes Land: Wald(Holz), Lehm, Schafe(Wolle), Getreide, Erz

const SQ3 = Math.sqrt(3);
const RES = ['wood', 'brick', 'wool', 'grain', 'ore'];
const TOKEN_RES = { w: 'wood', b: 'brick', s: 'wool', g: 'grain', o: 'ore', D: 'desert', G: 'gold' };
// Verteilungsmuster, wiederholt sich für größere Karten (18er Block = Grundspiel-Verteilung)
const RES_PATTERN = ['wood', 'grain', 'wool', 'brick', 'ore', 'wood', 'grain', 'wool', 'brick', 'ore',
  'wood', 'grain', 'wool', 'wood', 'grain', 'wool', 'brick', 'ore'];
const NUM_PATTERN = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

const SCENARIOS = {
  classic: {
    name: 'Klassische Insel (2–4 Spieler)',
    minPlayers: 2, maxPlayers: 4, vp: 10, seafarers: false, islandBonus: 0, desert: 1,
    grid: [
      '. . H ~ H ~ .',
      '. ~ L L L H .',
      '. H L L L L ~',
      '~ L L L L L H',
      '. H L L L L ~',
      '. ~ L L L H .',
      '. . H ~ H ~ .',
    ],
  },
  classic56: {
    name: 'Große Insel (5–6 Spieler)',
    minPlayers: 3, maxPlayers: 6, vp: 10, seafarers: false, islandBonus: 0, desert: 2,
    grid: [
      '. . ~ H ~ H . .',
      '. H L L L ~ . .',
      '. ~ L L L L H .',
      'H L L L L L ~ .',
      '~ L L L L L L H',
      'H L L L L L ~ .',
      '. ~ L L L L H .',
      '. H L L L ~ . .',
      '. . ~ H ~ H . .',
    ],
  },
  archipel: {
    name: 'Seefahrt: Archipel (3–4 Spieler)',
    minPlayers: 2, maxPlayers: 4, vp: 13, seafarers: true, islandBonus: 2, desert: 1,
    grid: [
      '~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
      '~ H L L L H ~ L G ~',
      '~ L L L L L ~ ~ L ~',
      'H L L L L L H ~ ~ ~',
      '~ L L L L L ~ ~ L ~',
      '~ H L L L ~ ~ L L ~',
      '~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
      '~ L G ~ ~ L L ~ L ~',
      '~ ~ L ~ ~ ~ L ~ ~ ~',
      '~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
    ],
  },
  zweiufer: {
    name: 'Seefahrt: Zwei Ufer (3–4 Spieler)',
    minPlayers: 2, maxPlayers: 4, vp: 13, seafarers: true, islandBonus: 2, desert: 0,
    grid: [
      '~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
      '~ L L L ~ ~ ~ L L ~',
      'H L L L ~ G ~ L L ~',
      '~ L L L L ~ ~ L L H',
      'H L L L ~ ~ ~ L L ~',
      '~ L L L ~ G ~ L L ~',
      'H L L L ~ ~ L L L H',
      '~ L L L ~ ~ ~ L L ~',
      '~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
    ],
  },
  inselmeer: {
    name: 'Seefahrt: Inselmeer (5–6 Spieler)',
    minPlayers: 3, maxPlayers: 6, vp: 13, seafarers: true, islandBonus: 2, desert: 1,
    grid: [
      '~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
      '~ H L L L L H ~ ~ L G ~',
      '~ L L L L L L ~ ~ L ~ ~',
      'H L L L L L L H ~ ~ ~ ~',
      '~ L L L L L L L ~ ~ L ~',
      'H L L L L L L ~ ~ L L ~',
      '~ H L L L L H ~ ~ ~ ~ ~',
      '~ ~ ~ ~ ~ ~ ~ ~ L ~ ~ ~',
      '~ L G ~ ~ L L ~ L L ~ ~',
      '~ ~ L ~ ~ ~ L ~ ~ ~ G ~',
      '~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
    ],
  },
  zufall: {
    name: 'Seefahrt: Zufallsinseln (2–6 Spieler)',
    minPlayers: 2, maxPlayers: 6, vp: 13, seafarers: true, islandBonus: 2, desert: 0, // Wüste setzt der Generator selbst
    generator: 'islands',
  },
};

function shuffle(a, rng = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function offsetToAxial(col, row) {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

function parseGrid(grid) {
  const cells = [];
  grid.forEach((line, row) => {
    line.trim().split(/\s+/).forEach((tok, col) => {
      if (tok === '.') return;
      const { q, r } = offsetToAxial(col, row);
      cells.push({ q, r, token: tok });
    });
  });
  return cells;
}

// Zufällige Inselwelt erzeugen
function generateIslands(nPlayers, rng = Math.random) {
  const big = nPlayers > 4;
  const W = big ? 13 : 11, H = big ? 11 : 9;
  const mainSize = big ? 27 : 19;
  const small = big ? [4, 4, 3, 3, 4, 3] : [4, 3, 3, 4, 3];
  for (let attempt = 0; attempt < 200; attempt++) {
    const grid = new Map(); // key "q,r" -> token
    const key = (q, r) => q + ',' + r;
    const inner = [];
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const { q, r } = offsetToAxial(col, row);
        grid.set(key(q, r), '~');
        if (row > 0 && row < H - 1 && col > 0 && col < W - 1) inner.push({ q, r });
      }
    }
    const islandOf = new Map();
    const nb = (q, r) => DIRS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
    const isInner = (q, r) => inner.some(c => c.q === q && c.r === r);
    const touchesOther = (q, r, id) => nb(q, r).some(n => islandOf.has(key(n.q, n.r)) && islandOf.get(key(n.q, n.r)) !== id);
    let ok = true;
    const sizes = [mainSize, ...small];
    let placed = 0;
    sizes.forEach((size, id) => {
      if (!ok) return;
      // Startpunkt: Hauptinsel mittig-links, sonst zufällig mit Abstand
      let cands = inner.filter(c => !islandOf.has(key(c.q, c.r)) && !touchesOther(c.q, c.r, id));
      if (id === 0) {
        cands = cands.filter(c => {
          const col = c.q + (c.r - (c.r & 1)) / 2;
          return col >= 3 && col <= Math.floor(W / 2) && c.r >= 3 && c.r <= H - 4;
        });
      }
      if (!cands.length) { if (id === 0 || placed < 3) ok = false; return; }
      const start = cands[Math.floor(rng() * cands.length)];
      const cells = [start];
      islandOf.set(key(start.q, start.r), id);
      let guard = 0;
      while (cells.length < size && guard++ < 500) {
        const frontier = [];
        cells.forEach(c => nb(c.q, c.r).forEach(n => {
          const k = key(n.q, n.r);
          if (!islandOf.has(k) && isInner(n.q, n.r) && !touchesOther(n.q, n.r, id)) frontier.push(n);
        }));
        if (!frontier.length) break;
        // kompakte Inseln bevorzugen: Zellen mit mehr Nachbarn auf der Insel gewichten
        frontier.sort((a, b) => cnt(b) - cnt(a) + (rng() - 0.5) * 3);
        const pick = frontier[0];
        islandOf.set(key(pick.q, pick.r), id);
        cells.push(pick);
      }
      function cnt(c) { return nb(c.q, c.r).filter(n => islandOf.get(key(n.q, n.r)) === id).length; }
      if (id === 0 && cells.length < size - 2) ok = false;
      placed++;
    });
    if (placed < 4) ok = false;
    if (!ok) continue;
    for (const [k, id] of islandOf) grid.set(k, 'L');
    // Gold auf kleinen Inseln, Wüste auf der Hauptinsel
    const smallCells = [...islandOf].filter(([, id]) => id > 0).map(([k]) => k);
    shuffle(smallCells, rng).slice(0, big ? 3 : 2).forEach(k => grid.set(k, 'G'));
    const mainCells = [...islandOf].filter(([, id]) => id === 0).map(([k]) => k);
    grid.set(mainCells[Math.floor(rng() * mainCells.length)], 'D');
    // Häfen an der Küste der Hauptinsel
    const coast = [];
    for (const [k, t] of grid) {
      if (t !== '~') continue;
      const [q, r] = k.split(',').map(Number);
      if (nb(q, r).some(n => islandOf.get(key(n.q, n.r)) === 0)) coast.push(k);
    }
    shuffle(coast, rng);
    const harbors = [];
    for (const k of coast) {
      if (harbors.length >= (big ? 9 : 7)) break;
      const [q, r] = k.split(',').map(Number);
      if (harbors.some(h => nb(q, r).some(n => key(n.q, n.r) === h))) continue;
      harbors.push(k);
    }
    harbors.forEach(k => grid.set(k, 'H'));
    return [...grid].map(([k, token]) => {
      const [q, r] = k.split(',').map(Number);
      return { q, r, token };
    });
  }
  throw new Error('Inselgenerator fehlgeschlagen');
}

function hexCenter(q, r) {
  return { x: SQ3 * (q + r / 2), y: 1.5 * r };
}

// Baut die Geometrie (Felder, Ecken, Kanten) aus einer Zellliste.
function buildGeometry(cells) {
  const hexes = [], vertices = [], edges = [];
  const vIndex = new Map(), eIndex = new Map();
  cells.forEach((c, id) => {
    const { x, y } = hexCenter(c.q, c.r);
    const hex = { id, q: c.q, r: c.r, x, y, token: c.token, type: null, number: null, vertices: [], edges: [] };
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 180 * (60 * i - 30);
      const vx = x + Math.cos(ang), vy = y + Math.sin(ang);
      const k = Math.round(vx * 100) + ',' + Math.round(vy * 100);
      let vid = vIndex.get(k);
      if (vid === undefined) {
        vid = vertices.length;
        vIndex.set(k, vid);
        vertices.push({ id: vid, x: +vx.toFixed(4), y: +vy.toFixed(4), hexes: [], edges: [], adj: [] });
      }
      vertices[vid].hexes.push(id);
      hex.vertices.push(vid);
    }
    for (let i = 0; i < 6; i++) {
      const a = hex.vertices[i], b = hex.vertices[(i + 1) % 6];
      const k = Math.min(a, b) + '-' + Math.max(a, b);
      let eid = eIndex.get(k);
      if (eid === undefined) {
        eid = edges.length;
        eIndex.set(k, eid);
        edges.push({ id: eid, v: [a, b], hexes: [] });
        vertices[a].edges.push(eid); vertices[b].edges.push(eid);
        vertices[a].adj.push(b); vertices[b].adj.push(a);
      }
      edges[eid].hexes.push(id);
      hex.edges.push(eid);
    }
    hexes.push(hex);
  });
  return { hexes, vertices, edges };
}

function hexNeighbors(hexes) {
  const byKey = new Map(hexes.map(h => [h.q + ',' + h.r, h.id]));
  return hexes.map(h => DIRS.map(([dq, dr]) => byKey.get((h.q + dq) + ',' + (h.r + dr))).filter(x => x !== undefined));
}

function assignNumbers(hexes, rng) {
  const prod = hexes.filter(h => h.type !== 'sea' && h.type !== 'desert' && h.number === null);
  const neigh = hexNeighbors(hexes);
  const nums = [];
  for (let i = 0; i < prod.length; i++) nums.push(NUM_PATTERN[i % NUM_PATTERN.length]);
  for (let tries = 0; tries < 500; tries++) {
    shuffle(nums, rng);
    prod.forEach((h, i) => { h.number = nums[i]; });
    const bad = prod.some(h => (h.number === 6 || h.number === 8)
      && neigh[h.id].some(n => hexes[n].number === 6 || hexes[n].number === 8));
    if (!bad) return;
  }
}

function buildBoard(cells, sc, rng = Math.random) {
  const g = buildGeometry(cells);
  const { hexes, edges } = g;
  // Land verteilen
  const randomLand = hexes.filter(h => h.token === 'L');
  shuffle(randomLand, rng);
  const nDesert = Math.min(sc.desert || 0, randomLand.length);
  const pool = [];
  for (let i = 0; i < randomLand.length - nDesert; i++) pool.push(RES_PATTERN[i % RES_PATTERN.length]);
  for (let i = 0; i < nDesert; i++) pool.push('desert');
  shuffle(pool, rng);
  randomLand.forEach((h, i) => { h.type = pool[i]; });
  hexes.forEach(h => {
    if (h.token === '~' || h.token === 'H') h.type = 'sea';
    else if (TOKEN_RES[h.token]) h.type = TOKEN_RES[h.token];
    else if (!h.type) h.type = 'sea';
  });
  assignNumbers(hexes, rng);
  // Häfen
  const harborHexes = shuffle(hexes.filter(h => h.token === 'H'), rng);
  const n = harborHexes.length;
  const nRes = n >= 9 ? 5 : Math.min(5, Math.ceil(n * 5 / 9));
  const types = shuffle(RES.slice(), rng).slice(0, nRes);
  while (types.length < n) types.push('any');
  shuffle(types, rng);
  const harbors = [];
  const usedV = new Set();
  harborHexes.forEach((h, i) => {
    const cand = h.edges.filter(eid => edges[eid].hexes.some(x => hexes[x].type !== 'sea'));
    if (!cand.length) return;
    const free = cand.filter(eid => edges[eid].v.every(v => !usedV.has(v)));
    const list = free.length ? free : cand;
    const eid = list[Math.floor(rng() * list.length)];
    edges[eid].v.forEach(v => usedV.add(v));
    harbors.push({ hex: h.id, edge: eid, type: types[i] });
  });
  hexes.forEach(h => { delete h.token; });
  const board = { ...g, harbors, robber: null, pirate: null };
  computeIslands(board);
  const desert = hexes.find(h => h.type === 'desert');
  board.robber = desert ? desert.id : null;
  if (sc.seafarers) {
    const seas = hexes.filter(h => h.type === 'sea');
    const neigh = hexNeighbors(hexes);
    const open = seas.filter(h => neigh[h.id].every(nid => hexes[nid].type === 'sea') && neigh[h.id].length === 6);
    const list = open.length ? open : seas;
    board.pirate = list.length ? list[Math.floor(rng() * list.length)].id : null;
  }
  return board;
}

// Zusammenhängende Landflächen (Inseln) bestimmen
function computeIslands(board) {
  const { hexes } = board;
  const neigh = hexNeighbors(hexes);
  const islandOf = hexes.map(() => -1);
  let id = 0;
  hexes.forEach(h => {
    if (h.type === 'sea' || islandOf[h.id] !== -1) return;
    const stack = [h.id];
    islandOf[h.id] = id;
    while (stack.length) {
      const c = stack.pop();
      neigh[c].forEach(n => {
        if (hexes[n].type !== 'sea' && islandOf[n] === -1) { islandOf[n] = id; stack.push(n); }
      });
    }
    id++;
  });
  board.islandOf = islandOf;
  board.islandCount = id;
}

function buildScenario(key, nPlayers, rng = Math.random) {
  const sc = SCENARIOS[key];
  if (!sc) throw new Error('Unbekanntes Szenario: ' + key);
  const cells = sc.generator === 'islands' ? generateIslands(nPlayers, rng) : parseGrid(sc.grid);
  return buildBoard(cells, sc, rng);
}

function listScenarios() {
  return Object.entries(SCENARIOS).map(([key, s]) => ({
    key, name: s.name, minPlayers: s.minPlayers, maxPlayers: s.maxPlayers, vp: s.vp, seafarers: s.seafarers,
  }));
}

module.exports = { SCENARIOS, buildScenario, listScenarios, computeIslands, buildGeometry, shuffle, RES };
