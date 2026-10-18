// Pac-Man Online - servidor autoritativo (Node.js + WebSocket)
// El anfitrión controla a Pac-Man; cada invitado controla un fantasma (máx. 4).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* opcional */ }

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // ej: https://mi-pacman.onrender.com

// ---------- Correo (opcional) ----------
let mailer = null;
if (nodemailer && process.env.SMTP_HOST) {
  const port = Number(process.env.SMTP_PORT || 465);
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

// ---------- Mapa (nivel 1 clásico, 28x31) ----------
const MAZE = [
  '############################',
  '#............##............#',
  '#.####.#####.##.#####.####.#',
  '#o####.#####.##.#####.####o#',
  '#.####.#####.##.#####.####.#',
  '#..........................#',
  '#.####.##.########.##.####.#',
  '#.####.##.########.##.####.#',
  '#......##....##....##......#',
  '######.##### ## #####.######',
  '     #.##### ## #####.#     ',
  '     #.##          ##.#     ',
  '     #.## ###--### ##.#     ',
  '######.## #      # ##.######',
  '      .   #      #   .      ',
  '######.## #      # ##.######',
  '     #.## ######## ##.#     ',
  '     #.##          ##.#     ',
  '     #.## ######## ##.#     ',
  '######.## ######## ##.######',
  '#............##............#',
  '#.####.#####.##.#####.####.#',
  '#.####.#####.##.#####.####.#',
  '#o..##.......  .......##..o#',
  '###.##.##.########.##.##.###',
  '###.##.##.########.##.##.###',
  '#......##....##....##......#',
  '#.##########.##.##########.#',
  '#.##########.##.##########.#',
  '#..........................#',
  '############################',
];
const W = 28, H = 31;
const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
const COLORS = ['#ff0000', '#ffb8ff', '#00ffff', '#ffb852'];
const GHOST_SPAWNS = [[13, 11], [11, 14], [13, 14], [16, 14]];
const GHOST_HOUSE = [13, 14];
const PAC_SPAWN = [13, 23];

const PAC_SPEED = 7.6, PAC_SPEED_FRIGHT = 8.4;
const GHOST_SPEED = 7.1, GHOST_SPEED_FRIGHT = 4.6;
const FRIGHT_TIME = 6, EATEN_RESPAWN_MS = 3000;
const TICK_MS = 1000 / 30;

function tile(x, y) {
  x = ((x % W) + W) % W;
  if (y < 0 || y >= H) return '#';
  return MAZE[y][x];
}
function canMove(cx, cy, dir, isPac) {
  const d = DIRS[dir];
  const t = tile(cx + d.x, cy + d.y);
  if (t === '#') return false;
  if (t === '-' && isPac) return false; // Pac-Man no entra a la casa de los fantasmas
  return true;
}

// Movimiento por casillas con posición fraccionaria (suave)
function move(e, speed, dt, isPac) {
  let dist = speed * dt;
  if (e.next && e.dir && e.next === OPP[e.dir]) e.dir = e.next; // reversa inmediata
  let guard = 0;
  while (dist > 1e-9 && guard++ < 8) {
    const cx = Math.round(e.x), cy = Math.round(e.y);
    const atCenter = Math.abs(e.x - cx) < 1e-6 && Math.abs(e.y - cy) < 1e-6;
    if (atCenter) {
      e.x = cx; e.y = cy;
      if (e.next && canMove(cx, cy, e.next, isPac)) e.dir = e.next;
      if (!e.dir || !canMove(cx, cy, e.dir, isPac)) { e.dir = null; return; }
    }
    if (!e.dir) return;
    const d = DIRS[e.dir];
    let toNext;
    if (atCenter) toNext = 1;
    else if (d.x > 0) toNext = Math.ceil(e.x) - e.x;
    else if (d.x < 0) toNext = e.x - Math.floor(e.x);
    else if (d.y > 0) toNext = Math.ceil(e.y) - e.y;
    else toNext = e.y - Math.floor(e.y);
    const m = Math.min(dist, toNext);
    e.x += d.x * m; e.y += d.y * m; dist -= m;
    if (m >= toNext - 1e-9) { e.x = Math.round(e.x); e.y = Math.round(e.y); }
    // túnel lateral
    if (e.x < -0.5) e.x += W; else if (e.x > W - 0.5) e.x -= W;
  }
}

// ---------- Salas ----------
const rooms = new Map();
function makeCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => a[(Math.random() * a.length) | 0]).join(''); } while (rooms.has(c));
  return c;
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function freshPellets() {
  const pel = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = MAZE[y][x];
    pel.push(c === '.' || c === 'o' ? c : '_');
  }
  return pel;
}
function createRoom(ws, name) {
  const code = makeCode();
  const room = {
    code, token: crypto.randomBytes(16).toString('hex'),
    host: ws, hostName: name || 'Pac-Man',
    ghosts: [], state: 'lobby', winner: null,
    pel: freshPellets(), pelLeft: 0, pelDirty: true,
    score: 0, lives: 3, fright: 0, combo: 0,
    pac: { x: PAC_SPAWN[0], y: PAC_SPAWN[1], dir: null, next: null },
    readyUntil: 0, pauseUntil: 0, invites: 0, last: Date.now(),
  };
  room.interval = setInterval(() => tick(room), TICK_MS);
  rooms.set(code, room);
  return room;
}
function lobbyMsg(room) {
  return {
    t: 'lobby', room: room.code, state: room.state,
    host: room.hostName,
    players: room.ghosts.map(g => ({ id: g.id, name: g.name, color: g.color })),
  };
}
function broadcast(room, obj) {
  send(room.host, obj);
  room.ghosts.forEach(g => send(g.ws, obj));
}
function resetPositions(room) {
  room.pac.x = PAC_SPAWN[0]; room.pac.y = PAC_SPAWN[1]; room.pac.dir = null; room.pac.next = null;
  room.ghosts.forEach(g => {
    const [sx, sy] = GHOST_SPAWNS[g.slot];
    g.x = sx; g.y = sy; g.dir = null; g.next = null; g.eaten = false; g.fr = false;
  });
  room.fright = 0;
}
function startGame(room) {
  room.pel = freshPellets();
  room.pelLeft = room.pel.filter(c => c === '.' || c === 'o').length;
  room.pelDirty = true;
  room.score = 0; room.lives = 3; room.winner = null; room.combo = 0;
  resetPositions(room);
  room.state = 'ready';
  room.readyUntil = Date.now() + 3000;
  room.last = Date.now();
}
function endGame(room, winner) {
  room.state = 'over';
  room.winner = winner;
}

function tick(room) {
  const now = Date.now();
  const dt = Math.min((now - room.last) / 1000, 0.1);
  room.last = now;

  if (room.state === 'ready') {
    if (now >= room.readyUntil) room.state = 'playing';
  } else if (room.state === 'dying') {
    if (now >= room.pauseUntil) {
      if (room.lives <= 0) endGame(room, 'ghosts');
      else { resetPositions(room); room.state = 'ready'; room.readyUntil = now + 2000; }
    }
  } else if (room.state === 'playing') {
    update(room, dt, now);
  }

  if (room.state !== 'lobby') {
    const r2 = n => Math.round(n * 100) / 100;
    const msg = {
      t: 'state', s: room.state, score: room.score, lives: room.lives,
      fright: room.fright > 0 ? Math.ceil(room.fright * 10) / 10 : 0,
      winner: room.winner,
      pac: { x: r2(room.pac.x), y: r2(room.pac.y), d: room.pac.dir },
      g: room.ghosts.map(g => ({ id: g.id, n: g.name, c: g.color, x: r2(g.x), y: r2(g.y), d: g.dir, fr: g.fr, e: g.eaten })),
    };
    if (room.pelDirty) { msg.pel = room.pel.join(''); room.pelDirty = false; }
    broadcast(room, msg);
  }
}

function update(room, dt, now) {
  const pac = room.pac;
  move(pac, room.fright > 0 ? PAC_SPEED_FRIGHT : PAC_SPEED, dt, true);

  // comer pellets
  const px = Math.round(pac.x), py = Math.round(pac.y);
  if (Math.abs(pac.x - px) < 0.45 && Math.abs(pac.y - py) < 0.45) {
    const idx = py * W + (((px % W) + W) % W);
    const c = room.pel[idx];
    if (c === '.' || c === 'o') {
      room.pel[idx] = '_'; room.pelLeft--; room.pelDirty = true;
      if (c === '.') room.score += 10;
      else {
        room.score += 50; room.fright = FRIGHT_TIME; room.combo = 0;
        room.ghosts.forEach(g => { if (!g.eaten) g.fr = true; });
      }
    }
  }
  if (room.pelLeft <= 0) { endGame(room, 'pacman'); return; }

  // temporizador de susto
  if (room.fright > 0) {
    room.fright -= dt;
    if (room.fright <= 0) { room.fright = 0; room.ghosts.forEach(g => (g.fr = false)); }
  }

  // fantasmas
  for (const g of room.ghosts) {
    if (g.eaten) {
      if (now >= g.respawnAt) { g.eaten = false; g.fr = false; }
      continue;
    }
    move(g, g.fr ? GHOST_SPEED_FRIGHT : GHOST_SPEED, dt, false);
  }

  // colisiones
  for (const g of room.ghosts) {
    if (g.eaten) continue;
    if (Math.hypot(g.x - pac.x, g.y - pac.y) < 0.7) {
      if (g.fr) {
        g.eaten = true; g.fr = false; g.respawnAt = now + EATEN_RESPAWN_MS;
        g.x = GHOST_HOUSE[0]; g.y = GHOST_HOUSE[1]; g.dir = null; g.next = null;
        room.combo++;
        room.score += 200 * Math.pow(2, Math.min(room.combo - 1, 3));
      } else {
        room.lives--;
        room.state = 'dying';
        room.pauseUntil = now + 2000;
        room.fright = 0;
        room.ghosts.forEach(o => (o.fr = false));
        return;
      }
    }
  }
}

// ---------- WebSocket ----------
function findSlot(room) {
  for (let i = 0; i < 4; i++) if (!room.ghosts.some(g => g.slot === i)) return i;
  return -1;
}
function cleanName(n, fallback) {
  n = String(n || '').replace(/[<>]/g, '').trim().slice(0, 14);
  return n || fallback;
}

function onConnection(ws) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.ctx = null; // { room, role, ghost }

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'create' && !ws.ctx) {
      const room = createRoom(ws, cleanName(m.name, 'Pac-Man'));
      ws.ctx = { room, role: 'pacman' };
      send(ws, { t: 'init', role: 'pacman', room: room.code, token: room.token, maze: MAZE });
      send(ws, lobbyMsg(room));
      return;
    }

    if (m.t === 'join' && !ws.ctx) {
      const room = rooms.get(String(m.room || '').toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'La sala no existe o ya se cerró.' });
      if (room.state !== 'lobby' && room.state !== 'over') return send(ws, { t: 'error', msg: 'La partida ya empezó. Pide al anfitrión que reinicie.' });
      const slot = findSlot(room);
      if (slot < 0) return send(ws, { t: 'error', msg: 'La sala está llena (máx. 4 fantasmas).' });
      const g = {
        ws, id: crypto.randomBytes(4).toString('hex'), slot, color: COLORS[slot],
        name: cleanName(m.name, 'Fantasma' + (slot + 1)),
        x: GHOST_SPAWNS[slot][0], y: GHOST_SPAWNS[slot][1], dir: null, next: null, eaten: false, fr: false, respawnAt: 0,
      };
      room.ghosts.push(g);
      ws.ctx = { room, role: 'ghost', ghost: g };
      send(ws, { t: 'init', role: 'ghost', id: g.id, color: g.color, room: room.code, maze: MAZE });
      if (room.state === 'over') { room.state = 'lobby'; room.winner = null; }
      broadcast(room, lobbyMsg(room));
      return;
    }

    if (!ws.ctx) return;
    const { room, role, ghost } = ws.ctx;

    if (m.t === 'input' && DIRS[m.dir]) {
      if (role === 'pacman') room.pac.next = m.dir;
      else if (ghost) ghost.next = m.dir;
      return;
    }
    if (m.t === 'start' && role === 'pacman') {
      if (room.state !== 'lobby' && room.state !== 'over') return;
      if (room.ghosts.length < 1) return send(ws, { t: 'error', msg: 'Necesitas al menos 1 fantasma para empezar.' });
      startGame(room);
      return;
    }
    if (m.t === 'lobby' && role === 'pacman' && room.state === 'over') {
      room.state = 'lobby'; room.winner = null;
      broadcast(room, lobbyMsg(room));
    }
  });

  ws.on('close', () => {
    if (!ws.ctx) return;
    const { room, role, ghost } = ws.ctx;
    if (role === 'pacman') {
      broadcast(room, { t: 'closed' });
      clearInterval(room.interval);
      rooms.delete(room.code);
    } else {
      room.ghosts = room.ghosts.filter(g => g !== ghost);
      if (room.ghosts.length === 0 && room.state !== 'lobby') { room.state = 'lobby'; room.winner = null; }
      broadcast(room, lobbyMsg(room));
    }
  });
}

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function handleInvite(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
  req.on('end', async () => {
    try {
      const { room: code, token, emails } = JSON.parse(body);
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room || room.token !== token) return json(res, 403, { ok: false, message: 'No autorizado.' });
      const list = [...new Set((Array.isArray(emails) ? emails : [])
        .map(e => String(e).trim())
        .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 8);
      if (!list.length) return json(res, 400, { ok: false, message: 'No hay correos válidos.' });
      if (room.invites + list.length > 20) return json(res, 429, { ok: false, message: 'Límite de invitaciones alcanzado.' });

      const link = `${baseUrl(req)}/?room=${room.code}`;
      if (!mailer) {
        return json(res, 200, { ok: true, mailto: true, link, emails: list,
          message: 'El servidor no tiene SMTP configurado; se abrirá tu app de correo.' });
      }
      room.invites += list.length;
      const subject = `${room.hostName} te invita a cazar a Pac-Man 👻`;
      for (const to of list) {
        await mailer.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to, subject,
          text: `${room.hostName} te invitó a jugar Pac-Man Online como fantasma.\n\nEntra aquí: ${link}\n\nCódigo de sala: ${room.code}`,
          html: `<p><b>${room.hostName.replace(/[<>&]/g, '')}</b> te invitó a jugar <b>Pac-Man Online</b> como fantasma 👻</p>
                 <p><a href="${link}" style="background:#ffd800;color:#000;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Unirme a la partida</a></p>
                 <p>Código de sala: <b>${room.code}</b></p>`,
        });
      }
      json(res, 200, { ok: true, message: `Invitaciones enviadas a ${list.length} correo(s).` });
    } catch (e) {
      console.error(e);
      json(res, 500, { ok: false, message: 'Error al enviar las invitaciones.' });
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/invite') return handleInvite(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end('No encontrado');
});

const wss = new WebSocketServer({ server });
wss.on('connection', onConnection);
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 25000);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Pac-Man Online en http://localhost:${PORT}  (SMTP: ${mailer ? 'sí' : 'no'})`));
}
module.exports = { MAZE, move, tile, canMove, createRoom, startGame, tick, rooms };
