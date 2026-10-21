/*
 * CONFIGURACIÓN DEL JUEGO (carpeta private: el navegador nunca puede descargar estos archivos).
 * Aquí están todos los valores que puedes ajustar.
 */
// ============================ CONFIGURACIÓN ============================
const PORT = process.env.PORT || 3000;



// Arena y jugadores (unidades = píxeles del canvas)
const ARENA_W = 800;
const ARENA_H = 800;
const PLAYER_R = 22;          // radio de un jugador
const BALL_R = 14;            // radio base de la bola
const PLAYER_SPEED = 250;     // píxeles por segundo
const SPAWN = [[200, 200], [600, 200], [600, 600], [200, 600]]; // posición inicial por plaza

// Física de la bola (z = altura sobre el suelo)
const GRAVITY = 500;
const REACH_Z = 300; //170         // altura máxima a la que se puede golpear
const HIT_DIST = 60;          // distancia máxima (en el plano) jugador-bola para golpear

// Tiempos (milisegundos)
const GROUND_GRACE = 200;     // margen tras tocar el suelo antes de eliminar (golpes con lag)
const REWIND_MAX = 450;       // cuánto "hacia atrás" se acepta el instante de un golpe
const DASH_SPEED = 1400;       // velocidad durante el dash (px/s)
const DASH_TIME = 160;         // duración del dash (ms): recorre unos 220 px
const DASH_COOLDOWN = 2500;    // espera entre dashes (ms)
const SHOVE_COOLDOWN = 700;   // espera entre empujones
const IDLE_TIMEOUT = 5000;    // sin peticiones durante este tiempo = jugador desconectado
const SERVE_TIMEOUT = 12000;  // si nadie saca, saca solo
const ROUND_END_PAUSE = 5000; // pausa antes de empezar otra ronda

module.exports = {
  PORT,
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
};
