// Mansión Encantada (evento de Halloween, aquí siempre activo).
// Del juego: el generador de plantas (modo "mansion": laberinto con farolillos, lápidas, cofres y zonas encantadas;
// planta 10 = arena de Spiritomb), los pactos (Yn), la regla de entrada (todos en el piso 10) y los disfraces.
// Reconstruido (lo decide el servidor en el original): qué fantasmas salen, cuánto tarda un farolillo, cuántos
// Caramelos suelta cada cosa y qué cofres son Mimic.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Fantasmas por profundidad (de menos a más evolucionados)
const GHOSTS_EARLY = ["0092", "0200", "0353", "0355", "0425", "0562", "0592", "0607", "0708", "0710", "0778", "0854", "0885"];
const GHOSTS_LATE = ["0093", "0354", "0356", "0426", "0429", "0563", "0593", "0608", "0679", "0709", "0711", "0886"];
const MIMIC = "0999"; // Gimmighoul: el cofre que muerde
export const SPIRITOMB = "0442";
export const MANSION_FLOOR = 10; // hace falta haber llegado al piso 10 para entrar
const PACT_IDS = ["fury", "greed", "gloom", "souls"];

export const mansionMethods = {
  /** Mensaje del anfitrión en la sala: entrar a la Mansión. */
  onMansion(client, m) {
    const s = this.state;
    if (client.sessionId !== s.host || s.phase !== "lobby") return;
    if (!m?.on) {
      s.mansion = false;
      return;
    }
    // Todos debéis haber llegado al piso 10
    const missing = [];
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      if ((pm?.deepest ?? 99) < MANSION_FLOOR) missing.push(p.name);
    }
    if (missing.length) {
      client.send("mansionLocked", { names: missing });
      return;
    }
    s.mansion = true;
    this.startFloor = 1;
    this.beginRun();
  },

  mansionGhosts() {
    const f = this.state.floor;
    const list = f <= 3 ? GHOSTS_EARLY : f <= 6 ? [...GHOSTS_EARLY, ...GHOSTS_LATE] : GHOSTS_LATE;
    return list.filter((d) => this.M.Kr[d]);
  },

  /** Al crear cada planta. */
  setupMansion() {
    const s = this.state;
    const L = this.layout;
    this.mz = { haunted: (L.haunted || []).map((h) => ({ ...h, done: false })), lit: (L.lanterns || []).map(() => 0) };
    s.lanterns = this.mz.lit.join(",");
    s.graves = (L.graves || []).map(() => "0").join("");
    s.event = "";
    s.ropeX = -1;
    s.ropeY = -1;
    for (const p of s.players.values()) p.pact = "";
    const ghosts = this.mansionGhosts();
    s.rescueSpecies = pick(ghosts) || "0092";
    // Fantasmas
    const count = Math.min((L.enemySpawns || []).length, 5 + s.floor);
    for (const sp of [...(L.enemySpawns || [])].sort(() => Math.random() - 0.5).slice(0, count)) this.spawnEnemy(pick(ghosts), sp.x, sp.y);
    // Cofres: uno de cada tres es un Mimic
    for (const c of L.chests || []) this.spawnPickup(Math.random() < 0.33 ? "mimic" : "chest", c.x, c.y);
    // Planta 10: Spiritomb en su arena (se cierra al entrar)
    s.legend = "";
    this.arena = null;
    if (L.boss) {
      s.legend = SPIRITOMB;
      this.arena = { ...L.boss, sealed: false, won: false };
    }
  },

  tickMansion(dt) {
    const s = this.state;
    if (!s.mansion || !this.mz || s.phase !== "exploring") return;
    const L = this.layout;
    // Farolillos de Litwick: se encienden quedándose cerca
    let changed = false;
    (L.lanterns || []).forEach((ln, i) => {
      if (this.mz.lit[i] >= 100) return;
      const near = [...s.players.values()].filter((p) => !p.downed && dist(p, ln) < 30).length;
      if (!near) return;
      this.mz.lit[i] = Math.min(100, this.mz.lit[i] + dt * 45 * near);
      changed = true;
      if (this.mz.lit[i] >= 100) this.fx.push({ t: "fire-lit", x: ln.x, y: ln.y - 30 });
    });
    if (changed) s.lanterns = this.mz.lit.map((v) => Math.round(v)).join(",");
    // Zonas encantadas: al pasar, salen fantasmas
    for (const h of this.mz.haunted) {
      if (h.done) continue;
      if ([...s.players.values()].some((p) => !p.downed && dist(p, h) < 40)) {
        h.done = true;
        const ghosts = this.mansionGhosts();
        for (let i = 0; i < 2; i++) this.spawnEnemy(pick(ghosts), h.x + (i ? 14 : -14), h.y);
        this.fx.push({ t: "text", x: h.x, y: h.y - 20, text: { es: "¡Buu!", en: "Boo!" }, color: "#c9a0ff" });
      }
    }
  },

  /** ¿Se puede bajar? Hacen falta todos los farolillos encendidos. */
  mansionStairsOpen() {
    const s = this.state;
    if (!s.mansion || !this.mz) return true;
    if (this.layout?.boss) return false; // de la planta de Spiritomb se sale venciéndolo
    return this.mz.lit.every((v) => v >= 100);
  },

  /** Lápida: ofrece tres pactos. */
  onGrave(client, m) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    const i = Number(m?.i);
    const g = this.layout?.graves?.[i];
    if (!s.mansion || !p || p.downed || p.pact || !g || s.graves[i] !== "0" || dist(p, g) > 30) return;
    const ids = [...PACT_IDS].sort(() => Math.random() - 0.5).slice(0, 3);
    (this.mz.offers ||= {})[client.sessionId] = { i, ids };
    client.send("pacts", { i, ids });
  },

  onPact(client, m) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    const o = this.mz?.offers?.[client.sessionId];
    if (!p || !o || o.i !== Number(m?.i) || !o.ids.includes(m?.id) || p.pact) return;
    p.pact = m.id;
    const gs = s.graves.split("");
    gs[o.i] = "1";
    s.graves = gs.join("");
    delete this.mz.offers[client.sessionId];
    const pm = this.meta.get(client.sessionId);
    if (pm) this.applyStats(p, pm);
  },

  /** Efectos de los pactos (textos del juego). */
  pactTaken(p) {
    return p.pact === "greed" ? 1.25 : p.pact === "souls" ? 1.15 : 1;
  },
  pactDamage(p) {
    return p.pact === "fury" ? 1.3 : 1;
  },
  pactNoHeal(p) {
    return p.pact === "fury";
  },
  pactGreed(p) {
    return p.pact === "greed" ? 2 : 1;
  },

  /** Botín de los fantasmas y de los cofres de la mansión: Caramelos. */
  mansionLoot(x, y, n) {
    for (let i = 0; i < n; i++) this.spawnPickup("candy", x + (Math.random() - 0.5) * 24, y + (Math.random() - 0.5) * 16, 1);
  },

  /** Cofre que muerde. */
  openMimic(pk) {
    const id = this.spawnEnemy(MIMIC, pk.x, pk.y, { alpha: true });
    const e = this.state.enemies.get(id);
    if (e) this.fx.push({ t: "text", x: pk.x, y: pk.y - 24, text: { es: "¡Era un Mimic!", en: "It was a mimic!" }, color: "#ff8a80" });
  },

  /** Spiritomb vencido: termina la Mansión con todo (y el disfraz de velo). */
  mansionWin() {
    const s = this.state;
    this.mansionSecs = Math.round((Date.now() - this.runStart) / 1000);
    this.mansionVeil = true;
    this.fx.push({ t: "banner", text: { es: "¡Has vencido a Spiritomb!", en: "You beat Spiritomb!" }, sub: { es: "La Mansión os deja salir con todo", en: "The Mansion lets you leave with everything" } });
    this.clock.setTimeout(() => this.endRun(true), 3500);
  },

  /** Calabazas de las mazmorras normales durante Halloween: van llenas de Caramelos. */
  spawnPumpkins() {
    const L = this.layout;
    const n = 1 + Math.floor(Math.random() * 3);
    for (const sp of [...(L.enemySpawns || [])].sort(() => Math.random() - 0.5).slice(0, n)) this.spawnPickup("pumpkin", sp.x + 10, sp.y + 6);
  },
};
