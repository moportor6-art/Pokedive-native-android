# PokéDive para Android (offline + salas por wifi)

Port no oficial de [PokéDive](https://pokedive.com) (fangame de Nicolr3) a una app de Android que funciona **sin internet**.

El juego original calcula el combate, los enemigos, los pisos y tu refugio en su servidor. En este port ese servidor
se reemplaza por uno propio que corre **dentro del teléfono** (`src/offline/`). Usa el código compartido del juego
(movimiento, generador de pisos, datos de especies y movimientos) y escribe desde cero lo que el original
hacía en su servidor.

## Descargar

En **Releases** está el último `0.x.apk`. Para actualizar, instálalo encima del anterior y conservarás la partida.

## Qué funciona (0.11)

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

- **Se actualiza sola** (el actualizador de DB Survivors): al abrirla con internet busca la última versión publicada
  aquí; si solo cambió el juego baja únicamente los archivos cambiados (comprobados uno por uno), y si cambió la parte
  nativa baja el APK y Android pide confirmar. Puedes actualizar, dejarlo para luego u omitir esa versión.
  Si una versión nueva no arranca, la app vuelve sola a la anterior. Tus partidas no se tocan.
  (Desde la 0.8: esta hay que instalarla a mano una vez.) En **Ajustes → Juego → Actualizaciones** puedes buscar
  a mano o volver a la versión que trae el APK.
- Maestría de especiales: el aro amarillo se llena al usarlos; a los 80 usos llegan a «+» (cambian de forma) y a los
  180 más evolucionan a ★ (Calcinación → Llamarada…), con las tablas del juego.
- Movimientos nuevos: cada 5 niveles (y con el Pergamino, nada más salir) tu Pokémon quiere aprender uno al llegar al
  próximo piso; eliges cuál olvidar o no aprenderlo, en la ventana del juego.
- Clima del piso: a oscuras, penumbra, niebla, lluvia (todos mojados) o nieve; a oscuras o con niebla los enemigos te
  ven de más cerca. Destello y Despejar amplían tu vista.
- Malasada (empiezas con un objeto de mejora), Incienso Estrella (+50 % durante 5 pisos) y Trozos Estrella desde el
  piso 50 (alfas, jefes y cofres, tabla del juego).

- Peligros de cada bioma con aviso en el suelo: rayos (Tormenta), géiseres (Volcán), losas sueltas (Ruinas), pedos de
  lobo (Setas) y lluvia y barro (Lodazal). Hierba alta, arenas movedizas, corrientes y charcos helados van en el mapa.
- Capa honda (pisos 26+), con su fauna propia: raíces bajo quien se queda quieto, hondonadas que se desplazan, marea de
  lava, corrientes que se invierten, niebla tóxica en oleadas, runas en cruz, micelio y tormenta de rayos.
- Monumentos (una vez por piso): Santuario, Obelisco, Altar, Barco hundido, Aguja de hielo, Tótem, Monolito,
  Corro de setas y Bobina, con los efectos que describe el juego.
- Campamentos cada 5 pisos: saco de dormir (el grupo recupera media vida, se paga con Pokecoins) y hoguera.
  Al vencer al guardián se abre la Etapa siguiente para empezar ahí la próxima vez.

- Objetos hondos ("¡Objeto antiguo!"): uno por capa honda, con su extra (Raíz Grande · Antigua, Periscopio · de Bruma,
  Pila · Rúnica…). Los suelta el alfa de la capa y a veces un cofre.
- Alfas de la capa honda con su regla: Enraizado (anillo de raíces), del Foso (en el centro del sumidero), de Escoria
  (casi inmune con la marea alta), Torrente y Glaciar (cargan; el Glaciar queda aturdido si choca), de la Bruma, Centinela
  (solo sobre una losa encendida), Micelio (más fuerte y mejor botín) y de la Tormenta (llama a los rayos).
- Encargos del día: tres al día de la lista del juego, racha de 7 días con sus premios y premio por los tres;
  se renuevan a medianoche.
- Ampliar terreno (parcelas con el coste y el piso que pide el juego) y quemar árboles del pueblo con un Pokémon de fuego.

## Pendiente

Cuaderno de Rutas (las notas de cada capa), tutorial guiado completo y Pokédex completa. Los eventos de temporada
(Mansión Encantada con sus disfraces, raid de Arceus y Flauta Azur) los activa el servidor del juego en fechas
concretas. Los amigos, clanes y clasificaciones en línea no existen sin internet.

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
