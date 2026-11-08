'use strict';
/* Inselreich – Offline-Modus: ein "Server" im Browser.
 * Wird nur in der statischen Version (GitHub Pages) geladen. Er versteht dieselben Nachrichten
 * wie server/index.js, kennt aber nur einen Raum: Bots und/oder mehrere Menschen an einem Gerät
 * (Pass-and-Play). Der Spielstand wird im localStorage des Browsers gespeichert. */
(function () {
  const { G, Bot, maps, Position } = window.InselreichEngine;
  const KEY = 'inselreich_local_room';
  const ROOM_ID = 'LOKAL';
  const COLORS = G.COLORS;
  const BOT_DELAY = 600;
  let room = null;
  let sock = null;
  let botTimer = null;

  const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>]/g, '').trim().slice(0, 20);

  function persist() {
    try { if (room) localStorage.setItem(KEY, JSON.stringify(room)); else localStorage.removeItem(KEY); } catch { /* privater Modus */ }
  }
  function restore() {
    try {
      const r = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (r && Array.isArray(r.seats)) {
        if (r.game) r.game = G.validateLoaded(r.game);
        room = r;
      }
    } catch { room = null; }
  }

  function emit(obj) {
    // asynchron wie über das Netz, damit der Client-Ablauf identisch bleibt
    setTimeout(() => { if (sock && sock.onmessage) sock.onmessage({ data: JSON.stringify(obj) }); }, 0);
  }
  const err = (msg) => emit({ t: 'error', msg });

  // Wessen Sicht wird angezeigt? Der Mensch, der gerade etwas tun muss (Pass-and-Play).
  function viewerSeat() {
    const humans = room.seats.map((s, i) => (s.bot ? -1 : i)).filter(i => i >= 0);
    if (!humans.length) return null;
    const g = room.game;
    if (!g) return humans.includes(room.viewer) ? room.viewer : humans[0];
    const needs = (i) => {
      const L = G.legalFor(g, i);
      if (Object.keys(L).length) return true;
      return g.phase === 'play' && g.trade && g.trade.from !== i && g.trade.responses[i] === undefined;
    };
    // Offenes Handelsangebot: zuerst alle Menschen fragen, die noch nicht geantwortet haben
    // (sonst bliebe die Ansicht beim Anbietenden, der ja immer etwas tun kann)
    if (g.phase === 'play' && g.trade && !g.pending.length) {
      const ask = humans.find(i => i !== g.trade.from && g.trade.responses[i] === undefined);
      if (ask !== undefined) { room.viewReason = 'trade'; return ask; }
    }
    room.viewReason = null;
    const order = [];
    if (g.phase === 'play') order.push(g.turn);
    if (g.phase === 'setup' && g.setup) order.push(g.setup.order[g.setup.idx]);
    if (g.pending[0] && g.pending[0].need) order.push(...Object.keys(g.pending[0].need).map(Number));
    if (g.pending[0] && g.pending[0].seat !== undefined) order.unshift(g.pending[0].seat);
    order.push(...humans);
    const found = order.find(i => humans.includes(i) && needs(i));
    if (found !== undefined) return found;
    return humans.includes(room.viewer) ? room.viewer : humans[0];
  }

  function broadcast() {
    if (!room) return;
    room.viewer = viewerSeat();
    const you = room.viewer;
    emit({
      t: 'room',
      room: {
        id: ROOM_ID, name: room.name, options: room.options, started: !!room.game, local: true,
        seats: room.seats.map((s, i) => ({ seat: i, name: s.name, bot: s.bot, color: s.color, online: true })),
        chat: room.chat.slice(-60), spectators: 0, you, host: true, viewReason: room.viewReason || null,
      },
      game: room.game ? G.viewFor(room.game, you) : null,
    });
    persist();
    scheduleBots();
  }

  function scheduleBots() {
    if (botTimer || !room || !room.game || room.botsPaused) return;
    let any = false;
    try { any = room.seats.some((s, i) => s.bot && Bot.decide(room.game, i, true)); } catch (e) { return botFailed(e); }
    if (!any) return;
    botTimer = setTimeout(() => {
      botTimer = null;
      if (!room || !room.game) return;
      try {
        for (let i = 0; i < room.seats.length; i++) {
          if (!room.seats[i].bot) continue;
          const a = Bot.decide(room.game, i);
          if (!a) continue;
          const r = G.act(room.game, i, a);
          if (r.ok) room.botFails = 0;
          else if (room.game.turn !== i || !G.act(room.game, i, { type: 'endTurn' }).ok) botFailed(new Error(r.error));
          break;
        }
      } catch (e) { botFailed(e); }
      broadcast();
    }, BOT_DELAY);
  }
  function botFailed(e) {
    console.warn('Bot-Fehler:', e && e.message);
    room.botFails = (room.botFails || 0) + 1;
    if (room.botFails >= 3) room.botsPaused = true;
  }

  function seatsFromGame(g) {
    return g.players.map(p => ({ name: p.name, bot: p.bot, color: p.color }));
  }

  function handle(m) {
    if (!m || typeof m !== 'object') return;
    if ((m.t === 'create' || m.t === 'load') && typeof m.code === 'string') {
      Position.decode(m.code)
        .then((state) => handle({ ...m, code: undefined, state }))
        .catch((e) => err((e && e.message) || 'Ungültiger Stellungscode.'));
      return;
    }
    if (m.t === 'positionCode') {
      if (!room || !room.game) return err('Noch kein Spiel gestartet.');
      Position.encode(room.game).then((code) => emit({ t: 'positionCode', code })).catch(() => err('Code konnte nicht erzeugt werden.'));
      return;
    }
    switch (m.t) {
      case 'create': {
        const name = cleanName(m.name) || 'Spieler 1';
        if (room && room.game && room.game.phase !== 'ended' && !confirm('Es gibt bereits ein lokales Spiel auf diesem Gerät. Überschreiben?')) {
          return err('Abgebrochen – öffne das bestehende Spiel über „Lokales Spiel fortsetzen“.');
        }
        const scenario = maps.SCENARIOS[m.scenario] ? m.scenario : 'classic';
        room = {
          name: cleanName(m.roomName) || 'Lokales Spiel',
          options: { scenario, vpTarget: Number(m.vpTarget) || maps.SCENARIOS[scenario].vp },
          seats: [{ name, bot: false, color: COLORS[0] }], game: null, chat: [], viewer: 0,
        };
        if (m.state) {
          try {
            room.game = G.validateLoaded(m.state);
            room.seats = seatsFromGame(room.game);
            room.options = { scenario: room.game.scenario.key, vpTarget: room.game.scenario.vpTarget };
          } catch (e) { room = null; return err(e.message || 'Spielstand ungültig.'); }
        }
        emit({ t: 'joined', room: ROOM_ID, token: 'local', seat: 0 });
        return broadcast();
      }
      case 'join':
        if (!room) return err('Kein lokales Spiel gespeichert.');
        emit({ t: 'joined', room: ROOM_ID, token: 'local', seat: room.viewer || 0 });
        return broadcast();
      case 'leave':
        clearTimeout(botTimer); botTimer = null;
        return emit({ t: 'left' });
      case 'chat': {
        const text = String(m.text || '').slice(0, 300).trim();
        if (!text || !room) return;
        const s = room.seats[room.viewer] || { name: '?', color: '#999' };
        room.chat.push({ from: s.name, color: s.color, text, at: Date.now() });
        return broadcast();
      }
      case 'action': {
        if (!room || !room.game) return err('Das Spiel hat noch nicht begonnen.');
        const seat = room.viewer;
        if (seat === null || seat === undefined) return err('Kein menschlicher Spieler am Tisch.');
        const r = G.act(room.game, seat, m.action || {});
        if (!r.ok) err(r.error);
        else { room.botsPaused = false; room.botFails = 0; }
        return broadcast();
      }
      case 'export':
        if (!room || !room.game) return err('Noch kein Spiel gestartet.');
        return emit({ t: 'export', state: room.game, name: room.name });
    }
    if (!room) return err('Kein lokales Spiel.');
    switch (m.t) {
      case 'options':
        if (room.game) return err('Das Spiel läuft bereits.');
        if (m.scenario && maps.SCENARIOS[m.scenario]) {
          if (room.options.scenario !== m.scenario) room.options.vpTarget = maps.SCENARIOS[m.scenario].vp;
          room.options.scenario = m.scenario;
        }
        if (m.vpTarget) room.options.vpTarget = Math.max(3, Math.min(30, Number(m.vpTarget) || 10));
        return broadcast();
      case 'addBot': case 'addHuman': {
        if (room.game) return err('Das Spiel läuft bereits.');
        if (room.seats.length >= 6) return err('Maximal 6 Spieler.');
        const color = COLORS.find(c => !room.seats.some(s => s.color === c)) || COLORS[0];
        if (m.t === 'addBot') {
          const names = ['Ada', 'Bruno', 'Clara', 'Dieter', 'Erna', 'Fritz'];
          const n = names.find(x => !room.seats.some(s => s.name === x + ' (Bot)')) || 'Bot';
          room.seats.push({ name: n + ' (Bot)', bot: true, color });
        } else {
          const name = cleanName(m.name) || `Spieler ${room.seats.length + 1}`;
          room.seats.push({ name, bot: false, color });
        }
        return broadcast();
      }
      case 'kick': {
        const i = Number(m.seat);
        if (room.game || !room.seats[i] || room.seats.filter(s => !s.bot).length <= 1 && !room.seats[i].bot) return err('Ungültig.');
        room.seats.splice(i, 1);
        return broadcast();
      }
      case 'toggleBot': {
        const i = Number(m.seat);
        const s = room.seats[i];
        if (!s) return err('Ungültig.');
        if (!s.bot && room.seats.filter(x => !x.bot).length <= 1) return err('Mindestens ein Mensch muss mitspielen.');
        s.bot = !s.bot;
        if (room.game) room.game.players[i].bot = s.bot;
        return broadcast();
      }
      case 'color': {
        const i = Number(m.seat);
        if (!room.seats[i] || !COLORS.includes(m.color)) return err('Ungültig.');
        room.seats[i].color = m.color;
        if (room.game) room.game.players[i].color = m.color;
        return broadcast();
      }
      case 'start': {
        if (room.game && room.game.phase !== 'ended') return err('Das Spiel läuft bereits.');
        const sc = maps.SCENARIOS[room.options.scenario];
        if (room.seats.length > sc.maxPlayers) return err(`Dieses Szenario ist für höchstens ${sc.maxPlayers} Spieler.`);
        if (!m.keepOrder) maps.shuffle(room.seats);
        room.game = G.newGame({
          scenario: room.options.scenario, vpTarget: room.options.vpTarget,
          players: room.seats.map(s => ({ name: s.name, color: s.color, bot: s.bot })),
        });
        room.botsPaused = false;
        return broadcast();
      }
      case 'load':
        try {
          room.game = G.validateLoaded(m.state);
          room.seats = seatsFromGame(room.game);
          if (!room.seats.some(s => !s.bot)) { room.seats[0].bot = false; room.game.players[0].bot = false; }
          room.options = { scenario: room.game.scenario.key, vpTarget: room.game.scenario.vpTarget };
          return broadcast();
        } catch (e) { return err(e.message || 'Spielstand ungültig.'); }
      case 'reset':
        room.game = null;
        return broadcast();
      case 'deleteRoom':
        clearTimeout(botTimer); botTimer = null;
        room = null;
        persist();
        return emit({ t: 'kicked', msg: 'Das lokale Spiel wurde gelöscht.' });
      default:
        return err('Im Offline-Modus nicht verfügbar.');
    }
  }

  window.LocalServer = {
    // Liefert ein Objekt, das sich wie ein WebSocket verhält
    socket() {
      restore();
      sock = { readyState: 1, send: (raw) => handle(JSON.parse(raw)), onopen: null, onmessage: null, onclose: null };
      setTimeout(() => sock.onopen && sock.onopen(), 0);
      return sock;
    },
    info() {
      return { scenarios: maps.listScenarios(), passwordRequired: false, roomList: true, local: true };
    },
    rooms() {
      if (!room) return [];
      const sc = maps.SCENARIOS[room.options.scenario];
      return [{
        id: ROOM_ID, name: room.name + ' (auf diesem Gerät)', scenario: sc ? sc.name : '',
        players: room.seats.map(s => s.name), started: !!room.game, ended: !!(room.game && room.game.phase === 'ended'),
      }];
    },
  };
})();
