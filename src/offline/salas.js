// Salas especiales (worldgen): en algunos pisos, un rincón sin salida del propio piso se convierte en sala con cofres.
// - Sala secreta: la entrada se tapa con Matorrales (los quema un Pokémon o ataque de Fuego) o Rocas grandes (Golpe Roca),
//   según lo que pueda abrir el grupo.
// - Sala del guardián: si nadie puede abrir nada, la sala queda abierta con un alfa dentro; sus cofres se abren al vencerlo.
// El piso lo sigue generando el juego con su semilla (el cliente lo repite igual); los cambios van por state.mods,
// que el cliente ya aplica al empezar el piso (como las rocas rotas). El análisis está en el repo worldgen
// (src/offline/vendor/worldgen.mjs = dist/worldgen.mjs).
import { adapters } from "./vendor/worldgen.mjs";
import { shopMethods } from "./shop.js";

const PROB = 0.4; // pisos con sala (de los que pueden tenerla); las pruebas lo suben con globalThis.__pdSalaProb

export const salasMethods = {
  setupSalas() {
    const s = this.state;
    const L = this.layout;
    this.sala = null;
    globalThis.__pdExp = this; // para las pruebas y la consola
    globalThis.__pdSala = null;
    if (!L || s.tutorial || s.raid || s.mansion || L.boss || s.floor < (globalThis.__pdSalaPisoMin ?? 2) || s.floor % 5 === 0) return;
    if (Math.random() > (globalThis.__pdSalaProb ?? PROB)) return;
    const metas = [...this.meta.values()];
    const abre = {
      fuego: metas.some((m) => (m.types || []).includes("fire")),
      golpeRoca: this.hasHm("rock-smash"),
    };
    // Lo que no puede quedar encerrado: tienda y cofres que ya puso el piso
    const ocupado = [...s.pickups.values()].filter((k) => k.kind === "chest").map((k) => ({ x: k.x, y: k.y }));
    if (s.shopX >= 0) ocupado.push({ x: s.shopX, y: s.shopY });
    let plan;
    try {
      plan = adapters.pokedive.planearSala(L, `${s.seed}|${s.floor}`, { abre, ocupado, distMin: globalThis.__pdSalaDistMin ?? 12 });
    } catch (e) {
      console.warn("[salas]", e);
      return;
    }
    if (!plan) return;
    for (const [i, t] of plan.mods) this.setTile(i, t);
    const cofres = plan.cofres.map((c) => this.spawnPickup("chest", c.x, c.y));
    let gid = null;
    if (plan.tipo === "guardian") {
      const pool = this.speciesPool();
      gid = this.spawnEnemy(pool.alpha[Math.floor(Math.random() * pool.alpha.length)], plan.guardia.x, plan.guardia.y, { alpha: true });
      for (const id of cofres) {
        const pk = s.pickups.get(id);
        if (pk) pk.lock = "guard";
      }
    }
    this.sala = { tipo: plan.tipo, cofres, gid };
    this.fx.push({ t: "banner", text: { es: plan.aviso.es, en: plan.aviso.en }, sub: plan.aviso.sub });
    globalThis.__pdSala = { piso: s.floor, tipo: plan.tipo, cofres: plan.cofres, puerta: plan.puerta.length, celdas: plan.celdas.length, mods: plan.mods };
  },

  onEnemyGone(eid) {
    shopMethods.onEnemyGone.call(this, eid);
    if (this.sala?.gid && this.sala.gid === eid) {
      for (const id of this.sala.cofres) {
        const pk = this.state.pickups.get(id);
        if (pk?.lock === "guard") this.unlockChest(pk);
      }
      this.sala.gid = null;
    }
  },
};
