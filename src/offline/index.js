// Entrada del port: se carga antes que el juego y lo deja jugar sin internet.
import { installNet } from "./net.js";

window.__pdLog = window.__pdLog || [];
installNet();
