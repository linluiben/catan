'use strict';
// Stellungscode: eine komplette Spielstellung als kurzer, kopierbarer Text.
//
// Statt des ganzen Zustands (inkl. Geometrie, ~60–100 KB) wird nur das Nötigste gespeichert:
// Feld-Koordinaten mit Typ/Zahl, Häfen, Figuren, Karten und der Zugstatus. Die Geometrie
// (Ecken/Kanten mit identischen IDs) wird beim Einlesen deterministisch neu berechnet.
// Das Ergebnis wird mit deflate komprimiert und base64url-kodiert: "IR1.<daten>".
//
// Läuft unverändert in Node (>= 18) und im Browser (Offline-Version), da nur Web-Standards
// (CompressionStream, TextEncoder, btoa/atob) benutzt werden.

const maps = require('./maps');
const G = require('./game');

const PREFIX = 'IR1.';
const HEX_T = ['sea', 'desert', 'gold', 'wood', 'brick', 'wool', 'grain', 'ore'];
const DEV_T = ['knight', 'vp', 'roadBuilding', 'yearOfPlenty', 'monopoly'];
const RES = maps.RES;
const MAX_CODE = 200 * 1024; // Zeichen
const MAX_JSON = 2 * 1024 * 1024; // Bytes nach dem Entpacken (Schutz vor "Zip-Bomben")

class CodeError extends Error {}
const bad = (msg) => { throw new CodeError(msg || 'Ungültiger Stellungscode.'); };

// ------------------------------------------------------------ Kodierung
function toB64url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  let bin;
  try { bin = atob(s); } catch { bad(); }
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
async function deflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(u8, limit) {
  const reader = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { reader.cancel().catch(() => {}); bad('Stellungscode ist zu groß.'); }
      chunks.push(value);
    }
  } catch (e) { if (e instanceof CodeError) throw e; bad(); }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ------------------------------------------------------------ Stellung -> kompaktes Objekt
function compact(st) {
  const tn = st.turnNumber;
  const entries = (o) => Object.keys(o).map(Number).sort((a, b) => a - b);
  return {
    v: 1,
    sc: [st.scenario.key, st.scenario.seafarers ? 1 : 0, st.scenario.islandBonus, st.scenario.vpTarget, st.scenario.name],
    h: st.board.hexes.map(h => [h.q, h.r, HEX_T.indexOf(h.type), h.number || 0]),
    hb: st.board.harbors.map(x => [x.hex, x.edge, x.type === 'any' ? 0 : 1 + RES.indexOf(x.type)]),
    rp: [st.board.robber === null ? -1 : st.board.robber, st.board.pirate === null ? -1 : st.board.pirate],
    p: st.players.map(p => [
      p.name, p.color, p.bot ? 1 : 0, RES.map(k => p.res[k]), p.knights, p.bonusVP,
      // Entwicklungskarte: Typ*2 + 1, falls in diesem Zug gekauft (dann noch nicht spielbar)
      p.dev.map(d => DEV_T.indexOf(d.type) * 2 + (d.turn >= tn ? 1 : 0)),
      p.homeIslands, p.bonusIslands,
    ]),
    b: entries(st.buildings).map(v => [v, st.buildings[v].owner, st.buildings[v].type === 'city' ? 1 : 0]),
    r: entries(st.roads).map(e => [e, st.roads[e]]),
    s: entries(st.ships).map(e => [e, st.ships[e].owner, st.ships[e].turn >= tn ? 1 : 0]),
    bk: RES.map(k => st.bank[k]),
    dk: DEV_T.map(t => st.devDeck.filter(d => d === t).length),
    g: {
      ph: st.phase, se: st.setup, t: st.turn, tn, ro: st.rolled ? 1 : 0, d: st.dice, pe: st.pending,
      dp: st.devPlayed ? 1 : 0, sm: st.shipMoved ? 1 : 0, lr: st.longestRoad, la: st.largestArmy, w: st.winner,
    },
  };
}

// ------------------------------------------------------------ kompaktes Objekt -> Stellung
function expand(c) {
  const arr = (a) => (Array.isArray(a) ? a : bad());
  if (!c || typeof c !== 'object' || c.v !== 1) bad('Unbekannte Code-Version.');
  const hexList = arr(c.h);
  if (!hexList.length || hexList.length > 1000) bad();
  const geo = maps.buildGeometry(hexList.map(h => ({ q: Number(arr(h)[0]) | 0, r: Number(h[1]) | 0, token: '~' })));
  hexList.forEach((h, i) => {
    const hex = geo.hexes[i];
    hex.type = HEX_T[h[2]] || 'sea';
    hex.number = Number(h[3]) || null;
    delete hex.token;
  });
  const sc = arr(c.sc);
  const g = c.g && typeof c.g === 'object' ? c.g : {};
  const tn = Number(g.tn) || 1;
  const board = {
    ...geo,
    harbors: arr(c.hb || []).map(x => ({ hex: Number(x[0]), edge: Number(x[1]), type: x[2] === 0 ? 'any' : RES[x[2] - 1] })),
    robber: arr(c.rp)[0] >= 0 ? Number(c.rp[0]) : null,
    pirate: c.rp[1] >= 0 ? Number(c.rp[1]) : null,
  };
  const seafarers = !!sc[1];
  const buildings = {}, roads = {}, ships = {};
  arr(c.b || []).forEach(x => { buildings[x[0]] = { owner: x[1], type: x[2] ? 'city' : 'settlement' }; });
  arr(c.r || []).forEach(x => { roads[x[0]] = x[1]; });
  arr(c.s || []).forEach(x => { ships[x[0]] = { owner: x[1], turn: x[2] ? tn : 0 }; });
  const players = arr(c.p).map((p, i) => {
    arr(p);
    const count = (pred) => Object.keys(buildings).filter(k => buildings[k].owner === i && pred(buildings[k])).length;
    const res = {};
    RES.forEach((k, j) => { res[k] = Number(arr(p[3])[j]) || 0; });
    return {
      name: p[0], color: p[1], bot: !!p[2], res, knights: p[4], bonusVP: p[5],
      dev: arr(p[6] || []).map(n => ({ type: DEV_T[Math.floor(n / 2)], turn: n % 2 ? tn : 0 })),
      homeIslands: p[7] || [], bonusIslands: p[8] || [],
      // Verbleibende Figuren ergeben sich aus den gebauten
      pieces: {
        settlement: 5 - count(b => b.type === 'settlement'),
        city: 4 - count(b => b.type === 'city'),
        road: 15 - Object.keys(roads).filter(k => roads[k] === i).length,
        ship: seafarers ? 15 - Object.keys(ships).filter(k => ships[k].owner === i).length : 0,
      },
    };
  });
  if (players.some(p => Object.values(p.pieces).some(n => n < 0))) bad('Zu viele Figuren im Code.');
  const bank = {};
  RES.forEach((k, j) => { bank[k] = Number(arr(c.bk)[j]) || 0; });
  const devDeck = [];
  DEV_T.forEach((t, j) => { for (let n = 0; n < Math.min(50, Number(arr(c.dk)[j]) || 0); n++) devDeck.push(t); });
  maps.shuffle(devDeck);
  const raw = {
    scenario: { key: sc[0], seafarers, islandBonus: sc[2], vpTarget: sc[3], name: sc[4] },
    board, players, buildings, roads, ships, bank, devDeck,
    phase: g.ph, setup: g.se, turn: g.t, turnNumber: tn, rolled: !!g.ro, dice: g.d, pending: g.pe,
    devPlayed: !!g.dp, shipMoved: !!g.sm, longestRoad: g.lr, largestArmy: g.la, winner: g.w,
    log: [], logSeq: 0, editor: false,
  };
  // Dieselbe strenge Prüfung wie beim Laden einer Datei
  const st = G.validateLoaded(raw);
  st.log.push({ n: ++st.logSeq, t: '📋 Stellung aus Code geladen.' });
  return st;
}

// ------------------------------------------------------------ öffentliche API
async function encode(st) {
  const json = JSON.stringify(compact(st));
  return PREFIX + toB64url(await deflate(new TextEncoder().encode(json)));
}

// Akzeptiert den reinen Code, Code mit Zeilenumbrüchen (Messenger) oder einen Link mit #pos=...
async function decode(input) {
  let s = String(input || '');
  if (s.length > MAX_CODE * 2) bad('Stellungscode ist zu lang.');
  const m = s.match(/[#&?]pos=([^&\s]+)/);
  if (m) s = decodeURIComponent(m[1]);
  s = s.replace(/\s+/g, '');
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (!s || s.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(s)) bad();
  const json = new TextDecoder().decode(await inflate(fromB64url(s), MAX_JSON));
  let obj;
  try { obj = JSON.parse(json); } catch { bad(); }
  try { return expand(obj); } catch (e) {
    if (e instanceof CodeError) throw e;
    bad(e && e.message && /Spiel|Figuren|Brett/.test(e.message) ? e.message : undefined);
  }
}

module.exports = { encode, decode, CodeError, PREFIX };
