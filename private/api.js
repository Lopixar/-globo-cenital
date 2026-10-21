/*
 * API (carpeta private): traduce las peticiones HTTP del navegador a acciones del juego.
 *   join -> entrar en sala | act -> acciones inmediatas | sync -> polling de estado
 */
const { SPAWN } = require('./config');
const { sessions, getRoom, roomChanged, roomInfo, newRound, hit, shove, dash, leave, clamp } = require('./game');

// ============================== API HTTP ==============================

/** Procesa una petición /api/<name>. Devuelve el objeto de respuesta. */
function api(name, pid, body, now) {

  // ---- Entrar en una sala ----
  if (name === 'join') {
    const roomId = String(body.room || 'sala').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'sala';
    let session = sessions.get(pid);
    if (session && session.room.id !== roomId) { // estaba en otra sala: sale de ella
      leave(session.room, session.player);
      session = null;
    }
    if (!session) {
      const room = getRoom(roomId);
      const slot = room.players.findIndex((p) => !p);
      if (slot < 0) return { err: 'Sala llena (máximo 4 jugadores)' };
      const player = {
        pid, slot,
        name: String(body.name || 'Jugador').slice(0, 12),
        score: 0,
        alive: room.state === 'lobby',   // si entra a media partida, espera a la siguiente ronda
        x: SPAWN[slot][0], y: SPAWN[slot][1],
        dx: 0, dy: 0,                    // dirección que pulsa
        pushX: 0, pushY: 0,              // impulso por empujones
        rtt: 0,                          // latencia medida por el cliente
        dashUntil: 0, dashReadyAt: 0,    // dash: hasta cuándo dura y cuándo vuelve a estar listo
        dashDx: 0, dashDy: 0,            // dirección del dash en curso
        faceX: 0, faceY: 1,              // última dirección de movimiento (para hacer dash estando parado)
        shoveAt: 0,                      // último empujón
        seen: now,                       // última petición recibida
        inputSeq: 0,                     // último nº de secuencia de movimiento
      };
      room.players[slot] = player;
      session = { room, player };
      sessions.set(pid, session);
      roomChanged(room);
    }
    session.player.seen = now;
    return { slot: session.player.slot, room: session.room.id };
  }

  // Todo lo demás requiere haber entrado antes
  const session = sessions.get(pid);
  if (!session) return { err: 'sin sesión' };
  const { room, player } = session;
  player.seen = now;

  // ---- Acciones inmediatas ----
  if (name === 'act') {
    if (body.k === 'in') {
      // "n" evita que una petición antigua que llega tarde pise a otra más nueva
      if ((+body.n || 0) > player.inputSeq) {
        player.inputSeq = +body.n;
        const x = +body.dx || 0, y = +body.dy || 0;
        const len = Math.hypot(x, y);
        player.dx = len ? x / len : 0;   // dirección normalizada (diagonal no va más rápido)
        player.dy = len ? y / len : 0;
        if (len) { player.faceX = player.dx; player.faceY = player.dy; } // recuerda hacia dónde mira
      }
    } else if (body.k === 'dash') {
      dash(room, player, now);
    } else if (body.k === 'shove') {
      shove(room, player, now);
    } else if (body.k === 'hit') {
      hit(room, player, body.p, +body.t || now, now);
    } else if (body.k === 'start') {
      if (room.state === 'lobby' && room.players.filter(Boolean).length >= 2) newRound(room);
    }
    return {};
  }

  // ---- Polling: estado nuevo desde la última vez ----
  if (name === 'sync') {
    player.rtt = clamp(+body.r || 0, 0, 5000);      // el cliente nos cuenta su latencia
    const reply = {
      s: now,                                                          // hora del servidor (para sincronizar relojes)
      rv: room.roomVersion,
      snaps: room.snapshots.filter((x) => x.q > (+body.q || 0)),       // solo los que faltan
      evs: room.events.filter((x) => x.id > (+body.ev || 0)),
    };
    if (body.rv !== room.roomVersion) reply.room = roomInfo(room);     // info de sala solo si cambió
    return reply;
  }

  return null;
}

module.exports = { api };
