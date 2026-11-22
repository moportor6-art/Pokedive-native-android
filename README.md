# PokéDive para Android (offline + salas por wifi)

Port no oficial de [PokéDive](https://pokedive.com) (fangame de Nicolr3) a una app de Android que funciona **sin internet**.

El juego original calcula el combate, los enemigos, los pisos y tu refugio en su servidor. En este port ese servidor
se reemplaza por uno propio que corre **dentro del teléfono** (`src/offline/`). Usa el código compartido del juego
(movimiento, generador de pisos, datos de especies y movimientos) y escribe desde cero lo que el original
hacía en su servidor.

## Descargar

En **Releases** está el último `0.x.apk`. Para actualizar, instálalo encima del anterior y conservarás la partida.

## Qué funciona (0.7)

- Arranque sin conexión, partida de invitado guardada en el teléfono.
- Intro, elección de inicial y pueblo/refugio.
- Expediciones en las 9 rutas: movimiento y esquiva con la física del juego, ataque básico automático,
  dos especiales y definitiva, enemigos del bioma con IA sencilla, daño por tipos, experiencia y niveles,
  un alfa cada 5 pisos, rescate del Pokémon del piso y escaleras.
- Objetos de mejora en la mazmorra (los 22 del juego: Proteína, Garra Rápida, Restos, Casco Dentado…) con sus efectos;
  los de la Biblioteca de Unown se desbloquean comprándolos allí.
- Enemigos a distancia que disparan su movimiento, y estados alterados (quemado, envenenado, paralizado, congelado, mojado).
- Escamas Corazón y boletos como botín; logros (los 76 del juego) con sus recompensas.
- Evoluciones al nivel que marca el juego (y "despertar" para los que no evolucionan), y se guardan en tu refugio.
- Botín: monedas, bayas, materiales, cristales y caramelos raros que sueltan los enemigos; cofres en el mapa.
- Especiales con la geometría y los efectos del propio juego: proyectil, rayo (con cadena), anillo, estallido,
  zona que daña con el tiempo, línea, embestida (te mueve), trampa, curación, escudo y contraataque.
- Estadísticas con la fórmula del juego: especie, naturaleza (o menta), IVs y Dojo; cada nivel +8 % daño y +10 PS.
- MO: Golpe Roca rompe rocas agrietadas, Destello y Despejar amplían la vista, Surf quita el freno del agua;
  los de tipo Fuego queman matorrales.
- Evoluciones con varias ramas (Eevee…): eliges en la ventana del juego (10 s; si no, al azar).
- Pisos 25, 50, 75 y 100: arena del guardián legendario de la ruta (se cierra al entrar). Al vencerlo, probabilidad
  de que se quede del juego: 35 % + 20 % con Baya Frambu + 10 % por cada vez que se te escapó.
- Cuerda Huida en la antesala del guardián, tras vencerlo y al empezar cada tramo de 5 pisos.
- Refugio: construir, mover, mejorar y derribar edificios; trabajos de tus Pokémon y recogida de lo producido
  (costes, mejoras, capacidades y ritmos sacados del propio juego); caseta ampliable.
- Llegadas: los rescatados esperan en la entrada para quedarse o irse (recompensa por liberar igual que el original).
- Café de Spinda (platos que duran la expedición), Dojo (entrenamiento permanente con Escamas Corazón),
  Centro Pokémon (curar el cansancio de los que caen) y Guardería (parejas compatibles, huevos, cestas y adelantar).
- Poké Balls con boletos (probabilidades, seguro y escamas por repetidos del juego), Taller de Smeargle (MO)
  y Herbolario (mentas con hojas que se recogen en las mazmorras y cambio de hojas).
- Tienda de Kecleon: Semilla Revivir, Elixir, Pergamino, Baya Frambu, Incienso y Cuerda Huida, según el nivel de la tienda.
- Al volver (cuerda o caer): monedas, recursos y Pokémon rescatados se suman a tu refugio (si caes, solo una parte).
- Salas por wifi: el que abre grupo hace de anfitrión y los demás lo ven en **Buscar grupo** o entran con su código.

## Pendiente

Pisos con niebla/oscuridad y demás peligros de cada bioma, aprender movimientos nuevos al subir de nivel,
Malasada, Incienso y Trozos de Estrella, campamentos y hogueras, diarias, tutorial guiado completo, Pokédex completa,
disfraces, ampliar terreno y la quema de árboles. Los amigos, clanes y clasificaciones en línea no existen sin internet.

## Estructura

| Carpeta | Qué hay |
|---|---|
| `web/` | El juego tal cual (código, sprites, música) + `web/offline/boot.js` (compilado) |
| `src/offline/` | Servidor local: API (`api.js`), Colyseus sin red (`server.js`, `net.js`), sala de expedición (`expedition.js`), wifi (`lan.js`) |
| `android/` | App (WebView + relay WebSocket y anuncios UDP para la wifi) |
| `tools/` | Compilar el servidor, servidor de pruebas y simulador de wifi para PC |

## Compilar

```
npm install
npm run build        # genera web/offline/boot.js
```

GitHub Actions compila el APK en cada push a `main` (versión en `VERSION`).

### Probar en el PC

```
node tools/dev-server.mjs 8080 web
node tools/lan-sim.mjs 8790          # opcional: simula la wifi
```

Abre `http://localhost.test:8080/` (cualquier nombre que no sea `localhost`) y, para la wifi, añade `?lansim=8790` en dos navegadores.
