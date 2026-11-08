'use strict';
/* Inselreich – Browser-Client */

const RES = ['wood', 'brick', 'wool', 'grain', 'ore'];
const RES_DE = { wood: 'Holz', brick: 'Lehm', wool: 'Wolle', grain: 'Getreide', ore: 'Erz' };
const EMOJI = { wood: '🌲', brick: '🧱', wool: '🐑', grain: '🌾', ore: '⛰️', desert: '🏜️', gold: '💰', sea: '' };
const HEX_COLOR = { wood: '#2f7d3a', brick: '#c4643a', wool: '#97c95c', grain: '#e9c23f', ore: '#8b97a8', desert: '#e1d1a1', gold: '#ffd34d', sea: '#2f6fb5' };
const HEX_DE = { wood: 'Wald', brick: 'Lehmgrube', wool: 'Weide', grain: 'Acker', ore: 'Gebirge', desert: 'Wüste', gold: 'Goldfluss', sea: 'Meer' };
const COST = {
  road: { wood: 1, brick: 1 }, ship: { wood: 1, wool: 1 },
  settlement: { wood: 1, brick: 1, wool: 1, grain: 1 }, city: { grain: 2, ore: 3 }, dev: { wool: 1, grain: 1, ore: 1 },
};
const DEV_DE = { knight: 'Ritter', vp: 'Siegpunkt', roadBuilding: 'Straßenbau', yearOfPlenty: 'Erfindung', monopoly: 'Monopol' };
const DEV_EMOJI = { knight: '⚔️', vp: '⭐', roadBuilding: '🛤️', yearOfPlenty: '🎁', monopoly: '💹' };
const DEV_HELP = {
  knight: 'Räuber/Pirat versetzen und eine Karte ziehen. Zählt für die größte Rittermacht.',
  vp: 'Zählt einen Siegpunkt (verdeckt).',
  roadBuilding: 'Baue 2 Straßen/Schiffe kostenlos.',
  yearOfPlenty: 'Nimm 2 beliebige Rohstoffe aus der Bank.',
  monopoly: 'Alle anderen geben dir alle Karten eines Rohstoffs.',
};
const COLORS = ['#d63031', '#0984e3', '#f39c12', '#ecf0f1', '#00b894', '#8e44ad'];
const SC = 52; // Pixel pro Einheit

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const costText = (c) => RES.filter(k => c[k]).map(k => (c[k] > 1 ? c[k] : '') + EMOJI[k]).join(' ');
const hasRes = (r, c) => r && RES.every(k => (r[k] || 0) >= (c[k] || 0));
const sumRes = (r) => RES.reduce((s, k) => s + (r[k] || 0), 0);
const zero = () => ({ wood: 0, brick: 0, wool: 0, grain: 0, ore: 0 });

const S = {
  ws: null, queue: [], info: null, room: null, game: null, roomId: null,
  mode: null, moveFrom: null, edgeKind: 'road', picker: {}, tradeOpen: false, devChoice: null,
  bankGive: null, bankGet: null,
  editor: { tool: 'settlement', owner: 0, hexType: 'wood', number: 6, harbor: 'any', dev: 'knight', startSeat: 0, rolled: false },
  chatSeen: 0, tab: 'log', lastLogN: 0,
};

let tokens = {};
try { tokens = JSON.parse(localStorage.getItem('inselreich_tokens') || '{}'); } catch { tokens = {}; }
const saveTokens = () => { try { localStorage.setItem('inselreich_tokens', JSON.stringify(tokens)); } catch { /* */ } };
const getName = () => $('nameInput').value.trim();
const getPw = () => $('pwInput').value;

// ------------------------------------------------------------------ Verbindung
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Offline-Version (GitHub Pages): "Server" läuft im Browser
  const ws = window.LocalServer ? window.LocalServer.socket()
    : new WebSocket(`${proto}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`);
  S.ws = ws;
  ws.onopen = () => {
    if (S.roomId && tokens[S.roomId]) ws.send(JSON.stringify({ t: 'join', room: S.roomId, token: tokens[S.roomId], password: getPw() }));
    S.queue.splice(0).forEach(m => ws.send(JSON.stringify(m)));
  };
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => { S.board = null; setTimeout(connect, 1500); };
}
function send(m) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m));
  else S.queue.push(m);
}
function act(action) { send({ t: 'action', action }); }

function onMsg(m) {
  switch (m.t) {
    case 'joined':
      S.roomId = m.room;
      if (m.token) { tokens[m.room] = m.token; saveTokens(); }
      history.replaceState(null, '', '?room=' + m.room);
      showScreen('room');
      break;
    case 'room':
      // Das Brett schickt der Server nur, wenn es sich geändert hat
      if (m.board) S.board = m.board;
      if (m.game) { if (m.game.board) S.board = m.game.board; else m.game.board = S.board; }
      S.room = m.room;
      S.game = m.game;
      renderAll();
      break;
    case 'error':
      toast(m.msg);
      if (!S.room && S.roomId) { delete tokens[S.roomId]; saveTokens(); S.roomId = null; showScreen('lobby'); }
      break;
    case 'export': download(m.state, m.name); break;
    case 'positionCode': showCodeOverlay(m.code); break;
    case 'kicked':
      toast(m.msg || 'Du wurdest aus dem Raum entfernt.');
      leaveToLobby();
      break;
    case 'left': leaveToLobby(); break;
  }
}

function leaveToLobby() {
  if (S.roomId) { delete tokens[S.roomId]; saveTokens(); }
  S.roomId = null; S.room = null; S.game = null;
  history.replaceState(null, '', location.pathname);
  showScreen('lobby');
  loadRooms();
}

function showScreen(which) {
  $('lobby').hidden = which !== 'lobby';
  $('roomScreen').hidden = which !== 'room';
}

let toastTimer;
function toast(msg, info) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (info ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}

function copyText(text, okMsg) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) toast(okMsg, true); else prompt('Zum Kopieren markieren (Strg+C):', text);
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast(okMsg, true), fallback);
  else fallback();
}

function showCodeOverlay(code) {
  const link = location.origin + location.pathname + '#pos=' + code;
  $('overlayBox').innerHTML = `<h2>📋 Stellungscode</h2>
    <p class="hint">Dieser Code enthält die komplette aktuelle Stellung inklusive <strong>aller Handkarten</strong>. Jeder kann daraus auf der Startseite ein neues Spiel erstellen, auch in der Offline-Version.</p>
    <textarea class="code-box" readonly id="codeOut">${esc(code)}</textarea>
    <div class="hint">${code.length} Zeichen</div>
    <div class="btns row"><button class="primary" data-copy="code">Code kopieren</button><button data-copy="link">Link kopieren</button></div>
    ${isHost() ? `<div class="section-title" style="margin-top:14px">Andere Stellung in diesen Raum laden</div>
    <textarea id="codeIn" rows="3" placeholder="IR1.… einfügen" spellcheck="false"></textarea>
    <div class="btns row"><button data-loadcode>Laden (ersetzt das laufende Spiel)</button></div>` : ''}
    <div class="btns row" style="margin-top:10px"><button data-close>Schließen</button></div>`;
  $('overlay').hidden = false;
  $('overlayBox').querySelector('[data-copy="code"]').onclick = () => copyText(code, 'Stellungscode kopiert.');
  $('overlayBox').querySelector('[data-copy="link"]').onclick = () => copyText(link, 'Link kopiert – wer ihn öffnet, kann die Stellung direkt starten.');
  const lc = $('overlayBox').querySelector('[data-loadcode]');
  if (lc) lc.onclick = () => {
    const c = $('codeIn').value.trim();
    if (!c) return toast('Bitte einen Code einfügen.');
    if (!confirm('Stellung laden? Das laufende Spiel wird ersetzt.')) return;
    send({ t: 'load', code: c });
    $('overlay').hidden = true;
  };
  $('codeOut').onclick = (e) => e.target.select();
}

function download(state, name) {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `inselreich-${(name || 'spiel').replace(/[^\w-]+/g, '_')}-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function readJsonFile(input, cb) {
  const f = input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { cb(JSON.parse(r.result)); } catch { toast('Die Datei ist kein gültiger Spielstand.'); }
    input.value = '';
  };
  r.readAsText(f);
}

// ------------------------------------------------------------------ Lobby
async function loadInfo() {
  try {
    S.info = window.LocalServer ? window.LocalServer.info() : await (await fetch('api/info')).json();
    if (S.info.local) {
      document.querySelectorAll('.online-only').forEach(el => { el.hidden = true; });
      document.querySelectorAll('.local-only').forEach(el => { el.hidden = false; });
    }
    $('scenarioSelect').innerHTML = S.info.scenarios.map(s => `<option value="${s.key}">${esc(s.name)} – ${s.vp} SP</option>`).join('');
    $('pwRow').hidden = !S.info.passwordRequired;
  } catch { /* offline */ }
}
async function loadRooms() {
  try {
    if (S.info && S.info.roomList === false) {
      $('roomList').innerHTML = '<li class="hint">Die Raumliste ist auf diesem Server ausgeblendet. Lass dir den Raum-Code oder Einladungslink geben.</li>';
      return;
    }
    const list = window.LocalServer ? window.LocalServer.rooms()
      : await (await fetch('api/rooms', { headers: { 'X-Server-Password': getPw() } })).json();
    $('roomList').innerHTML = list.length ? list.map(r => `
      <li><div><strong>${esc(r.name)}</strong> <span class="code">${r.id}</span>
      <small>${esc(r.scenario)} · ${r.players.map(esc).join(', ') || '–'} · ${r.ended ? 'beendet' : r.started ? 'läuft' : 'wartet'}</small></div>
      <button data-join="${r.id}" class="small">${r.started ? 'Öffnen' : 'Beitreten'}</button></li>`).join('')
      : `<li class="hint">${window.LocalServer ? 'Noch kein lokales Spiel gespeichert – starte rechts ein neues!' : 'Noch keine Räume – erstelle einen!'}</li>`;
  } catch { $('roomList').innerHTML = '<li class="hint">Raumliste nicht verfügbar.</li>'; }
}
function requireName() {
  const n = getName();
  if (!n) { toast('Bitte gib zuerst deinen Namen ein.'); $('nameInput').focus(); return null; }
  try { localStorage.setItem('inselreich_name', n); } catch { /* */ }
  return n;
}
function joinRoom(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return toast('Bitte Raum-Code eingeben.');
  if (tokens[code]) return send({ t: 'join', room: code, token: tokens[code], password: getPw(), name: getName() });
  const name = requireName();
  if (!name) return;
  send({ t: 'join', room: code, name, password: getPw() });
}

$('createBtn').onclick = () => {
  const name = requireName();
  if (!name) return;
  send({ t: 'create', name, password: getPw(), roomName: $('roomNameInput').value, scenario: $('scenarioSelect').value, vpTarget: Number($('vpInput').value) || undefined });
};
$('joinBtn').onclick = () => joinRoom($('codeInput').value);
$('createFromCodeBtn').onclick = () => {
  const code = $('posCodeInput').value.trim();
  if (!code) { toast('Bitte zuerst einen Stellungscode einfügen.'); $('posCodeInput').focus(); return; }
  const name = requireName();
  if (!name) return;
  send({ t: 'create', name, password: getPw(), roomName: $('roomNameInput').value || 'Stellung aus Code', code });
};
$('codeInput').onkeydown = (e) => { if (e.key === 'Enter') joinRoom($('codeInput').value); };
$('refreshBtn').onclick = loadRooms;
$('pwInput').onchange = loadRooms;
$('roomList').onclick = (e) => { const b = e.target.closest('[data-join]'); if (b) joinRoom(b.dataset.join); };
$('loadFile').onchange = (e) => readJsonFile(e.target, (state) => {
  const name = requireName();
  if (!name) return;
  send({ t: 'create', name, password: getPw(), roomName: $('roomNameInput').value || 'Geladenes Spiel', state });
});
$('loadFile2').onchange = (e) => readJsonFile(e.target, (state) => {
  if (confirm('Spielstand in diesen Raum laden? Das laufende Spiel wird ersetzt.')) send({ t: 'load', state });
});

// ------------------------------------------------------------------ Raum: Topbar
$('leaveBtn').onclick = () => { if (confirm('Raum verlassen? (Du kannst später mit dem Raum-Code wieder beitreten.)')) { send({ t: 'leave' }); } };
$('roomCode').onclick = () => {
  const url = location.origin + location.pathname + '?room=' + S.roomId;
  navigator.clipboard?.writeText(url).then(() => toast('Einladungslink kopiert: ' + url, true), () => prompt('Einladungslink:', url));
};
$('exportBtn').onclick = () => send({ t: 'export' });
$('codeBtn').onclick = () => send({ t: 'positionCode' });
$('editorBtn').onclick = () => act({ type: 'edit', op: 'toggle' });
$('helpBtn').onclick = showHelp;
$('overlay').onclick = (e) => {
  const opaque = $('overlay').classList.contains('opaque');
  if ((e.target.id === 'overlay' && !opaque) || e.target.dataset.close !== undefined) { $('overlay').hidden = true; $('overlay').classList.remove('opaque'); }
};
document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    $('log').hidden = S.tab !== 'log';
    $('chat').hidden = S.tab !== 'chat';
    if (S.tab === 'chat') { S.chatSeen = (S.room?.chat || []).length; $('chatBadge').textContent = ''; }
  };
});
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const t = $('chatInput').value.trim();
  if (t) send({ t: 'chat', text: t });
  $('chatInput').value = '';
};

const isHost = () => !!(S.room && S.room.host);
const pname = (seat) => {
  const g = S.game;
  if (seat === null || seat === undefined || !g) return '?';
  return seat === g.you ? 'Du' : esc(g.players[seat].name);
};

// ------------------------------------------------------------------ Rendering
function renderAll() {
  const r = S.room, g = S.game;
  if (!r) return;
  if (r.local && g && g.phase !== 'ended' && r.seats.filter(s => !s.bot).length > 1 && S.lastYou !== undefined && r.you !== S.lastYou && r.you !== null) {
    // Pass-and-Play: Gerät weitergeben, bevor die Karten des nächsten Spielers sichtbar werden
    const offer = r.viewReason === 'trade' && g.trade ? g.trade : null;
    $('overlayBox').innerHTML = `<h2>👉 Weitergeben an ${esc(r.seats[r.you].name)}</h2>
      <p>${offer ? `🤝 <strong>${esc(g.players[offer.from].name)}</strong> bietet einen Handel an: ${costText(offer.give)} gegen ${costText(offer.get)}. Jetzt entscheidet ${esc(r.seats[r.you].name)}: annehmen oder ablehnen.`
        : `${esc(r.seats[r.you].name)} ist jetzt dran.`} Erst aufdecken, wenn nur diese Person auf den Bildschirm schaut.</p>
      <button data-close class="primary">Ich bin ${esc(r.seats[r.you].name)} – aufdecken</button>`;
    $('overlay').hidden = false;
    $('overlay').classList.add('opaque');
  }
  S.lastYou = r.you;
  $('roomTitle').textContent = r.name;
  $('roomCode').textContent = r.id;
  $('roomCode').hidden = !!r.local;
  $('editorBtn').hidden = !(isHost() && g);
  $('editorBtn').classList.toggle('active', !!(g && g.editor));
  $('exportBtn').hidden = !(g && (isHost() || g.phase === 'ended'));
  $('codeBtn').hidden = !(g && (isHost() || g.phase === 'ended'));
  $('loadInGame').hidden = !isHost();
  $('waiting').hidden = !!g;
  if (!g || g.editor || !(g.legal || {}).myTurn) { if (S.mode && !(g && g.editor)) S.mode = null; }
  if (!g) {
    $('statusLine').textContent = 'Warteraum';
    renderWaiting();
    $('board').innerHTML = '';
    $('players').innerHTML = ''; $('panel').innerHTML = ''; $('hand').innerHTML = ''; $('dice').innerHTML = '';
  } else {
    $('statusLine').innerHTML = statusText(g);
    renderBoard();
    renderPlayers();
    renderPanel();
    renderHand();
    renderDice();
    renderLog();
  }
  renderChat();
}

function statusText(g) {
  if (g.phase === 'ended') return `🏆 ${pname(g.winner)} ${g.winner === g.you ? 'hast' : 'hat'} gewonnen!`;
  if (g.editor) return '✏️ Editor – Stellung wird bearbeitet';
  const pend = g.pending[0];
  if (pend) {
    if (pend.type === 'discard') return `Räuber! Abwerfen: ${Object.keys(pend.need).map(s => pname(Number(s))).join(', ')}`;
    if (pend.type === 'gold') return `Goldfluss: ${Object.keys(pend.need).map(s => pname(Number(s))).join(', ')} ${Object.keys(pend.need).length > 1 ? 'wählen' : 'wählt'} Rohstoffe`;
    if (pend.type === 'robber') return `${pname(pend.seat)}: Räuber${g.scenario.seafarers ? ' oder Pirat' : ''} versetzen`;
    if (pend.type === 'steal') return `${pname(pend.seat)}: Karte ziehen`;
    if (pend.type === 'roadBuilding') return `${pname(pend.seat)}: Straßenbau (${pend.left} übrig)`;
  }
  if (g.phase === 'setup') {
    const cur = g.setup.order[g.setup.idx];
    const round = g.setup.idx < g.players.length ? 1 : 2;
    return `Gründung (Runde ${round}): ${pname(cur)} – ${g.setup.step === 'settlement' ? 'Siedlung setzen' : (g.scenario.seafarers ? 'Straße oder Schiff setzen' : 'Straße setzen')}`;
  }
  return `${pname(g.turn)} ${g.turn === g.you ? 'bist' : 'ist'} am Zug${g.rolled ? '' : ' – würfeln'}`;
}

function renderWaiting() {
  const r = S.room;
  const host = isHost();
  const sc = S.info ? S.info.scenarios : [];
  const cur = sc.find(s => s.key === r.options.scenario);
  const url = location.origin + location.pathname + '?room=' + r.id;
  let h = `<div class="wait-box"><h2>Warteraum „${esc(r.name)}“</h2>
    ${r.local ? '<p class="hint">Offline-Modus: Alle spielen an diesem Gerät (abwechselnd) oder gegen Bots. Der Spielstand bleibt in diesem Browser gespeichert.</p>'
    : `<p class="hint">Lade Mitspieler ein: Raum-Code <span class="code">${r.id}</span> oder Link<br><code>${esc(url)}</code></p>`}
    <div class="section-title">Spieler (${r.seats.length}/6)</div>`;
  r.seats.forEach((s, i) => {
    h += `<div class="seat-row"><span class="swatch" style="background:${s.color}"></span>
      <span class="nm">${esc(s.name)}${i === r.you ? ' (du)' : ''}${s.online ? '' : ' <span class="hint">offline</span>'}</span>`;
    if (host || i === r.you) {
      h += `<span class="swatches">${COLORS.map(c => `<span class="swatch" data-a="color" data-seat="${i}" data-color="${c}" style="background:${c}"></span>`).join('')}</span>`;
    }
    if (host && i !== r.you) h += `<button class="small ghost" data-a="kick" data-seat="${i}" title="Entfernen">✖</button>`;
    h += '</div>';
  });
  if (host) {
    h += `<div class="btns row" style="margin-top:8px"><button data-a="addBot" ${r.seats.length >= 6 ? 'disabled' : ''}>🤖 Bot hinzufügen</button>
      ${r.local ? `<button data-a="addHuman" ${r.seats.length >= 6 ? 'disabled' : ''}>👤 Mitspieler an diesem Gerät</button>` : ''}</div>
      <label>Spielfeld <select id="optScenario">${sc.map(s => `<option value="${s.key}" ${s.key === r.options.scenario ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label>Siegpunkte <input id="optVp" type="number" min="3" max="30" value="${r.options.vpTarget}"></label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="optKeepOrder" style="width:auto;display:inline"> Sitzreihenfolge beibehalten (sonst zufällig)</label>
      <button class="primary" data-a="start" style="width:100%;margin-top:6px" ${cur && r.seats.length > cur.maxPlayers ? 'disabled' : ''}>Spiel starten</button>
      ${cur && r.seats.length > cur.maxPlayers ? `<p class="hint">Dieses Spielfeld ist für max. ${cur.maxPlayers} Spieler.</p>` : ''}
      <p class="hint">Tipp: Um von einer bestimmten Stellung zu starten, starte das Spiel und öffne dann den ✏️ Editor – oder lade oben mit 📂 einen gespeicherten Spielstand.</p>
      <button class="small danger" data-a="deleteRoom">Raum löschen</button>`;
  } else {
    h += `<p>Spielfeld: <strong>${esc(cur ? cur.name : r.options.scenario)}</strong>, Ziel: <strong>${r.options.vpTarget}</strong> Siegpunkte</p>
      <p class="hint">Warte, bis der Gastgeber das Spiel startet…</p>`;
  }
  h += '</div>';
  $('waiting').innerHTML = h;
  const os = $('optScenario');
  if (os) {
    os.onchange = () => send({ t: 'options', scenario: os.value });
    $('optVp').onchange = () => send({ t: 'options', vpTarget: Number($('optVp').value) });
  }
}

$('waiting').onclick = (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  if (a === 'addBot') send({ t: 'addBot' });
  if (a === 'addHuman') { const n = prompt('Name des Mitspielers:'); if (n !== null) send({ t: 'addHuman', name: n }); }
  if (a === 'kick') send({ t: 'kick', seat: Number(b.dataset.seat) });
  if (a === 'color') {
    if (isHost()) send({ t: 'color', seat: Number(b.dataset.seat), color: b.dataset.color });
    else toast('Nur der Gastgeber kann Farben ändern.');
  }
  if (a === 'start') send({ t: 'start', keepOrder: $('optKeepOrder')?.checked });
  if (a === 'deleteRoom' && confirm('Raum wirklich löschen?')) send({ t: 'deleteRoom' });
};

// ------------------------------------------------------------------ Spielbrett
function isLand(g, h) { return g.board.hexes[h].type !== 'sea'; }
function vertexLand(g, v) { return g.board.vertices[v].hexes.some(h => isLand(g, h)); }
function edgeRoadOK(g, e) { return g.board.edges[e].hexes.some(h => isLand(g, h)); }
function edgeShipOK(g, e) { return g.scenario.seafarers && g.board.edges[e].hexes.some(h => !isLand(g, h)); }
function freeShipEdges(g) {
  return g.board.edges.filter(e => edgeShipOK(g, e.id) && g.roads[e.id] === undefined && g.ships[e.id] === undefined
    && !(g.board.pirate !== null && e.hexes.includes(g.board.pirate))).map(e => e.id);
}

function interactions(g) {
  const L = g.legal || {};
  const r = { vertices: [], edges: [], edgeClass: '', hexes: [], onV: null, onE: null, onH: null, edit: false };
  if (g.editor) { if (isHost()) editorInteractions(g, r); return r; }
  if (L.robber) { r.hexes = L.robber; r.onH = (h) => act({ type: 'moveRobber', hex: h }); return r; }
  if (L.setup === 'settlement') { r.vertices = L.settlement; r.onV = (v) => act({ type: 'build', what: 'settlement', id: v }); return r; }
  if (L.setup === 'road' || L.roadBuilding !== undefined) {
    let kind = S.edgeKind;
    if (!(L[kind] || []).length) kind = (L.road || []).length ? 'road' : 'ship';
    r.edges = L[kind] || []; r.edgeClass = kind;
    r.onE = (e) => act({ type: 'build', what: kind, id: e });
    return r;
  }
  const m = S.mode;
  if (m === 'settlement' || m === 'city') {
    r.vertices = L[m] || [];
    r.onV = (v) => { S.mode = null; act({ type: 'build', what: m, id: v }); };
  } else if (m === 'road' || m === 'ship') {
    r.edges = L[m] || []; r.edgeClass = m;
    r.onE = (e) => { S.mode = null; act({ type: 'build', what: m, id: e }); };
  } else if (m === 'moveFrom') {
    r.edges = L.movableShips || []; r.edgeClass = 'ship';
    r.onE = (e) => { S.moveFrom = e; S.mode = 'moveTo'; renderAll(); };
  } else if (m === 'moveTo') {
    r.edges = freeShipEdges(g); r.edgeClass = 'ship';
    r.onE = (e) => { S.mode = null; act({ type: 'moveShip', from: S.moveFrom, to: e }); };
  }
  return r;
}

function editorInteractions(g, r) {
  const E = S.editor;
  r.edit = true;
  const place = (what) => (id) => act({ type: 'edit', op: 'place', what, id, owner: E.owner });
  switch (E.tool) {
    case 'settlement': case 'city':
      r.vertices = g.board.vertices.filter(v => vertexLand(g, v.id)).map(v => v.id);
      r.onV = place(E.tool); break;
    case 'road':
      r.edges = g.board.edges.filter(e => edgeRoadOK(g, e.id)).map(e => e.id);
      r.onE = place('road'); break;
    case 'ship':
      r.edges = g.board.edges.filter(e => edgeShipOK(g, e.id)).map(e => e.id);
      r.onE = place('ship'); break;
    case 'remove':
      r.vertices = Object.keys(g.buildings).map(Number);
      r.edges = [...Object.keys(g.roads), ...Object.keys(g.ships)].map(Number);
      r.onV = (id) => act({ type: 'edit', op: 'remove', kind: 'vertex', id });
      r.onE = (id) => act({ type: 'edit', op: 'remove', kind: 'edge', id });
      break;
    case 'robber':
      r.hexes = g.board.hexes.map(h => h.id);
      r.onH = (hex) => act({ type: 'edit', op: 'robber', hex }); break;
    case 'hexType':
      r.hexes = g.board.hexes.map(h => h.id);
      r.onH = (hex) => act({ type: 'edit', op: 'hex', hex, hexType: E.hexType }); break;
    case 'number':
      r.hexes = g.board.hexes.filter(h => h.type !== 'sea' && h.type !== 'desert').map(h => h.id);
      r.onH = (hex) => act({ type: 'edit', op: 'hex', hex, number: E.number }); break;
    case 'harbor':
      // Küstenkanten: genau ein Meer- und ein Landfeld
      r.edges = g.board.edges.filter(e => e.hexes.some(h => isLand(g, h)) && e.hexes.some(h => !isLand(g, h))).map(e => e.id);
      r.onE = (edge) => act({ type: 'edit', op: 'harbor', edge, harborType: E.harbor === 'none' ? null : E.harbor }); break;
  }
}

let currentInteractions = null;

function renderBoard() {
  const g = S.game;
  const b = g.board;
  const P = (o) => [o.x * SC, o.y * SC];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  b.vertices.forEach(v => { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); });
  const pad = 0.4;
  $('board').setAttribute('viewBox', `${(minX - pad) * SC} ${(minY - pad) * SC} ${(maxX - minX + 2 * pad) * SC} ${(maxY - minY + 2 * pad) * SC}`);
  const I = interactions(g);
  currentInteractions = I;
  const hexSet = new Set(I.hexes), vSet = new Set(I.vertices), eSet = new Set(I.edges);
  const color = (s) => g.players[s] ? g.players[s].color : '#888';
  const out = [];
  out.push(`<defs><radialGradient id="seaGrad" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="#3b82c9"/><stop offset="100%" stop-color="#2a63a3"/></radialGradient>
    <pattern id="goldPat" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="10" height="10" fill="#ffd34d"/><rect width="4" height="10" fill="#f6b93b"/></pattern></defs>`);
  // Felder
  for (const h of b.hexes) {
    const pts = h.vertices.map(v => P(b.vertices[v]).map(n => n.toFixed(1)).join(',')).join(' ');
    const fill = h.type === 'sea' ? 'url(#seaGrad)' : h.type === 'gold' ? 'url(#goldPat)' : HEX_COLOR[h.type];
    out.push(`<polygon class="hex ${h.type === 'sea' ? 'sea' : ''}" points="${pts}" fill="${fill}"><title>${HEX_DE[h.type]}${h.number ? ' ' + h.number : ''}</title></polygon>`);
    const [cx, cy] = P(h);
    if (h.type !== 'sea') {
      out.push(`<text class="hex-emoji" x="${cx}" y="${cy - (h.number ? 26 : 0)}">${EMOJI[h.type]}</text>`);
    }
    if (h.number) {
      const hot = h.number === 6 || h.number === 8;
      out.push(`<circle class="num" cx="${cx}" cy="${cy + 4}" r="16"/>`);
      out.push(`<text class="num-text ${hot ? 'hot' : ''}" x="${cx}" y="${cy + 1}">${h.number}</text>`);
      const dots = 6 - Math.abs(7 - h.number);
      for (let i = 0; i < dots; i++) out.push(`<circle class="pips ${hot ? 'hot' : ''}" cx="${cx + (i - (dots - 1) / 2) * 4.2}" cy="${cy + 13}" r="1.5"/>`);
    }
  }
  // Häfen
  for (const hb of b.harbors) {
    const h = b.hexes[hb.hex];
    const e = b.edges[hb.edge];
    const [cx, cy] = P(h);
    const [ax, ay] = P(b.vertices[e.v[0]]), [bx, by] = P(b.vertices[e.v[1]]);
    const lx = cx + ((ax + bx) / 2 - cx) * 0.25, ly = cy + ((ay + by) / 2 - cy) * 0.25;
    [[ax, ay], [bx, by]].forEach(([x, y]) => out.push(`<line x1="${x}" y1="${y}" x2="${x + (lx - x) * 0.55}" y2="${y + (ly - y) * 0.55}" stroke="#c9a66b" stroke-width="5" stroke-linecap="round"/>`));
    out.push(`<circle cx="${lx}" cy="${ly}" r="17" fill="#f4ecd8" stroke="#8a6d3b" stroke-width="1.5"/>`);
    if (hb.type === 'any') out.push(`<text class="harbor-label" x="${lx}" y="${ly}">3:1</text>`);
    else {
      out.push(`<text class="harbor-label" x="${lx}" y="${ly - 6}" style="font-size:12px">${EMOJI[hb.type]}</text>`);
      out.push(`<text class="harbor-label" x="${lx}" y="${ly + 8}">2:1</text>`);
    }
  }
  // Klickflächen für Felder
  for (const h of b.hexes) {
    if (!hexSet.has(h.id)) continue;
    const pts = h.vertices.map(v => P(b.vertices[v]).map(n => n.toFixed(1)).join(',')).join(' ');
    out.push(`<polygon class="hex-click ${I.edit ? 'edit' : 'legal'}" data-h="${h.id}" points="${pts}"/>`);
  }
  // Straßen & Schiffe
  const seg = (e, shrink) => {
    const [ax, ay] = P(b.vertices[b.edges[e].v[0]]), [bx, by] = P(b.vertices[b.edges[e].v[1]]);
    const dx = (bx - ax) * shrink, dy = (by - ay) * shrink;
    return [ax + dx, ay + dy, bx - dx, by - dy];
  };
  for (const k in g.roads) {
    const [x1, y1, x2, y2] = seg(Number(k), 0.16);
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="10" stroke-linecap="round"/>`);
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color(g.roads[k])}" stroke-width="7" stroke-linecap="round"/>`);
  }
  for (const k in g.ships) {
    const [x1, y1, x2, y2] = seg(Number(k), 0.12);
    const c = color(g.ships[k].owner);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="4" stroke-dasharray="6 4" stroke-linecap="round"/>`);
    out.push(`<g transform="translate(${mx},${my})"><path class="piece" d="M-11,-1 L11,-1 L7,6 L-7,6 Z" fill="${c}"/>
      <path class="piece" d="M0,-15 L0,-2 L9,-2 Z" fill="#fafafa" stroke-width="1"/><line x1="0" y1="-15" x2="0" y2="-1" stroke="#111" stroke-width="1.5"/></g>`);
  }
  // Gebäude
  for (const k in g.buildings) {
    const bd = g.buildings[k];
    const [x, y] = P(b.vertices[k]);
    const c = color(bd.owner);
    if (bd.type === 'city') out.push(`<path class="piece" transform="translate(${x},${y})" d="M-13,8 L-13,-4 L-4,-4 L-4,-10 L3,-16 L10,-10 L10,8 Z" fill="${c}"/>`);
    else out.push(`<path class="piece" transform="translate(${x},${y})" d="M-8,7 L-8,-3 L0,-11 L8,-3 L8,7 Z" fill="${c}"/>`);
  }
  // Räuber & Pirat
  if (b.robber !== null && b.robber !== undefined) {
    const [x, y] = P(b.hexes[b.robber]);
    out.push(`<g transform="translate(${x + 26},${y + 2})" style="pointer-events:none"><ellipse cx="0" cy="14" rx="10" ry="4" fill="#0006"/>
      <path d="M-8,14 Q-9,0 -4,-3 Q-7,-8 0,-13 Q7,-8 4,-3 Q9,0 8,14 Z" fill="#2d2d2d" stroke="#eee" stroke-width="1.5"/></g>`);
  }
  if (b.pirate !== null && b.pirate !== undefined) {
    const [x, y] = P(b.hexes[b.pirate]);
    out.push(`<g transform="translate(${x},${y})" style="pointer-events:none"><path d="M-20,2 L20,2 L13,13 L-13,13 Z" fill="#1b1b1b" stroke="#ddd"/>
      <path d="M-2,-22 L-2,1 L-16,1 Z" fill="#1b1b1b" stroke="#ddd"/><path d="M1,-20 L1,1 L15,1 Z" fill="#1b1b1b" stroke="#ddd"/>
      <text x="8" y="-8" font-size="9" text-anchor="middle" fill="#fff">☠</text></g>`);
  }
  // Klickbare Kanten / Ecken
  for (const e of eSet) {
    const [x1, y1, x2, y2] = seg(e, 0.2);
    out.push(`<line class="${I.edit ? 'editedge' : 'espot ' + I.edgeClass}" data-e="${e}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  }
  for (const v of vSet) {
    const [x, y] = P(b.vertices[v]);
    out.push(`<circle class="${I.edit ? 'editspot' : 'spot'}" data-v="${v}" cx="${x}" cy="${y}" r="${I.edit ? 7 : 8}"/>`);
  }
  $('board').innerHTML = out.join('');
}

$('board').addEventListener('click', (e) => {
  const I = currentInteractions;
  if (!I) return;
  const t = e.target;
  if (t.dataset.v !== undefined && I.onV) return I.onV(Number(t.dataset.v));
  if (t.dataset.e !== undefined && I.onE) return I.onE(Number(t.dataset.e));
  if (t.dataset.h !== undefined && I.onH) return I.onH(Number(t.dataset.h));
});

function renderDice() {
  const g = S.game;
  if (!g.dice) { $('dice').innerHTML = ''; return; }
  const red = g.dice[0] + g.dice[1] === 7;
  $('dice').innerHTML = g.dice.map(d => `<div class="die ${red ? 'red' : ''}">${d}</div>`).join('');
}

// ------------------------------------------------------------------ Seitenleiste
function renderPlayers() {
  const g = S.game;
  const seats = S.room.seats;
  $('players').innerHTML = g.players.map(p => {
    const turn = g.phase === 'play' ? g.turn === p.seat : g.phase === 'setup' ? g.setup.order[g.setup.idx] === p.seat : false;
    const online = seats[p.seat] ? seats[p.seat].online : true;
    return `<div class="pl ${turn ? 'turn' : ''}">
      <span class="swatch" style="background:${p.color}"></span>
      <span class="name">${esc(p.name)}${p.seat === g.you ? ' (du)' : ''} ${p.bot ? '🤖' : ''} ${online ? '' : '<span class="off">offline</span>'}</span>
      <span class="vp" title="Siegpunkte${p.seat === g.you ? '' : ' (sichtbar)'}">${p.vp}</span>
      <span class="stats">
        <span title="Rohstoffkarten">🃏 ${p.cardCount}</span>
        <span title="Entwicklungskarten">📜 ${p.devCount}</span>
        <span title="Ausgespielte Ritter">⚔️ ${p.knights}</span>
        <span title="Längste Handelsstraße">🛤️ ${p.roadLength}</span>
        ${g.longestRoad === p.seat ? '<span class="badge" title="Längste Handelsstraße (+2)">Straße +2</span>' : ''}
        ${g.largestArmy === p.seat ? '<span class="badge" title="Größte Rittermacht (+2)">Ritter +2</span>' : ''}
        ${p.bonusVP ? `<span class="badge" title="Inselbonus">🏝️ +${p.bonusVP}</span>` : ''}
        ${isHost() && !S.room.local && p.seat !== g.you && !p.bot ? `<button class="small ghost" data-a="release" data-seat="${p.seat}" title="Platz freigeben (z. B. für ein anderes Gerät): danach kann man ihn mit genau diesem Namen übernehmen">🔓</button>` : ''}
        ${isHost() && p.seat !== g.you ? `<button class="small ghost" data-a="toggleBot" data-seat="${p.seat}" title="${p.bot ? 'Bot entfernen (Mensch übernimmt)' : 'Bot übernimmt diesen Platz'}">${p.bot ? '👤' : '🤖'}</button>` : ''}
      </span></div>`;
  }).join('') + `<div class="hint" style="font-size:.8em">Ziel: ${g.scenario.vpTarget} SP · ${esc(g.scenario.name)} · Bank: ${RES.map(k => EMOJI[k] + g.bank[k]).join(' ')} · 📜${g.devDeckCount}</div>`;
}
$('players').onclick = (e) => {
  const b = e.target.closest('[data-a="toggleBot"]');
  if (b) send({ t: 'toggleBot', seat: Number(b.dataset.seat) });
  const r = e.target.closest('[data-a="release"]');
  if (r && confirm('Platz freigeben? Die Verbindung des Spielers wird getrennt; danach kann er (z. B. auf einem anderen Gerät) mit genau seinem Namen wieder beitreten.')) send({ t: 'release', seat: Number(r.dataset.seat) });
};

function picker(id, opts = {}) {
  const v = S.picker[id] || (S.picker[id] = zero());
  return `<div class="picker">${RES.map(k => {
    const max = opts.max ? opts.max[k] : 99;
    return `<div class="pk"><div class="em" title="${RES_DE[k]}">${EMOJI[k]}</div><div class="n">${v[k]}</div>
      <button class="small" data-a="pk" data-id="${id}" data-r="${k}" data-d="-1" ${v[k] <= 0 ? 'disabled' : ''}>−</button><button class="small" data-a="pk" data-id="${id}" data-r="${k}" data-d="1" ${v[k] >= max ? 'disabled' : ''}>+</button></div>`;
  }).join('')}</div>`;
}

function renderPanel() {
  const g = S.game;
  const L = g.legal || {};
  const me = g.players[g.you];
  let h = '';
  if (g.you === null || g.you === undefined) {
    $('panel').innerHTML = '<p class="hint">Du schaust zu.</p>';
    return;
  }
  if (g.phase === 'ended') {
    h += `<h2>🏆 ${esc(g.players[g.winner].name)} gewinnt!</h2><p class="hint">Alle Karten sind jetzt aufgedeckt.</p>`;
    h += g.players.map(p => `<div>${esc(p.name)}: <strong>${p.vp}</strong> SP</div>`).join('');
    if (isHost()) h += `<div class="btns"><button class="primary" data-a="reset">Zurück in den Warteraum</button></div>`;
    $('panel').innerHTML = h;
    return;
  }
  if (g.editor) {
    $('panel').innerHTML = isHost() ? editorPanel(g) : '<p class="hint">✏️ Der Gastgeber bearbeitet gerade die Stellung…</p>';
    return;
  }
  if (L.discard) {
    const v = S.picker.discard || zero();
    h += `<div class="section-title">Räuber! Wirf ${L.discard} Karten ab</div>${picker('discard', { max: me.res })}
      <button class="primary" data-a="discard" ${sumRes(v) !== L.discard ? 'disabled' : ''}>Abwerfen (${sumRes(v)}/${L.discard})</button>`;
  } else if (L.gold) {
    const v = S.picker.gold || zero();
    h += `<div class="section-title">💰 Goldfluss: wähle ${L.gold} Rohstoff${L.gold > 1 ? 'e' : ''}</div>${picker('gold', { max: g.bank })}
      <button class="primary" data-a="gold" ${sumRes(v) !== L.gold ? 'disabled' : ''}>Nehmen (${sumRes(v)}/${L.gold})</button>`;
  } else if (L.robber) {
    h += `<p>Klicke auf ein leuchtendes Feld, um den <strong>Räuber</strong> zu versetzen${g.scenario.seafarers ? ' – oder auf ein Meerfeld für den <strong>Piraten</strong>' : ''}.</p>`;
  } else if (L.steal) {
    h += `<div class="section-title">Bei wem ziehst du eine Karte?</div><div class="btns">${L.steal.map(s => `<button data-a="steal" data-seat="${s}"><span class="swatch" style="background:${g.players[s].color}"></span> ${esc(g.players[s].name)} (${g.players[s].cardCount})</button>`).join('')}</div>`;
  } else if (L.roadBuilding !== undefined) {
    h += `<p>🛤️ Straßenbau: noch <strong>${L.roadBuilding}</strong> kostenlos. Klicke auf eine Kante.</p>${edgeToggle(L)}
      <div class="btns"><button data-a="endRoadBuilding">Fertig</button></div>`;
  } else if (L.setup) {
    h += L.setup === 'settlement' ? '<p>Klicke auf eine leuchtende Ecke, um deine Siedlung zu gründen.</p>'
      : `<p>Setze ${g.scenario.seafarers ? 'eine Straße oder ein Schiff' : 'eine Straße'} an deine neue Siedlung.</p>${edgeToggle(L)}`;
  } else if (L.myTurn) {
    h += mainActions(g, L, me);
  } else if (g.phase === 'setup') {
    h += '<p class="hint">Warte auf die anderen Spieler…</p>';
  } else {
    h += `<p class="hint">${esc(g.players[g.turn].name)} ist am Zug.</p>`;
  }
  h += tradeBox(g, me);
  $('panel').innerHTML = h;
}

function edgeToggle(L) {
  if (!(L.ship || []).length || !(L.road || []).length) return '';
  const k = S.edgeKind;
  return `<div class="btns"><button data-a="edgeKind" data-k="road" class="${k === 'road' ? 'active' : ''}">🛤️ Straße</button><button data-a="edgeKind" data-k="ship" class="${k === 'ship' ? 'active' : ''}">⛵ Schiff</button></div>`;
}

function mainActions(g, L, me) {
  let h = '';
  if (S.mode) {
    const what = { settlement: 'eine Ecke für die Siedlung', city: 'eine deiner Siedlungen', road: 'eine Kante für die Straße', ship: 'eine Kante für das Schiff', moveFrom: 'das Schiff, das du versetzen willst', moveTo: 'das neue Ziel für das Schiff' }[S.mode];
    return `<p>Wähle ${what} auf dem Spielfeld.</p><div class="btns"><button data-a="cancelMode">Abbrechen</button></div>`;
  }
  if (S.devChoice === 'yearOfPlenty') {
    const v = S.picker.yop || zero();
    return `<div class="section-title">🎁 Erfindung: wähle 2 Rohstoffe</div>${picker('yop', { max: g.bank })}
      <div class="btns"><button class="primary" data-a="yop" ${sumRes(v) !== 2 ? 'disabled' : ''}>Nehmen</button><button data-a="cancelDev">Abbrechen</button></div>`;
  }
  if (S.devChoice === 'monopoly') {
    return `<div class="section-title">💹 Monopol: welcher Rohstoff?</div><div class="btns">${RES.map(k => `<button data-a="mono" data-r="${k}">${EMOJI[k]} ${RES_DE[k]}</button>`).join('')}</div>
      <div class="btns"><button data-a="cancelDev">Abbrechen</button></div>`;
  }
  if (L.canRoll) {
    h += `<div class="btns"><button class="primary" data-a="roll" style="font-size:1.2em">🎲 Würfeln</button></div>`;
    if ((L.playable || []).includes('knight')) h += '<p class="hint">Du kannst vor dem Würfeln einen Ritter ausspielen (siehe deine Karten unten).</p>';
    return h;
  }
  const can = (what) => hasRes(me.res, COST[what]);
  const btn = (what, label, list) => `<button data-a="mode" data-m="${what}" ${!can(what) || !(list || []).length ? 'disabled' : ''} title="${costText(COST[what])}">${label}<span class="cost">${costText(COST[what])}</span></button>`;
  h += '<div class="section-title">Bauen</div><div class="btns">';
  h += btn('road', '🛤️ Straße', L.road);
  if (g.scenario.seafarers) h += btn('ship', '⛵ Schiff', L.ship);
  h += btn('settlement', '🏠 Siedlung', L.settlement);
  h += btn('city', '🏰 Stadt', L.city);
  h += `<button data-a="buyDev" ${!can('dev') || !g.devDeckCount ? 'disabled' : ''}>📜 Entwicklung<span class="cost">${costText(COST.dev)}</span></button>`;
  if (g.scenario.seafarers) h += `<button data-a="mode" data-m="moveFrom" ${!(L.movableShips || []).length ? 'disabled' : ''} title="Ein offenes Schiff pro Zug versetzen">↪️ Schiff versetzen</button>`;
  h += '</div>';
  // Banktausch
  const ratios = g.ratios || {};
  h += `<div class="section-title">Tausch mit Bank/Hafen</div><div class="row">
    <select id="bankGive"><option value="">Gib…</option>${RES.map(k => `<option value="${k}" ${S.bankGive === k ? 'selected' : ''} ${me.res[k] < ratios[k] ? 'disabled' : ''}>${ratios[k]}× ${EMOJI[k]} ${RES_DE[k]}</option>`).join('')}</select>
    <span>→</span>
    <select id="bankGet"><option value="">Erhalte…</option>${RES.map(k => `<option value="${k}" ${S.bankGet === k ? 'selected' : ''} ${!g.bank[k] ? 'disabled' : ''}>1× ${EMOJI[k]} ${RES_DE[k]}</option>`).join('')}</select>
    <button data-a="bankTrade">Tauschen</button></div>`;
  // Spielerhandel
  if (!g.trade) {
    if (S.tradeOpen) {
      const give = S.picker.tgive || zero(), get = S.picker.tget || zero();
      h += `<div class="section-title">Ich gebe</div>${picker('tgive', { max: me.res })}<div class="section-title">Ich möchte</div>${picker('tget')}
        <div class="btns"><button class="primary" data-a="offer" ${!sumRes(give) || !sumRes(get) ? 'disabled' : ''}>Angebot an alle</button><button data-a="tradeClose">Abbrechen</button></div>`;
    } else h += `<div class="btns"><button data-a="tradeOpen">🤝 Handel mit Mitspielern</button></div>`;
  }
  h += `<div class="btns" style="margin-top:10px"><button class="primary" data-a="endTurn">Zug beenden ⏭</button></div>`;
  return h;
}

function tradeBox(g, me) {
  const t = g.trade;
  if (!t) return '';
  const from = g.players[t.from];
  let h = `<div class="offer"><strong>${t.from === g.you ? 'Dein Angebot' : esc(from.name) + ' bietet'}:</strong><br>
    gibt ${costText(t.give)} &nbsp;⇄&nbsp; möchte ${costText(t.get)}<br>`;
  if (t.from === g.you) {
    const others = g.players.filter(p => p.seat !== g.you);
    h += others.map(p => {
      const r = t.responses[p.seat];
      return `<div class="row" style="margin-top:4px"><span class="swatch" style="background:${p.color}"></span> ${esc(p.name)}: ${r === true ? '✅ ja' : r === false ? '❌ nein' : '… wartet'}
        ${r === true ? `<button class="small primary" data-a="acceptTrade" data-seat="${p.seat}">Handeln</button>` : ''}</div>`;
    }).join('');
    h += `<div class="btns"><button class="small" data-a="cancelTrade">Angebot zurückziehen</button></div>`;
  } else if (me) {
    const r = t.responses[g.you];
    const ok = hasRes(me.res, t.get);
    h += `<div class="btns"><button class="small primary" data-a="respond" data-v="1" ${!ok ? 'disabled' : ''}>✅ Annehmen</button>
      <button class="small" data-a="respond" data-v="0">❌ Ablehnen</button></div>${r !== undefined ? `<span class="hint">Deine Antwort: ${r ? 'ja' : 'nein'}</span>` : ''}`;
  }
  return h + '</div>';
}

function editorPanel(g) {
  const E = S.editor;
  if (!g.players[E.owner]) E.owner = 0;
  const tools = [['settlement', '🏠 Siedlung'], ['city', '🏰 Stadt'], ['road', '🛤️ Straße'], ['ship', '⛵ Schiff'], ['remove', '🗑️ Entfernen'], ['robber', '🥷 Räuber/Pirat'], ['hexType', '🗺️ Feldtyp'], ['number', '🔢 Zahl'], ['harbor', '⚓ Hafen']]
    .filter(([k]) => k !== 'ship' || g.scenario.seafarers);
  let h = `<div class="section-title">✏️ Editor – Werkzeug</div><div class="editor-grid">${tools.map(([k, l]) => `<button class="small ${E.tool === k ? 'active' : ''}" data-a="etool" data-k="${k}">${l}</button>`).join('')}</div>`;
  if (['settlement', 'city', 'road', 'ship'].includes(E.tool)) {
    h += `<div class="section-title">Für Spieler</div><div class="btns">${g.players.map(p => `<button class="small ${E.owner === p.seat ? 'active' : ''}" data-a="eowner" data-seat="${p.seat}"><span class="swatch" style="background:${p.color}"></span> ${esc(p.name)}</button>`).join('')}</div>`;
  }
  if (E.tool === 'hexType') {
    h += `<div class="btns">${['wood', 'brick', 'wool', 'grain', 'ore', 'gold', 'desert', 'sea'].map(t => `<button class="small ${E.hexType === t ? 'active' : ''}" data-a="ehex" data-k="${t}">${EMOJI[t] || '🌊'} ${HEX_DE[t]}</button>`).join('')}</div>`;
  }
  if (E.tool === 'harbor') {
    const types = [['any', '3:1 beliebig'], ...RES.map(k => [k, `2:1 ${EMOJI[k]} ${RES_DE[k]}`]), ['none', '🗑️ Hafen entfernen']];
    h += `<div class="btns">${types.map(([k, l]) => `<button class="small ${E.harbor === k ? 'active' : ''}" data-a="eharbor" data-k="${k}">${l}</button>`).join('')}</div>
      <p class="hint">Klicke auf eine Küstenkante (zwischen Meer und Land). Ein vorhandener Hafen an dieser Kante wird ersetzt.</p>`;
  }
  if (E.tool === 'number') {
    h += `<div class="btns">${[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map(n => `<button class="small ${E.number === n ? 'active' : ''}" data-a="enum" data-k="${n}">${n}</button>`).join('')}</div>`;
  }
  h += '<p class="hint">Klicke auf das Spielfeld, um das Werkzeug anzuwenden.</p>';
  h += `<div class="section-title">Karten der Spieler</div><table class="editor-table"><tr><td></td>${RES.map(k => `<td>${EMOJI[k]}</td>`).join('')}<td>⚔️</td><td title="Bonus-SP">🏝️</td></tr>`;
  g.players.forEach(p => {
    const cell = (op, k, n) => `<td><button data-a="eres" data-op="${op}" data-seat="${p.seat}" data-r="${k}" data-d="-1">−</button><br>${n}<br><button data-a="eres" data-op="${op}" data-seat="${p.seat}" data-r="${k}" data-d="1">+</button></td>`;
    h += `<tr><td><span class="swatch" style="background:${p.color}" title="${esc(p.name)}"></span></td>${RES.map(k => cell('res', k, p.res ? p.res[k] : '?')).join('')}${cell('knights', '', p.knights)}${cell('bonus', '', p.bonusVP)}</tr>`;
  });
  h += '</table>';
  h += `<div class="section-title">Entwicklungskarten</div><div class="row"><select id="eDev">${Object.keys(DEV_DE).map(k => `<option value="${k}" ${E.dev === k ? 'selected' : ''}>${DEV_EMOJI[k]} ${DEV_DE[k]}</option>`).join('')}</select>
    ${g.players.map(p => `<button class="small" data-a="edev" data-seat="${p.seat}" data-d="1" title="${esc(p.name)} geben"><span class="swatch" style="background:${p.color}"></span>+</button>`).join('')}</div>
    <div class="hint">${g.players.map(p => `${esc(p.name)}: ${(p.dev || []).map(d => DEV_EMOJI[d.type]).join('') || '–'}`).join(' · ')}</div>
    <div class="row">${g.players.map(p => `<button class="small" data-a="edev" data-seat="${p.seat}" data-d="-1" title="${esc(p.name)} gewählte Karte wegnehmen"><span class="swatch" style="background:${p.color}"></span>−</button>`).join('')}</div>`;
  h += `<div class="section-title">Siegpunktziel</div><div class="row"><input id="eVp" type="number" min="3" max="30" value="${g.scenario.vpTarget}"><button data-a="evp">Setzen</button></div>`;
  h += `<div class="section-title">Von dieser Stellung aus weiterspielen</div><div class="row">
    <select id="eStart">${g.players.map(p => `<option value="${p.seat}" ${E.startSeat === p.seat ? 'selected' : ''}>${esc(p.name)} ist am Zug</option>`).join('')}</select>
    <label style="display:flex;gap:4px;align-items:center;margin:0"><input type="checkbox" id="eRolled" style="width:auto" ${E.rolled ? 'checked' : ''}> hat schon gewürfelt</label></div>
    <div class="btns"><button class="primary" data-a="estart">▶️ Hier starten</button><button data-a="etoggle">Editor schließen</button></div>
    <p class="hint">„Hier starten“ beendet die Gründungsphase und setzt das Spiel mit dem gewählten Spieler fort. „Editor schließen“ kehrt zum vorherigen Spielzustand zurück.</p>`;
  return h;
}

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  const g = S.game;
  const d = b.dataset;
  const take = (id) => { const v = S.picker[id] || zero(); S.picker[id] = zero(); return v; };
  switch (d.a) {
    case 'pk': {
      const v = S.picker[d.id] || (S.picker[d.id] = zero());
      v[d.r] = Math.max(0, v[d.r] + Number(d.d));
      renderPanel();
      return;
    }
    case 'discard': return act({ type: 'discard', res: take('discard') });
    case 'gold': return act({ type: 'gold', res: take('gold') });
    case 'steal': return act({ type: 'steal', target: Number(d.seat) });
    case 'endRoadBuilding': return act({ type: 'endRoadBuilding' });
    case 'edgeKind': S.edgeKind = d.k; return renderAll();
    case 'roll': return act({ type: 'roll' });
    case 'mode': S.mode = d.m; return renderAll();
    case 'cancelMode': S.mode = null; return renderAll();
    case 'buyDev': return act({ type: 'buyDev' });
    case 'endTurn': S.tradeOpen = false; return act({ type: 'endTurn' });
    case 'bankTrade': {
      const give = $('bankGive').value, get = $('bankGet').value;
      S.bankGive = give; S.bankGet = get;
      if (!give || !get) return toast('Wähle, was du gibst und was du erhältst.');
      return act({ type: 'bankTrade', give, get });
    }
    case 'tradeOpen': S.tradeOpen = true; return renderPanel();
    case 'tradeClose': S.tradeOpen = false; return renderPanel();
    case 'offer': S.tradeOpen = false; return act({ type: 'offerTrade', give: take('tgive'), get: take('tget') });
    case 'acceptTrade': return act({ type: 'acceptTrade', with: Number(d.seat) });
    case 'cancelTrade': return act({ type: 'cancelTrade' });
    case 'respond': return act({ type: 'respondTrade', accept: d.v === '1' });
    case 'yop': {
      const v = take('yop');
      const list = [];
      RES.forEach(k => { for (let i = 0; i < v[k]; i++) list.push(k); });
      S.devChoice = null;
      return act({ type: 'playDev', card: 'yearOfPlenty', res1: list[0], res2: list[1] });
    }
    case 'mono': S.devChoice = null; return act({ type: 'playDev', card: 'monopoly', res: d.r });
    case 'cancelDev': S.devChoice = null; return renderPanel();
    case 'reset': return send({ t: 'reset' });
    // Editor
    case 'etool': S.editor.tool = d.k; return renderAll();
    case 'eowner': S.editor.owner = Number(d.seat); return renderAll();
    case 'ehex': S.editor.hexType = d.k; return renderAll();
    case 'enum': S.editor.number = Number(d.k); return renderAll();
    case 'eharbor': S.editor.harbor = d.k; return renderAll();
    case 'eres': {
      const op = d.op;
      if (op === 'res') return act({ type: 'edit', op: 'res', seat: Number(d.seat), res: d.r, delta: Number(d.d) });
      return act({ type: 'edit', op, seat: Number(d.seat), delta: Number(d.d) });
    }
    case 'edev': {
      S.editor.dev = $('eDev').value;
      return act({ type: 'edit', op: 'dev', seat: Number(d.seat), card: S.editor.dev, delta: Number(d.d) });
    }
    case 'evp': return act({ type: 'edit', op: 'vpTarget', value: Number($('eVp').value) });
    case 'estart': {
      S.editor.startSeat = Number($('eStart').value);
      S.editor.rolled = $('eRolled').checked;
      return act({ type: 'edit', op: 'startAt', seat: S.editor.startSeat, rolled: S.editor.rolled });
    }
    case 'etoggle': return act({ type: 'edit', op: 'toggle' });
  }
});
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'bankGive') S.bankGive = e.target.value;
  if (e.target.id === 'bankGet') S.bankGet = e.target.value;
  if (e.target.id === 'eDev') S.editor.dev = e.target.value;
  if (e.target.id === 'eStart') S.editor.startSeat = Number(e.target.value);
  if (e.target.id === 'eRolled') S.editor.rolled = e.target.checked;
});

function renderHand() {
  const g = S.game;
  const me = g.players[g.you];
  if (!me || !me.res) { $('hand').innerHTML = ''; return; }
  const L = g.legal || {};
  const playable = new Set(L.playable || []);
  let h = `<div class="section-title">Deine Karten (${sumRes(me.res)})</div><div class="res-row">${RES.map(k => `<div class="res-card"><span class="em">${EMOJI[k]}</span><span class="n">${me.res[k]}</span><div class="r">${RES_DE[k]}</div></div>`).join('')}</div>`;
  if (me.dev && me.dev.length) {
    const groups = {};
    me.dev.forEach(d => {
      const k = d.type;
      groups[k] = groups[k] || { n: 0, fresh: 0 };
      groups[k].n++;
      if (d.turn >= g.turnNumber) groups[k].fresh++;
    });
    const canPlay = (k) => playable.has(k) && !g.pending.length && g.phase === 'play' && !g.editor;
    h += `<div class="devs">${Object.entries(groups).map(([k, v]) => `<div class="dev ${v.fresh === v.n ? 'new' : ''}" title="${DEV_HELP[k]}${v.fresh ? ' (diesen Zug gekauft)' : ''}">${DEV_EMOJI[k]} ${DEV_DE[k]}${v.n > 1 ? ' ×' + v.n : ''}
      ${canPlay(k) ? `<button class="small" data-play="${k}">Ausspielen</button>` : ''}</div>`).join('')}</div>`;
  }
  h += `<div class="hint" style="margin-top:6px">Figuren: 🛤️${me.pieces.road} ${g.scenario.seafarers ? '⛵' + me.pieces.ship : ''} 🏠${me.pieces.settlement} 🏰${me.pieces.city}</div>`;
  $('hand').innerHTML = h;
}
$('hand').addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  const k = b.dataset.play;
  if (k === 'yearOfPlenty' || k === 'monopoly') { S.devChoice = k; S.picker.yop = zero(); return renderPanel(); }
  act({ type: 'playDev', card: k });
});

function renderLog() {
  const g = S.game;
  const el = $('log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = g.log.map(l => `<div>${esc(l.t)}</div>`).join('');
  const last = g.log.length ? g.log[g.log.length - 1].n : 0;
  if (atBottom || last !== S.lastLogN) el.scrollTop = el.scrollHeight;
  S.lastLogN = last;
}
function renderChat() {
  const chat = (S.room && S.room.chat) || [];
  const el = $('chatMsgs');
  el.innerHTML = chat.map(c => `<div><strong style="color:${esc(c.color)}">${esc(c.from)}:</strong> ${esc(c.text)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
  if (S.tab === 'chat') S.chatSeen = chat.length;
  const unread = chat.length - S.chatSeen;
  $('chatBadge').textContent = unread > 0 ? unread : '';
}

function showHelp() {
  $('overlayBox').innerHTML = `<h2>Spielregeln in Kürze</h2>
  <ul>
    <li><strong>Ziel:</strong> Als Erste/r die Siegpunkte des Szenarios erreichen (nur im eigenen Zug).</li>
    <li><strong>Gründung:</strong> Jede/r setzt reihum 1 Siedlung + 1 Straße (bzw. Schiff), dann in umgekehrter Reihenfolge eine zweite. Für die zweite Siedlung gibt es Startrohstoffe.</li>
    <li><strong>Zug:</strong> Würfeln → alle Felder mit der Zahl liefern Rohstoffe an angrenzende Siedlungen (1) und Städte (2). Dann handeln und bauen.</li>
    <li><strong>Kosten:</strong> Straße ${costText(COST.road)}, Schiff ${costText(COST.ship)}, Siedlung ${costText(COST.settlement)}, Stadt ${costText(COST.city)}, Entwicklungskarte ${costText(COST.dev)}.</li>
    <li><strong>Abstandsregel:</strong> Zwischen zwei Siedlungen muss mindestens eine freie Ecke liegen.</li>
    <li><strong>7 gewürfelt:</strong> Wer mehr als 7 Karten hat, wirft die Hälfte ab. Der Räuber (oder auf See der Pirat) wird versetzt, und man zieht eine Karte bei einem Betroffenen.</li>
    <li><strong>Handel:</strong> Mit der Bank 4:1, an einem 3:1-Hafen 3:1, an einem Spezialhafen 2:1 – oder frei mit Mitspielern.</li>
    <li><strong>Entwicklungskarten:</strong> Ritter, Siegpunkt, Straßenbau, Erfindung, Monopol. Max. eine pro Zug, nicht im Kaufzug.</li>
    <li><strong>Sonderpunkte:</strong> Längste Handelsstraße (min. 5) und größte Rittermacht (min. 3 Ritter) bringen je 2 SP.</li>
  </ul>
  <h3>Seefahrt</h3>
  <ul>
    <li><strong>Schiffe</strong> fahren auf Kanten am oder im Wasser und verbinden Siedlungen über das Meer. Straße ↔ Schiff wechseln nur an einer eigenen Siedlung/Stadt.</li>
    <li>Ein <strong>offenes Schiff</strong> (Ende einer Schiffslinie, nicht im selben Zug gebaut) darf einmal pro Zug versetzt werden.</li>
    <li><strong>Pirat:</strong> Blockiert Bau und Versetzen von Schiffen an seinem Meerfeld; beim Versetzen wird bei Schiffsbesitzern gezogen.</li>
    <li><strong>Goldfluss:</strong> Liefert einen Rohstoff nach Wahl (Stadt: zwei).</li>
    <li><strong>Inselbonus:</strong> Die erste Siedlung auf jeder neuen Insel bringt Bonus-Siegpunkte.</li>
  </ul>
  <h3>Bestimmte Stellung</h3>
  <p>Der Gastgeber kann über <strong>✏️ Editor</strong> beliebig Gebäude, Straßen, Schiffe, Räuber/Pirat, Felder, Zahlen und Karten setzen und dann mit „Hier starten“ weiterspielen. Mit <strong>💾</strong> wird der Spielstand gespeichert und kann später (auch in einem neuen Raum) geladen werden.</p>
  <button data-close class="primary">Schließen</button>`;
  $('overlay').hidden = false;
}

// Link mit #pos=… füllt den Stellungscode auf der Startseite vor (der Hash wird nie an den Server geschickt)
function takePositionFromHash() {
  const m = location.hash.match(/^#pos=(.+)$/);
  if (!m) return;
  let code;
  try { code = decodeURIComponent(m[1]); } catch { code = m[1]; }
  history.replaceState(null, '', location.pathname + location.search);
  if (S.room) {
    if (!confirm('Dieser Link enthält eine Stellung. Raum verlassen, um sie zu starten?')) return;
    send({ t: 'leave' });
  }
  showScreen('lobby');
  $('posCodeInput').value = code;
  setTimeout(() => { toast('Stellung aus Link erkannt – Namen eingeben und „Aus Code erstellen“ klicken.', true); $('posCodeInput').scrollIntoView({ block: 'center' }); }, 300);
}

// ------------------------------------------------------------------ Start
(function init() {
  try { $('nameInput').value = localStorage.getItem('inselreich_name') || ''; } catch { /* */ }
  loadInfo().then(loadRooms);
  takePositionFromHash();
  window.addEventListener('hashchange', takePositionFromHash);
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase();
  connect();
  if (code) {
    $('codeInput').value = code;
    if (tokens[code]) { S.roomId = code; showScreen('room'); }
    else if (getName()) joinRoom(code);
  }
})();
