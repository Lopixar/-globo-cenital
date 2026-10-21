# Globo cenital

Juego multijugador en red (hasta 4 jugadores) con vista cenital. Una pelota sale disparada hacia arriba y los jugadores, por turnos, deben colocarse debajo y golpearla para que no caiga. Quien no la golpea en su turno queda eliminado. Mientras tanto pueden empujarse y hacer dash para estorbarse. El último que queda gana la ronda.

Práctica 2 (módulo de interacción) de Sistemas Multijugador.

---

## 1. Cómo arrancarlo

**Requisitos:** [Node.js](https://nodejs.org) 18 o superior. No hay dependencias, no hace falta `npm install`.

```bash
cd globo-cenital
npm start
```

Después abre **http://localhost:3000** en el navegador.

- Cambiar de puerto (CMD): `set PORT=3001 && npm start`
- Cambiar de puerto (PowerShell): `$env:PORT=3001; npm start`
- Parar el servidor: `Ctrl + C` en la terminal.

### Probarlo con varios jugadores

Cada jugador se identifica con una cookie, y las pestañas del mismo navegador la comparten. Usa **un navegador (o perfil) distinto por jugador**: por ejemplo Chrome normal, Chrome en incógnito y Firefox, o dispositivos distintos.

1. Cada jugador abre la página, escribe su nombre y el **mismo código de sala**.
2. Con 2 o más jugadores, cualquiera pulsa "Empezar partida".

Para jugar desde otros dispositivos de la misma red, abre `http://IP-DEL-ORDENADOR:3000` (la IP se ve con `ipconfig`).

### Controles

| Acción | Tecla |
|---|---|
| Moverse | WASD o flechas |
| Golpear | Mantener ESPACIO y soltar (eliges la fuerza con la barra) |
| Empujar | E |
| Dash (con cooldown) | MAYÚS |

---

## 2. De qué se compone el proyecto

```
globo-cenital/
├── server.js            Punto de entrada: servidor HTTP
├── package.json         Define el comando "npm start"
├── README.md
├── private/             Lógica del juego (el navegador NUNCA puede descargarla)
│   ├── config.js        Valores ajustables (velocidades, tiempos, cooldowns...)
│   ├── game.js          Salas, reglas, física y bucle de simulación
│   └── api.js           Puerta de entrada de las peticiones del cliente
└── public/              Lo único que descarga el navegador
    ├── index.html       Estructura de la página
    ├── css/style.css    Estilos
    └── js/client.js     Cliente: envía lo que pulsas, consulta el estado y dibuja
```

| Archivo | Responsabilidad |
|---|---|
| `server.js` | Recibe las peticiones HTTP, identifica al jugador por cookie, reparte los archivos de `public/` y pasa las peticiones de la API a `api.js`. |
| `private/api.js` | Traduce cada petición del cliente (entrar, actuar, consultar) en una llamada al juego. |
| `private/game.js` | Mantiene todas las partidas y las hace avanzar: jugadores, pelota, turnos, eliminaciones y ganadores. |
| `private/config.js` | Todos los números que definen cómo se siente el juego, en un solo sitio. |
| `public/js/client.js` | Captura el teclado, habla con el servidor y dibuja. No toma decisiones de juego. |

**Seguridad básica:** el servidor solo reparte archivos de `public/`. Todo lo de `private/` (y `server.js`) es inaccesible desde el navegador.

---

## 3. Cómo funciona (pipeline)

### 3.1 Arquitectura general

Cliente-servidor, con **servidor autoritativo** y **solo HTTP** (sin WebSockets): el navegador siempre empieza la conversación y el servidor responde.

```
   NAVEGADOR                                        SERVIDOR (Node.js)
 ┌────────────┐                                   ┌───────────────────────────┐
 │ client.js  │ ── POST /api/join  (entrar) ────► │ server.js                 │
 │            │ ── POST /api/act   (acciones) ──► │    │ cookie → identifica  │
 │  teclado   │ ── POST /api/sync  (cada 50ms) ─► │    ▼                      │
 │  dibujo    │                                   │ api.js  (traduce)         │
 │            │ ◄────────── JSON ───────────────  │    │                      │
 └────────────┘                                   │    ▼                      │
                                                  │ game.js (reglas + física) │
                                                  │    ▲                      │
                                                  │    └── config.js          │
                                                  └───────────────────────────┘
```

- **El servidor es la única fuente de verdad.** Simula la partida y decide todo. El cliente solo envía intenciones y dibuja, así que no se puede hacer trampa tocando el cliente.
- **Tres tipos de petición:**
  - `join`: entrar en una sala (una vez).
  - `act`: acciones inmediatas (moverse, golpear, empujar, dash, empezar). Solo se envían cuando ocurren.
  - `sync`: el cliente pregunta cada ~50 ms "¿qué hay de nuevo?" y recibe únicamente lo que le falta.

### 3.2 Qué hace el servidor por dentro

El servidor hace dos cosas **independientes** a la vez:

```
  Bucle del juego (~60 veces/s, por sí solo)     Peticiones HTTP (cuando llegan)
  ─────────────────────────────────────────      ────────────────────────────────
  mueve jugadores                                 act  → modifica el estado
  resuelve choques y empujones                           (dirección, golpe, dash...)
  hace volar la pelota (gravedad, rebotes)        sync → lee las "fotos" ya guardadas
  aplica reglas (turnos, eliminación, ganador)           y las devuelve
  cada 3 pasos guarda una "foto" del estado
  da de baja a quien lleva 5 s sin dar señales
```

La simulación nunca espera a las peticiones: las peticiones solo dan órdenes o leen lo ya calculado.

### 3.3 Qué hace el cliente por dentro

```
  teclado ──► envía acción al servidor (solo si algo cambia)
  cada 50 ms ──► pide estado nuevo ──► guarda las fotos recibidas
  cada frame ──► elige el estado de hace 150 ms (mezclando dos fotos) ──► dibuja
```

Dibujar el pasado (150 ms) permite que el movimiento sea suave y que **todos los jugadores vean lo mismo al mismo tiempo**. Para ello cada cliente sincroniza su reloj con el del servidor usando el tiempo de ida y vuelta de sus propias peticiones, que además da la latencia que se muestra en pantalla.

### 3.4 Ejemplo: un golpe de principio a fin

```
 1. Mantienes ESPACIO y sueltas       → el cliente envía la fuerza y el instante que veías
 2. server.js recibe la petición      → identifica quién eres por la cookie
 3. api.js la traduce                 → "este jugador intenta golpear"
 4. game.js valida:
       ¿es su turno?  ¿está debajo de la pelota?  ¿la pelota está a su alcance y bajando?
       (se comprueba contra lo que el jugador VEÍA, para compensar su latencia)
 5. Si es válido → lanza la pelota, pasa el turno al siguiente y registra un evento
 6. En el siguiente sync de cada jugador llega el nuevo estado y el evento
 7. Cada cliente lo dibuja (con su efecto visual)
```

### 3.5 Ciclo de vida de una sala

```
   ┌────────┐  2+ jugadores y alguien    ┌─────────┐   queda 1 vivo    ┌──────┐
   │ LOBBY  │ ─────pulsa "Empezar"─────► │ PLAYING │ ────────────────► │ OVER │
   └────────┘                            └─────────┘                   └──────┘
       ▲                                  │   ▲                           │
       │                                  │   │ otro jugador eliminado:   │ tras unos segundos:
       │                                  │   └─ saca de cero el          │  · 2+ jugadores → nueva ronda
       │                                  │      siguiente en el orden    │  · si no → vuelve al LOBBY
       └──────────────────────────────────┴───────────────────────────────┘
```

- **Salas independientes:** cada código de sala es una partida distinta (máximo 4 jugadores). Una sala se elimina sola cuando queda vacía.
- **Quien entra a media partida** espera a la siguiente ronda.
- **Desconexiones:** al no haber conexión abierta, se detectan por falta de peticiones. Si el jugador que se va tenía el turno, la partida continúa sin él.

### 3.6 Cómo se abordan los puntos de la práctica

| Requisito | Cómo se aborda |
|---|---|
| Varios usuarios y acceso remoto | Salas independientes; servidor accesible desde otros dispositivos de la red |
| Estado compartido coherente | Un único simulador en el servidor + relojes sincronizados + dibujo con retardo fijo |
| Conflictos | Turnos, empujones, dash y choques compiten por estar bajo la pelota en el momento justo |
| Resolución justa | Solo golpea quien tiene el turno; el servidor decide el orden de llegada |
| Latencia distinta por jugador | Se mide por jugador, se muestra, y el golpe se valida contra lo que el jugador veía; hay un margen antes de eliminar |
| Minimizar datos en tránsito | JSON compacto; solo se envía lo que cambió; acciones solo cuando ocurren |
| Identificar a cada jugador | Cookie por navegador |

---

## 4. Ajustes

Todo lo que define cómo se siente el juego (velocidad, gravedad, alcance del golpe, tiempos, dash...) está en `private/config.js`. Se cambia sin tocar el resto, pero hay que **reiniciar el servidor** para aplicar los cambios.

## 5. Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `EADDRINUSE ... :3000` | El puerto ya lo usa otra copia del servidor | Cierra la otra terminal (`Ctrl + C`) o usa otro puerto |
| La página da 404 | Estructura de carpetas incorrecta | Comprueba que existe `public/index.html` |
| No se ven los cambios | Servidor sin reiniciar o caché | Reinicia el servidor y recarga con `Ctrl + F5` |
| Dos "jugadores" son el mismo | Pestañas del mismo navegador (cookie compartida) | Usa navegadores o perfiles distintos |
| Otro dispositivo no conecta | Cortafuegos o red que aísla dispositivos | Permite Node.js en el cortafuegos o usa el punto de acceso del móvil |
| "Sesión perdida" | Servidor reiniciado o más de 5 s sin conexión | Recarga la página y vuelve a entrar |

## 6. Pendiente para el trabajo de la 1ª parte

- Integrar el módulo de gestión de usuarios (práctica 1): usar la sesión del usuario en lugar de pedir un nombre y no permitir jugar sin iniciar sesión.
- Desplegar online con HTTPS.
- Documentar en el PDF qué ha hecho cada miembro del equipo.
