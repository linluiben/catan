#!/usr/bin/env node
'use strict';
// Baut die statische Offline-Version (z. B. für GitHub Pages) nach dist/.
// Die Spiel-Engine (server/maps.js, game.js, bot.js) ist reines JavaScript und läuft
// unverändert im Browser; sie wird mit einem winzigen CommonJS-Lader gebündelt.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, process.argv[2] || 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const f of ['app.js', 'style.css', 'local.js']) {
  fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
}

const modules = ['maps', 'game', 'bot', 'position'];
let bundle = '/* Inselreich-Engine – automatisch gebündelt aus server/*.js */\n(function () {\n  const defs = {};\n';
for (const m of modules) {
  const src = fs.readFileSync(path.join(root, 'server', m + '.js'), 'utf8');
  if (/require\((?!'\.\/(maps|game|bot|position)')/.test(src)) throw new Error(`${m}.js benutzt ein Node-Modul und kann nicht in den Browser`);
  bundle += `  defs['./${m}'] = function (module, exports, require) {\n${src}\n  };\n`;
}
bundle += `  const cache = {};
  function req(name) {
    if (cache[name]) return cache[name].exports;
    if (!defs[name]) throw new Error('Modul nicht gefunden: ' + name);
    const module = { exports: {} };
    cache[name] = module;
    defs[name](module, module.exports, req);
    return module.exports;
  }
  window.InselreichEngine = { maps: req('./maps'), G: req('./game'), Bot: req('./bot'), Position: req('./position') };
})();
`;
fs.writeFileSync(path.join(out, 'engine.js'), bundle);

let html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
if (!html.includes('<script src="app.js"></script>')) throw new Error('index.html: app.js-Einbindung nicht gefunden');
html = html.replace('<script src="app.js"></script>',
  '<script src="engine.js"></script>\n  <script src="local.js"></script>\n  <script src="app.js"></script>');
html = html.replace('<title>Inselreich</title>', '<title>Inselreich (Offline)</title>');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('Statische Version gebaut:', path.relative(root, out));
