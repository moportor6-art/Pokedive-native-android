# PokéDive para Android (offline + salas por wifi)

Port no oficial de [PokéDive](https://pokedive.com) (fangame de Nicolr3) a una app de Android que funciona **sin internet**.

El juego original calcula el combate, los enemigos, los pisos y tu refugio en su servidor. En este port ese servidor
se reemplaza por uno propio que corre **dentro del teléfono** (`src/offline/`). Usa el código compartido del juego
(movimiento, generador de pisos, datos de especies y movimientos) y escribe desde cero lo que el original
hacía en su servidor.

## Descargar

En **Releases** está el último `0.x.apk`. Para actualizar, instálalo encima del anterior y conservarás la partida.

## Qué funciona (0.2)

- Arranque sin conexión, partida de invitado guardada en el teléfono.
- Intro, elección de inicial y pueblo/refugio.
- Expediciones en las 9 rutas: movimiento y esquiva con la física del juego, ataque básico automático,
  dos especiales y definitiva, enemigos del bioma con IA sencilla, daño por tipos, experiencia y niveles,
  un alfa cada 5 pisos, rescate del Pokémon del piso y escaleras.
- Evoluciones al nivel que marca el juego (y "despertar" para los que no evolucionan), y se guardan en tu refugio.
- Botín: monedas, bayas, materiales, cristales y caramelos raros que sueltan los enemigos; cofres en el mapa.
- Jefe cada 5 pisos (legendario guardián de la ruta cada 10) que bloquea las escaleras y golpea en área.
- Cuerda Huida tras vencer al jefe y al empezar cada tramo de 5 pisos para volver al pueblo con todo.
- Al volver (cuerda o caer): monedas, recursos y Pokémon rescatados se suman a tu refugio (si caes, solo una parte).
- Salas por wifi: el que abre grupo hace de anfitrión y los demás lo ven en **Buscar grupo** o entran con su código.

## Pendiente

Construcción del refugio y trabajos, tienda, mochila y objetos equipables, enemigos a distancia, estados alterados, campamentos, logros,
diarias y el tutorial guiado completo. Los amigos, clanes y clasificaciones en línea no existen sin internet.

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
