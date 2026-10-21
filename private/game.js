/*
 * LÓGICA DEL JUEGO (carpeta private): salas, jugadores, física y reglas.
 * No sabe nada de HTTP: solo mantiene el estado y lo hace avanzar.
 */
const {
  ARENA_W,
  ARENA_H,
  PLAYER_R,
  BALL_R,
  PLAYER_SPEED,
  SPAWN,
  GRAVITY,
  REACH_Z,
  HIT_DIST,
  GROUND_GRACE,
  REWIND_MAX,
  SHOVE_COOLDOWN,
  IDLE_TIMEOUT,
  SERVE_TIMEOUT,
  ROUND_END_PAUSE,
  DASH_SPEED,
  DASH_TIME,
  DASH_COOLDOWN,
} = require('./config');

// ============================== ESTADO ================================
const rooms = new Map();      // id de sala -> sala
const sessions = new Map();   // pid (cookie) -> { room, player }

/** Crea la sala si no existe y la devuelve. */
function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      players: [null, null, null, null], // la plaza (0-3) marca el orden de turno
      state: 'lobby',                    // 'lobby' | 'playing' | 'over'
      message: 'Esperando jugadores (mínimo 2)',
      turn: 0,                           // plaza del jugador al que le toca golpear
      mode: 'serve',                     // 'serve' (en el suelo) | 'fly' (en el aire) | 'ground' (acaba de caer)
      ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
      history: [],                       // posiciones recientes de la bola (para compensar latencia)
      rally: 0,                          // golpes seguidos
      serveAt: 0,
      groundAt: 0,
      overAt: 0,
      lastStarter: -1,
      snapshots: [], snapSeq: 0,         // últimos estados enviados a los clientes
      events: [], eventId: 0,            // últimos eventos (golpe, empujón, eliminado...)
      roomVersion: 0,                    // sube cuando cambia la info de sala
    });
  }
  return rooms.get(id);
}

// ============================ UTILIDADES ==============================
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** Convierte la cabecera Cookie en un objeto { nombre: valor }. */
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) out[key] = rest.join('=');
  });
  return out;
}

const alivePlayers = (room) => room.players.filter((p) => p && p.alive);

/** Siguiente plaza con un jugador vivo después de "from" (en orden circular). */
function nextAlive(room, from) {
  for (let i = 1; i <= 4; i++) {
    const slot = (from + i + 4) % 4;
    const p = room.players[slot];
    if (p && p.alive) return slot;
  }
  return -1;
}

/** Datos "lentos" de la sala (nombres, victorias...). Solo se envían si cambian. */
function roomInfo(room) {
  return {
    id: room.id,
    state: room.state,
    message: room.message,
    players: room.players.map((p) => p && { name: p.name, wins: p.score, alive: p.alive }),
  };
}

/** Marca que la info de sala cambió: los clientes la pedirán en su próximo sync. */
function roomChanged(room) { room.roomVersion++; }

/** Guarda un evento para que todos los clientes lo reciban en su próximo sync. */
function emit(room, event) {
  event.id = ++room.eventId;
  room.events.push(event);
  if (room.events.length > 40) room.events.shift();
}

// ========================= LÓGICA DE LA PARTIDA =======================

/** Prepara un saque: la bola queda a los pies del jugador de la plaza "slot". */
function startServe(room, slot) {
  const p = room.players[slot];
  room.turn = slot;
  room.mode = 'serve';
  room.rally = 0;
  room.serveAt = Date.now();
  room.history = [];
  Object.assign(room.ball, { x: p.x, y: p.y, z: 0, vx: 0, vy: 0, vz: 0 });
}

/** Empieza una ronda nueva con todos los jugadores de la sala. */
function newRound(room) {
  room.players.forEach((p, i) => {
    if (!p) return;
    p.alive = true;
    p.x = SPAWN[i][0];
    p.y = SPAWN[i][1];
    p.pushX = p.pushY = 0;
    p.dashUntil = 0;
    p.dashReadyAt = 0;
  });
  room.state = 'playing';
  room.message = '';
  room.lastStarter = nextAlive(room, room.lastStarter); // saca uno distinto cada ronda
  startServe(room, room.lastStarter);
  roomChanged(room);
}

/** Tras una eliminación (o salida): ¿queda un ganador o seguimos con otro saque? */
function checkRoundEnd(room, fromSlot) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    room.state = 'over';
    room.overAt = Date.now();
    if (alive[0]) {
      alive[0].score++;
      room.message = alive[0].name + ' gana la ronda';
      emit(room, { type: 'win', slot: alive[0].slot });
    } else {
      room.message = 'Ronda sin ganador';
    }
  } else {
    // Saca de cero el siguiente jugador en el orden
    startServe(room, nextAlive(room, fromSlot));
  }
  roomChanged(room);
}

/** La bola cayó al suelo: queda eliminado el jugador al que le tocaba. */
function eliminateCurrent(room) {
  const slot = room.turn;
  room.players[slot].alive = false;
  emit(room, { type: 'out', slot });
  checkRoundEnd(room, slot);
}

// ======================== ACCIONES DE LOS JUGADORES ===================

/**
 * Golpe a la bola.
 *  power:  0..1, la fuerza elegida con la barra
 *  seenAt: instante (hora del servidor) que el jugador veía en pantalla al golpear
 *  now:    instante en que llega la petición
 *
 * COMPENSACIÓN DE LATENCIA: el jugador golpeó lo que veía hace un rato, así que
 * comprobamos la posición de la bola en ese instante (history), no la de ahora.
 */
function hit(room, player, power, seenAt, now) {
  // Conflicto: solo puede golpear a quien le toca
  if (room.state !== 'playing' || !player.alive || player.slot !== room.turn) return;

  if (room.mode !== 'serve') {
    const t = clamp(seenAt, now - REWIND_MAX, now);
    const past = room.history.find((h) => h.t >= t) || room.history[room.history.length - 1];
    if (!past) return;
    const dist = Math.hypot(past.x - player.x, past.y - player.y);
    // Debe estar debajo, la bola a altura alcanzable y bajando (vz <= 0)
    if (dist > HIT_DIST || past.z > REACH_Z || past.vz > 0) return;
  }

  power = clamp(+power || 0, 0, 1);                // nunca nos fiamos del cliente
  const angle = Math.random() * Math.PI * 2;
  const drift = 40 + Math.random() * 120;          // deriva horizontal aleatoria
  const b = room.ball;
  b.vz = 380 + power * 420;                        // más fuerza = más alto y más tiempo en el aire
  b.vx = Math.cos(angle) * drift + player.dx * PLAYER_SPEED * 0.3;
  b.vy = Math.sin(angle) * drift + player.dy * PLAYER_SPEED * 0.3;
  b.z = Math.max(b.z, 1);

  room.mode = 'fly';
  room.rally++;
  room.turn = nextAlive(room, player.slot);        // pasa el turno al siguiente
  emit(room, { type: 'hit', slot: player.slot, power });
}

/** Empujón: lanza a los jugadores cercanos lejos de quien empuja. */
function shove(room, player, now) {
  if (!player.alive || now - player.shoveAt < SHOVE_COOLDOWN) return;
  player.shoveAt = now;
  for (const other of room.players) {
    if (!other || other === player || !other.alive) continue;
    const dx = other.x - player.x;
    const dy = other.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 85) {
      other.pushX += (dx / (dist || 1)) * 650;
      other.pushY += (dy / (dist || 1)) * 650;
    }
  }
  emit(room, { type: 'shove', slot: player.slot });
}

/**
 * DASH: impulso rápido en la dirección en la que te mueves (o en la última dirección
 * en la que te moviste si estás parado). Tiene cooldown. Mientras dura (DASH_TIME),
 * la velocidad es DASH_SPEED. Las colisiones con otros jugadores siguen funcionando.
 */
function dash(room, player, now) {
  if (!player.alive || now < player.dashReadyAt) return;   // todavía en cooldown
  const moving = player.dx !== 0 || player.dy !== 0;
  player.dashDx = moving ? player.dx : player.faceX;
  player.dashDy = moving ? player.dy : player.faceY;
  player.dashUntil = now + DASH_TIME;
  player.dashReadyAt = now + DASH_COOLDOWN;
  emit(room, { type: 'dash', slot: player.slot });
}

/** Un jugador sale (o se desconecta). */
function leave(room, player) {
  const wasAlive = player.alive;
  room.players[player.slot] = null;
  sessions.delete(player.pid);
  const wasHisTurn = room.turn === player.slot;
  if (room.state === 'playing' && wasAlive && (wasHisTurn || alivePlayers(room).length <= 1)) {
    checkRoundEnd(room, player.slot);
  } else {
    roomChanged(room);
  }
}

// ============================ SIMULACIÓN ==============================

/** Avanza la sala "dt" segundos. */
function step(room, dt, now) {
  // 1) Desconectar a quien lleva demasiado sin hacer peticiones
  for (const p of room.players) {
    if (p && now - p.seen > IDLE_TIMEOUT) leave(room, p);
  }

  // 2) Fin de ronda: tras una pausa, nueva ronda o vuelta a la sala de espera
  if (room.state === 'over' && now - room.overAt > ROUND_END_PAUSE) {
    if (room.players.filter(Boolean).length >= 2) {
      newRound(room);
    } else {
      room.state = 'lobby';
      room.message = 'Esperando jugadores (mínimo 2)';
      roomChanged(room);
    }
  }

  // 3) Mover jugadores (dirección elegida + impulso de empujones que se va apagando)
  const alive = alivePlayers(room);
  for (const p of alive) {
    // Durante un dash la velocidad es la del dash; si no, la normal
    const dashing = now < p.dashUntil;
    const vx = dashing ? p.dashDx * DASH_SPEED : p.dx * PLAYER_SPEED;
    const vy = dashing ? p.dashDy * DASH_SPEED : p.dy * PLAYER_SPEED;
    p.x = clamp(p.x + (vx + p.pushX) * dt, PLAYER_R, ARENA_W - PLAYER_R);
    p.y = clamp(p.y + (vy + p.pushY) * dt, PLAYER_R, ARENA_H - PLAYER_R);
    const friction = Math.pow(0.02, dt);
    p.pushX *= friction;
    p.pushY *= friction;
  }

  // 4) Colisiones entre jugadores: si se solapan, se separan a partes iguales
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      if (dist < PLAYER_R * 2) {
        const overlap = (PLAYER_R * 2 - dist) / 2;
        dx /= dist; dy /= dist;
        a.x -= dx * overlap; a.y -= dy * overlap;
        b.x += dx * overlap; b.y += dy * overlap;
      }
    }
  }

  if (room.state !== 'playing') return;

  // 5) La bola
  const ball = room.ball;
  if (room.mode === 'serve') {
    // Espera a los pies de quien saca
    const server = room.players[room.turn];
    ball.x = server.x;
    ball.y = server.y;
    if (now - room.serveAt > SERVE_TIMEOUT) hit(room, server, 0.5, now, now);
  } else if (room.mode === 'fly') {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;
    ball.vz -= GRAVITY * dt;
    // Rebote en las paredes de la arena
    if (ball.x < BALL_R || ball.x > ARENA_W - BALL_R) { ball.vx *= -1; ball.x = clamp(ball.x, BALL_R, ARENA_W - BALL_R); }
    if (ball.y < BALL_R || ball.y > ARENA_H - BALL_R) { ball.vy *= -1; ball.y = clamp(ball.y, BALL_R, ARENA_H - BALL_R); }
    // Toca el suelo
    if (ball.z <= 0) {
      ball.z = 0;
      ball.vx = ball.vy = ball.vz = 0;
      room.mode = 'ground';
      room.groundAt = now;
    }
  } else if (now - room.groundAt > GROUND_GRACE) {
    // Pasó el margen para golpes con lag: queda eliminado quien tenía el turno
    eliminateCurrent(room);
  }

  // 6) Guardar la posición de la bola (1 segundo de historial)
  room.history.push({ t: now, x: ball.x, y: ball.y, z: ball.z, vz: ball.vz });
  while (room.history.length && room.history[0].t < now - 1000) room.history.shift();
}

/** Guarda una "foto" del estado. Cada cliente pedirá las que le falten. */
function takeSnapshot(room, now) {
  const b = room.ball;
  room.snapshots.push({
    q: ++room.snapSeq,                                     // número de secuencia
    t: now,                                                // hora del servidor
    b: [round1(b.x), round1(b.y), round1(b.z)],            // bola [x, y, altura]
    m: room.mode === 'serve' ? 0 : 1,                      // 0 = en el suelo esperando saque
    u: room.turn,                                          // de quién es el turno
    r: room.rally,                                         // golpes seguidos
    p: room.players.map((p) => p && [round1(p.x), round1(p.y), p.rtt | 0, Math.max(0, p.dashReadyAt - now) | 0]), // jugadores [x, y, latencia, ms hasta el próximo dash]
  });
  if (room.snapshots.length > 20) room.snapshots.shift();
}

// Bucle principal: simulación ~60 veces/s, snapshot cada 3 pasos (~20/s)
let lastTick = Date.now();
let tickCount = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;
  tickCount++;
  for (const room of rooms.values()) {
    if (!room.players.some(Boolean)) { rooms.delete(room.id); continue; } // sala vacía
    step(room, dt, now);
    if (tickCount % 3 === 0) takeSnapshot(room, now);
  }
}, 16);

module.exports = { rooms, sessions, getRoom, roomChanged, roomInfo, newRound, hit, shove, dash, leave, clamp, parseCookies };
