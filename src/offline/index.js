// Entrada del port: se carga antes que el juego y lo deja jugar sin internet.
import { installNet } from "./net.js";
import { installUpdateUi } from "./updui.js";
import { installCleanUi } from "./cleanui.js";

window.__pdLog = window.__pdLog || [];
installNet();
installUpdateUi();
installCleanUi();

// Para depurar desde la consola (no lo usa el juego).
import { load, save } from "./store.js";
globalThis.__pdStore = { load, save };

// Actualizador de la app: avisa que el juego arrancó bien con esta versión (si no llega el aviso,
// en el siguiente inicio la app vuelve sola a la versión anterior).
window.addEventListener("load", () => {
  setTimeout(() => {
    try {
      globalThis.PdAndroid?.updBooted?.();
    } catch {}
  }, 8000);
});
