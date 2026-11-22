// Entrada del port: se carga antes que el juego y lo deja jugar sin internet.
import { installNet } from "./net.js";

window.__pdLog = window.__pdLog || [];
installNet();

// Para depurar desde la consola (no lo usa el juego).
import { load, save } from "./store.js";
globalThis.__pdStore = { load, save };
