// Guardado local (localStorage). Todo lo que en el original guardaba el servidor: cuenta, refugio, progreso.
const KEY = "pdport-save-v1";

let cache;
export function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    cache = null;
  }
  if (!cache || typeof cache !== "object") cache = { v: 1, users: {}, tokens: {} };
  return cache;
}

let timer = 0;
export function save() {
  if (timer) return;
  timer = setTimeout(flush, 50);
}
export function flush() {
  clearTimeout(timer);
  timer = 0;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn("[offline] no se pudo guardar", e);
  }
}
addEventListener("pagehide", flush);
addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());

export const rid = (n = 12) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
