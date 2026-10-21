/*
 * GLOBO CENITAL - SERVIDOR (punto de entrada)
 * ------------------------------------------------------------------
 * Solo HTTP (sin WebSockets) y sin librerías externas. Solo hace falta Node.js.
 *
 * Estructura:
 *   server.js   -> este archivo: servidor HTTP (reparte la web y recibe la API)
 *   private/    -> lógica del juego. NUNCA se envía al navegador.
 *   public/     -> lo que descarga el navegador (html, css, js del cliente)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PORT } = require('./private/config');
const { api } = require('./private/api');
const { parseCookies } = require('./private/game');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  // Identificamos al jugador con una cookie "pid" (se crea en la primera visita)
  const headers = {};
  let pid = parseCookies(req.headers.cookie).pid;
  if (!pid) {
    pid = crypto.randomBytes(8).toString('hex');
    headers['Set-Cookie'] = `pid=${pid}; Path=/; HttpOnly; SameSite=Lax`;
  }
  const url = req.url.split('?')[0];

  // ---- API del juego (POST /api/...) ----
  if (req.method === 'POST' && url.startsWith('/api/')) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 2000) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { /* cuerpo inválido: lo tratamos como vacío */ }
      const result = api(url.slice(5), pid, body, Date.now());
      res.writeHead(result ? 200 : 404, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result || { err: 'no existe' }));
    });
    return;
  }

  // ---- Archivos estáticos: SOLO desde la carpeta public ----
  let urlPath;
  try { urlPath = decodeURIComponent(url); } catch (e) { res.writeHead(400); return res.end('400'); }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {   // protege contra rutas tipo /../server.js
    res.writeHead(403); return res.end('403');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Juego en http://localhost:' + PORT));
