/* =====================================================================
 * GLOBO CENITAL - CLIENTE
 * Solo dibuja lo que dice el servidor y le envía lo que pulsa el jugador.
 * Toda la comunicación es HTTP con fetch (sin WebSockets).
 * ===================================================================== */

// ============================ CONSTANTES =============================
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const COLORS = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c']; // un color por plaza
const ARENA = 800;       // tamaño de la arena (igual que en el servidor)
const PLAYER_R = 22;
const BALL_R = 14;
const HIT_DIST = 60;     // igual que en el servidor: radio en el que se puede golpear
const REACH_Z = 170;     // igual que en el servidor: altura máxima de golpe
const RENDER_DELAY = 150; // dibujamos el pasado (150 ms) para poder interpolar suavemente
const DASH_COOLDOWN = 2500; // igual que en el servidor (ms): para dibujar la barra
const EFFECT_STYLE = {      // aspecto del anillo de cada evento
  hit:   { color: '#fff',    radius: 70 },
  shove: { color: '#ff922b', radius: 100 },
  dash:  { color: '#4dd4ff', radius: 55 },
};
const POLL_MS = 50;      // una petición de estado cada 50 ms

// ============================== ESTADO ===============================
let mySlot = -1;                        // mi plaza (-1 = aún no he entrado)
let room = { state: 'lobby', players: [], message: '' }; // info de sala (nombres, victorias...)
let roomVersion = -1;                   // versión de la info de sala que tengo
let snapshots = [];                     // últimos estados recibidos del servidor
let lastSnapSeq = 0, lastEventId = 0;   // lo último que he recibido (para pedir solo lo nuevo)
let firstSync = true;                   // en el primer sync ignoramos eventos antiguos

let clockOffset = 0;                    // diferencia entre el reloj del servidor y el mío
let rttSamples = [];                    // últimas medidas de latencia
let myRtt = 0;                          // mi latencia (ms) de la última petición

let keys = {};                          // teclas pulsadas
let lastDirection = '';                 // última dirección enviada (solo enviamos si cambia)
let inputSeq = 0;                       // nº de secuencia de los mensajes de movimiento
let chargeStart = 0;                    // instante en que empecé a cargar el golpe (0 = no cargo)

let toastText = '', toastAt = -1e9;     // mensaje temporal en pantalla
let effects = [];                       // anillos de golpe / empujón

// ============================== RED (HTTP) ===========================

/** POST con JSON a /api/<endpoint> y devuelve la respuesta ya convertida. */
function post(endpoint, data) {
  return fetch('/api/' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((r) => r.json());
}

/** Envía una acción inmediata (mover, golpear, empujar, empezar). */
function sendAction(action) {
  if (mySlot < 0) return;
  if (action.k === 'in') action.n = ++inputSeq; // número de secuencia para que el servidor ignore mensajes viejos
  post('act', action).catch(() => {});
}

/** Hora estimada del servidor ahora mismo. */
const serverNow = () => Date.now() + clockOffset;

/** Entrar en la sala. */
$('joinBtn').onclick = async () => {
  const reply = await post('join', {
    name: $('nameInput').value.trim() || 'Jugador',
    room: $('roomInput').value,
  });
  if (reply.err) return alert(reply.err);
  mySlot = reply.slot;
  $('roomTitle').textContent = 'Sala: ' + reply.room;
  updateOverlay();
  poll();
};

$('startBtn').onclick = () => sendAction({ k: 'start' });

/**
 * POLLING: pide al servidor lo nuevo cada ~50 ms (nunca dos peticiones a la vez).
 * Cada petición sirve también para medir la latencia (RTT).
 */
async function poll() {
  const t0 = Date.now();
  try {
    const reply = await post('sync', { q: lastSnapSeq, ev: lastEventId, rv: roomVersion, r: myRtt });
    const t1 = Date.now();
    if (reply.err) { alert('Sesión perdida. Recarga la página.'); return; }

    // Latencia y sincronización de reloj: nos quedamos con la muestra de menor RTT
    myRtt = t1 - t0;
    rttSamples.push({ rtt: myRtt, offset: reply.s + myRtt / 2 - t1 });
    if (rttSamples.length > 8) rttSamples.shift();
    clockOffset = rttSamples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;

    // Info de sala (solo llega si ha cambiado)
    if (reply.room) { room = reply.room; roomVersion = reply.rv; updateOverlay(); }

    // Estados nuevos
    for (const snap of reply.snaps) { snapshots.push(snap); lastSnapSeq = snap.q; }
    if (snapshots.length > 40) snapshots.splice(0, snapshots.length - 40);

    // Eventos nuevos (el primer sync trae eventos antiguos: los ignoramos)
    for (const ev of reply.evs) {
      lastEventId = ev.id;
      if (!firstSync) handleEvent(ev);
    }
    firstSync = false;
  } catch (e) { /* fallo puntual de red: reintentamos en el siguiente ciclo */ }

  setTimeout(poll, Math.max(0, POLL_MS - (Date.now() - t0)));
}

// ======================== EVENTOS E INTERFAZ =========================

function showToast(text) { toastText = text; toastAt = performance.now(); }

/** Reacciona a un evento del servidor. */
function handleEvent(ev) {
  const p = room.players[ev.slot];
  const name = p ? p.name : '?';
  if (ev.type === 'out') showToast(name + ' eliminado');
  else if (ev.type === 'win') showToast(name + ' gana la ronda');
  else {
    // golpe (blanco) o empujón (naranja): anillo que se expande
    effects.push({
      slot: ev.slot, start: performance.now(),
      color: EFFECT_STYLE[ev.type].color,
      radius: EFFECT_STYLE[ev.type].radius,
    });
  }
}

/** Muestra u oculta el formulario / la sala de espera según el estado. */
function updateOverlay() {
  $('overlay').classList.toggle('hidden', mySlot >= 0 && room.state !== 'lobby');
  $('joinBox').classList.toggle('hidden', mySlot >= 0);
  $('lobbyBox').classList.toggle('hidden', mySlot < 0);
  const count = room.players.filter(Boolean).length;
  $('lobbyInfo').textContent = count + '/4 jugadores. Comparte el código de sala.';
  $('startBtn').disabled = count < 2;
}

// ========================== INTERPOLACIÓN ============================
/**
 * Devuelve el estado que toca dibujar. Dibujamos el estado de hace RENDER_DELAY ms
 * mezclando los dos snapshots que lo rodean: así el movimiento es suave y todos
 * los jugadores ven lo mismo al mismo tiempo.
 */
function currentView() {
  if (!snapshots.length) return null;
  const renderTime = serverNow() - RENDER_DELAY;

  let i = snapshots.length - 1;
  while (i > 0 && snapshots[i].t > renderTime) i--;
  const a = snapshots[i], b = snapshots[i + 1];
  if (!b || renderTime <= a.t) return a;

  const k = Math.min(1, (renderTime - a.t) / (b.t - a.t));
  const lerp = (x, y) => x + (y - x) * k;
  return {
    ...a,
    // La bola solo se interpola si en ambos estados está en el aire (si no, "salta" de sitio)
    b: a.m === 1 && b.m === 1 ? a.b.map((v, j) => lerp(v, b.b[j])) : a.b,
    p: a.p.map((pa, j) => (pa && b.p[j] ? [lerp(pa[0], b.p[j][0]), lerp(pa[1], b.p[j][1]), pa[2], pa[3]] : pa)),
  };
}

// ============================= TECLADO ===============================

/** Fuerza del golpe (0..1): sube y baja mientras mantienes ESPACIO. */
function currentPower() {
  const t = ((performance.now() - chargeStart) / 1600) % 1;
  return 1 - Math.abs(1 - 2 * t);
}

/** Dirección según las teclas pulsadas: [-1..1, -1..1]. */
function currentDirection() {
  const x = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  const y = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
  return [x, y];
}

/** Envía la dirección solo cuando cambia (para no saturar con peticiones). */
function sendDirectionIfChanged() {
  const dir = currentDirection();
  const text = dir.join(',');
  if (text === lastDirection) return;
  lastDirection = text;
  sendAction({ k: 'in', dx: dir[0], dy: dir[1] });
}

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;                        // escribiendo el nombre
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'Space') chargeStart = performance.now();         // empieza a cargar el golpe
  if (e.code === 'KeyE') sendAction({ k: 'shove' });
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sendAction({ k: 'dash' }); // dash
  sendDirectionIfChanged();
});

addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Space' && chargeStart) {
    // Al soltar: golpe. Enviamos la fuerza y el instante que el jugador VEÍA en pantalla,
    // para que el servidor compense la latencia.
    sendAction({ k: 'hit', p: currentPower(), t: serverNow() - RENDER_DELAY });
    chargeStart = 0;
  }
  sendDirectionIfChanged();
});

// Si la ventana pierde el foco, soltamos todas las teclas
addEventListener('blur', () => { keys = {}; chargeStart = 0; sendDirectionIfChanged(); });

// ============================== DIBUJO ===============================

/** Suelo, cuadrícula y borde de la arena. */
function drawArena() {
  ctx.fillStyle = '#1c2b3a';
  ctx.fillRect(0, 0, ARENA, ARENA);
  ctx.strokeStyle = '#ffffff10';
  ctx.lineWidth = 1;
  for (let i = 0; i <= ARENA; i += 100) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i, ARENA);
    ctx.moveTo(0, i); ctx.lineTo(ARENA, i);
    ctx.stroke();
  }
  ctx.strokeStyle = '#8fa3b8';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, ARENA - 4, ARENA - 4);
}

/** Jugadores: círculo de color, nombre y, si es su turno, anillo de alcance. */
function drawPlayers(view, playing, now) {
  ctx.textAlign = 'center';
  ctx.font = '13px system-ui';
  view.p.forEach((p, slot) => {
    if (!p) return;
    const info = room.players[slot];
    ctx.globalAlpha = info && info.alive ? 1 : 0.3;     // eliminados / en espera: atenuados

    if (playing && view.u === slot) {                   // anillo discontinuo del jugador con el turno
      ctx.strokeStyle = COLORS[slot];
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p[0], p[1], HIT_DIST + Math.sin(now / 150) * 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = COLORS[slot];
    ctx.beginPath();
    ctx.arc(p[0], p[1], PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    if (slot === mySlot) {                              // borde blanco = yo
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.fillText(info ? info.name : '', p[0], p[1] - PLAYER_R - 6);
    ctx.globalAlpha = 1;
  });
}

/**
 * La bola. Vista cenital: cuanto más alta, más grande se ve (está más cerca de la cámara)
 * y su sombra, que marca dónde caerá, es más pequeña y se separa de la bola.
 */
function drawBall(view) {
  const [x, y, z] = view.b;
  const scale = 1 + z / 300;
  const owner = view.p[view.u];
  // ¿Puedo golpear ahora? (mi turno, estoy debajo y la bola está al alcance)
  const canHit = view.u === mySlot && owner &&
    (view.m === 0 || (Math.hypot(x - owner[0], y - owner[1]) <= HIT_DIST && z <= REACH_Z));

  // Sombra en el suelo
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.beginPath();
  ctx.arc(x + z * 0.08, y + z * 0.08, BALL_R * (1 - Math.min(z / 900, 0.5)), 0, Math.PI * 2);
  ctx.fill();

  // Bola (borde verde = puedes golpear)
  ctx.beginPath();
  ctx.arc(x, y, BALL_R * scale, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = canHit ? '#51cf66' : '#e03131';
  ctx.stroke();
}

/** Anillos que se expanden cuando alguien golpea o empuja. */
function drawEffects(view, now) {
  const DURATION = 350;
  effects = effects.filter((f) => now - f.start < DURATION);
  effects.forEach((f) => {
    const p = view.p[f.slot];
    if (!p) return;
    const progress = (now - f.start) / DURATION;
    ctx.strokeStyle = f.color;
    ctx.globalAlpha = 1 - progress;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(p[0], p[1], PLAYER_R + (f.radius - PLAYER_R) * progress, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  });
}

/** Barra de fuerza bajo mi jugador mientras mantengo ESPACIO. */
function drawPowerBar(view) {
  const me = view.p[mySlot];
  if (!chargeStart || !me) return;
  const power = currentPower();
  ctx.fillStyle = '#000a';
  ctx.fillRect(me[0] - 30, me[1] + PLAYER_R + 8, 60, 8);
  ctx.fillStyle = `hsl(${120 - power * 120} 80% 50%)`;   // verde (flojo) a rojo (fuerte)
  ctx.fillRect(me[0] - 30, me[1] + PLAYER_R + 8, 60 * power, 8);
}

/** Barra de cooldown del dash (abajo a la izquierda): llena = listo para usar. */
function drawDashIndicator(view) {
  const me = view.p[mySlot];
  if (!me || !room.players[mySlot] || !room.players[mySlot].alive) return;
  const remaining = me[3] || 0;                       // ms que faltan para poder volver a hacer dash
  const ready = remaining <= 0;
  const filled = 1 - Math.min(remaining / DASH_COOLDOWN, 1);
  ctx.textAlign = 'left';
  ctx.font = '13px system-ui';
  ctx.fillStyle = ready ? '#4dd4ff' : '#8fa3b8';
  ctx.fillText(ready ? 'Dash listo (MAYÚS)' : 'Dash...', 14, ARENA - 54);
  ctx.fillStyle = '#000a';
  ctx.fillRect(14, ARENA - 46, 120, 8);
  ctx.fillStyle = ready ? '#4dd4ff' : '#5c7893';
  ctx.fillRect(14, ARENA - 46, 120 * filled, 8);
}

/** Marcador, latencias, mensajes y ayuda. */
function drawHud(view, playing, now) {
  // Lista de jugadores arriba a la izquierda
  ctx.textAlign = 'left';
  ctx.font = '15px system-ui';
  view.p.forEach((p, slot) => {
    const info = room.players[slot];
    if (!info) return;
    ctx.globalAlpha = info.alive ? 1 : 0.4;
    ctx.fillStyle = COLORS[slot];
    const turnMark = playing && view.u === slot ? '▶ ' : '';
    const ping = p ? p[2] : 0;
    ctx.fillText(`${turnMark}${info.name}: ${info.wins} victorias, ${ping} ms${info.alive ? '' : ' (fuera)'}`, 14, 26 + slot * 22);
  });
  ctx.globalAlpha = 1;

  // Golpes seguidos arriba a la derecha
  ctx.fillStyle = '#e8eef6';
  ctx.textAlign = 'right';
  ctx.fillText('Toques seguidos: ' + view.r, ARENA - 14, 26);

  // Mensajes grandes
  ctx.textAlign = 'center';
  ctx.font = 'bold 26px system-ui';
  if (!playing && room.message) ctx.fillText(room.message, ARENA / 2, 70);
  if (now - toastAt < 2500) ctx.fillText(toastText, ARENA / 2, 110);

  // Ayuda de controles
  ctx.font = '13px system-ui';
  ctx.fillStyle = '#8fa3b8';
  ctx.fillText('WASD o flechas: mover. Mantén ESPACIO y suelta: golpear. E: empujar. MAYÚS: dash.', ARENA / 2, ARENA - 12);

  if (playing && view.u === mySlot) {
    ctx.font = 'bold 18px system-ui';
    ctx.fillStyle = '#ffd43b';
    ctx.fillText('¡Tu turno! Colócate bajo la bola cuando baje', ARENA / 2, ARENA - 38);
  }
}

/** Bucle de dibujo (una vez por frame de pantalla). */
function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();
  drawArena();
  const view = currentView();
  if (!view) return;                        // aún no hay datos del servidor
  const playing = room.state === 'playing';

  drawPlayers(view, playing, now);
  if (playing) drawBall(view);
  drawEffects(view, now);
  drawPowerBar(view);
  drawDashIndicator(view);
  drawHud(view, playing, now);
}
draw();
