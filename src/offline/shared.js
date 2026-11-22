// Código compartido del juego (townArt): datos de especies, movimientos, generador de pisos y la
// simulación de movimiento que el cliente usa para predecir. El servidor local usa el mismo módulo,
// así lo que ve el jugador y lo que calcula el "servidor" coinciden.
export const SHARED_URL = "/assets/townArt-CEAl5xQ6.js";
let p;
export function loadShared() {
  return (p ??= import(/* @vite-ignore */ SHARED_URL));
}
