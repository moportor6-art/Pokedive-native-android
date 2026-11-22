// Sala de expedición: la mazmorra que antes simulaba el servidor de PokéDive.
//
// Lo que el cliente predice (movimiento, esquiva, ataque básico) se calcula aquí con el MISMO código del
// juego (módulo compartido townArt): así la predicción del cliente y el "servidor" coinciden y no hay tirones.
// El resto (enemigos, daño, experiencia, rescates, escaleras, botín) está escrito desde cero para el port.
import { Room } from "@colyseus/core/Room";
import { ExpeditionState, Player, Enemy, Pickup, Projectile } from "./schema.js";
import { guildOf, grantRun, userByToken, rememberPlayers, featuredRoute } from "./api.js";
// Evento de Pokecoins (siempre activo): el doble
const COIN_EVENT = 2;
import { save } from "./store.js";
import { tire } from "./guild.js";
import { announce } from "./lan.js";

const TICK = 33 / 1000; // paso fijo de la simulación del juego
const STAIRS_R = 16;
const RESCUE_R = 22;
const ENEMY_HIT_R = 20;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Casilla bajo un punto (0 suelo, 3 hierba alta, 10-13 corrientes, 15 hielo…)
const tileAt = (L, o) => L?.tiles[Math.floor(o.y / 16)]?.[Math.floor(o.x / 16)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Tabla de eficacias (tipo atacante → tipo defensor). */
const EFF = {
  fire: { grass: 2, ice: 2, bug: 2, steel: 2, water: 0.5, rock: 0.5, fire: 0.5, dragon: 0.5 },
  water: { fire: 2, ground: 2, rock: 2, water: 0.5, grass: 0.5, dragon: 0.5 },
  grass: { water: 2, ground: 2, rock: 2, fire: 0.5, grass: 0.5, poison: 0.5, flying: 0.5, bug: 0.5, dragon: 0.5, steel: 0.5 },
  electric: { water: 2, flying: 2, grass: 0.5, electric: 0.5, dragon: 0.5, ground: 0 },
  ice: { grass: 2, ground: 2, flying: 2, dragon: 2, fire: 0.5, water: 0.5, ice: 0.5, steel: 0.5 },
  fighting: { normal: 2, ice: 2, rock: 2, dark: 2, steel: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, fairy: 0.5, ghost: 0 },
  poison: { grass: 2, fairy: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0 },
  ground: { fire: 2, electric: 2, poison: 2, rock: 2, steel: 2, grass: 0.5, bug: 0.5, flying: 0 },
  flying: { grass: 2, fighting: 2, bug: 2, electric: 0.5, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, steel: 0.5, dark: 0 },
  bug: { grass: 2, psychic: 2, dark: 2, fire: 0.5, fighting: 0.5, poison: 0.5, flying: 0.5, ghost: 0.5, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, flying: 2, bug: 2, fighting: 0.5, ground: 0.5, steel: 0.5 },
  ghost: { psychic: 2, ghost: 2, dark: 0.5, normal: 0 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { psychic: 2, ghost: 2, fighting: 0.5, dark: 0.5, fairy: 0.5 },
  steel: { ice: 2, rock: 2, fairy: 2, fire: 0.5, water: 0.5, electric: 0.5, steel: 0.5 },
  fairy: { fighting: 2, dragon: 2, dark: 2, fire: 0.5, poison: 0.5, steel: 0.5 },
  normal: { rock: 0.5, steel: 0.5, ghost: 0 },
};
function effectiveness(atkType, defTypes) {
  let m = 1;
  for (const t of defTypes || []) m *= EFF[atkType]?.[t] ?? 1;
  return m;
}

/** Las cadenas del estado empiezan en "" (el cliente hace .split() sobre ellas). */
function initStrings(obj) {
  const md = obj.constructor[Symbol.metadata] || {};
  const NUM = /^(u?int(8|16|32|64)|float(32|64)|number)$/;
  for (const f of Object.values(md)) {
    if (!f || obj[f.name] != null) continue;
    if (f.type === "string") obj[f.name] = "";
    else if (f.type === "boolean") obj[f.name] = false;
    else if (typeof f.type === "string" && NUM.test(f.type)) obj[f.name] = 0;
    else if (f.type && typeof f.type === "object" && f.type.quantized) obj[f.name] = 0;
  }
  return obj;
}

const pad4 = (n) => String(n).padStart(4, "0");
const RES_KINDS = ["berries", "materials", "crystals"];

/** Objetos de mejora que lleva un jugador ("power:2,haste:1" en el estado). */
const ups = (p) => {
  const o = {};
  for (const part of (p.upgrades || "").split(",")) {
    const [k, n] = part.split(":");
    if (k) o[k] = Number(n) || 1;
  }
  return o;
};
const upN = (p, k) => ups(p)[k] || 0;
// Estados que provocan los golpes de los enemigos según su tipo (reconstruido)
const FOE_STATUS = { fire: ["burning", 3], poison: ["poisoned", 4], electric: ["paralyzed", 2], ice: ["frozen", 1], water: ["wet", 4] };

const xpNeed = (lv) => Math.round(12 + lv * 7 + lv * lv * 0.6);

import { hazardMethods } from "./hazards.js";
import { mansionMethods } from "./mansion.js";
import { raidMethods } from "./raid.js";

// Guardianes de los pisos 50, 75 y 100 (tabla del juego; no viene exportada en el módulo compartido)
const LATE_GUARDIANS = {
  forest: { 50: ["1017", "1016"], 75: ["0905", "0641"], 100: ["0888"] },
  desert: { 50: ["0773"], 75: ["0895"], 100: ["1007"] },
  swamp: { 50: ["1015", "0802"], 75: ["0897"], 100: ["0890"] },
  ruins: { 50: ["0892"], 75: ["0889"], 100: ["0150"] },
  lava: { 50: ["1004"], 75: ["0483"], 100: ["0643"] },
  shroom: { 50: ["0482"], 75: ["0800"], 100: ["0792"] },
  ice: { 50: ["0480"], 75: ["0788"], 100: ["0791"] },
  storm: { 50: ["0785"], 75: ["0807"], 100: ["0644"] },
  sea: { 50: ["0380"], 75: ["0381"], 100: ["0484", "0384"] },
};

export class ExpeditionRoom extends Room {
  static shared; // módulo compartido del juego (lo pone server.js)

  onCreate(options) {
    const M = (this.M = ExpeditionRoom.shared);
    this.autoDispose = true;
    this.maxClients = 4;
    this.setState(initStrings(new ExpeditionState()));
    const s = this.state;
    s.region = "eu";
    s.version = Number(options.v) >>> 0;
    s.floor = 1;
    s.route = "forest";
    s.biome = "forest";
    s.seed = 0;
    s.phase = "lobby";
    s.tutorial = !!options.tutorial;
    s.combo = 0;
    this.startFloor = 1;
    this.meta = new Map(); // sessionId → datos internos del jugador
    this.enemyAI = new Map(); // id → datos internos del enemigo
    this.fx = [];
    this.layout = null;
    this.enemySeq = 0;
    this.runStart = 0;
    this.pendingHits = [];
    this.carried = [];
    this.pickSeq = 0;
    this.shotSeq = 0;
    this.zones = [];
    this.traps = [];
    this.trapSeq = 0;
    this.shots = new Map();
    this.pickVal = new Map(); // id de objeto → valor (monedas, etc.)
    this.bossId = null;
    this.bossWarned = 0;
    // Evoluciones: tabla hijo → padre del juego, invertida
    this.kids = new Map();
    for (const [c, par] of Object.entries(M.Jt || {})) {
      const k = Number(par);
      if (!this.kids.has(k)) this.kids.set(k, []);
      this.kids.get(k).push(pad4(c));
    }

    const on = (type, fn) =>
      this.onMessage(type, (client, msg) => {
        try {
          fn(client, msg || {});
        } catch (e) {
          console.error("[offline] mensaje", type, e);
        }
      });

    on("setup", (c, m) => this.applyPick(c, m));
    on("route", (c, m) => {
      if (c.sessionId !== s.host || s.phase !== "lobby") return;
      if (M.W[m.biome]) s.route = m.biome;
      this.startFloor = Math.max(1, Number(m.floor) || 1);
    });
    on("startFloor", (c, m) => {
      if (c.sessionId !== s.host || s.phase !== "lobby") return;
      this.startFloor = clamp(Number(m.floor) || 1, 1, 99);
    });
    on("ready", (c, m) => {
      const p = s.players.get(c.sessionId);
      if (p) p.ready = !!m.on;
    });
    on("start", (c) => {
      if (c.sessionId === s.host && s.phase === "lobby") this.beginRun();
    });
    on("input", (c, m) => this.onInput(c, m));
    on("dodge", (c, m) => this.onDodge(c, m));
    on("skill", (c, m) => this.onSkill(c, m));
    on("ult", (c, m) => this.onUlt(c, m));
    on("basic", () => {});
    on("menu", (c, m) => this.onMenu(c, m));
    on("floorReady", (c) => {
      const pm = this.meta.get(c.sessionId);
      if (pm) pm.floorReady = s.floor;
    });
    on("rope", () => this.endRun(true));
    on("rope-return", () => this.endRun(true));
    on("spong", () => {});
    on("tab", () => {});
    on("saveState", () => {});
    on("nextFloor", (c) => c.send("nextFloor", null));
    on("choose", (c, m) => this.onChoose(c, m));
    on("evolve", (c, m) => this.onEvolveChoice(c, m));
    on("landmark", (c) => this.onLandmark(c));
    on("camp", (c) => this.onCamp(c));
    on("mansion", (c, m) => this.onMansion(c, m));
    on("raid", (c, m) => this.onRaid(c, m));
    on("grave", (c, m) => this.onGrave(c, m));
    on("pact", (c, m) => this.onPact(c, m));
    on("groupMode", () => {});
    on("quick", (c, m) => this.broadcast("quick", { ...m, from: c.sessionId }));
    this.onMessage("*", (client, type, msg) => {
      (globalThis.__pdLog ||= []).push(["msg?", String(type), JSON.stringify(msg ?? null).slice(0, 160)]);
    });

    globalThis.__pdRoom = this; // para depurar desde la consola
    this.code = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    this.setSimulationInterval((dt) => this.tick(dt / 1000), 33);
    this.clock.setInterval(() => this.announce(), 1500);
    this.clock.setInterval(() => this.broadcast("sping", Date.now()), 2000);
  }

  // ---------- Jugadores ----------
  applyPick(client, opts) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!p || !pm) return;
    const u = (opts.token && userByToken(opts.token)) || pm.user;
    if (u) pm.user = u;
    const g = u ? guildOf(u) : null;
    let res = g ? g.residents.find((r) => r.id === opts.pokemon) || g.residents.find((r) => r.partner) : null;
    // Jugador de otro teléfono: trae sus datos en la petición (su partida está en su teléfono).
    const lu = !u && (opts.lanUser || pm.lanUser);
    if (lu) {
      pm.lanUser = lu;
      res = { id: null, dex: lu.dex, shiny: lu.shiny, level: lu.level };
    }
    const dex = String(res?.dex ?? u?.starter ?? "0025").padStart(4, "0");
    p.species = dex;
    p.shiny = !!res?.shiny;
    p.name = (u?.displayName || lu?.displayName || "Entrenador").slice(0, 20);
    pm.userId = u?.id || lu?.id || client.sessionId;
    pm.deepest = u?.guild ? Number(u.guild.deepest) || 0 : lu?.deepest ?? 99;
    // Raid de Arceus: Flauta Azur o tener ya a Arceus
    const rg = u?.guild || lu?.raid || {};
    pm.raidFlute = !!rg.flute;
    pm.raidHasArceus = !!rg.hasArceus || [...(rg.residents || []), ...(rg.arrivals || [])].some((r) => r.dex === "0493");
    pm.raidWins = Number(rg.raidWins) || 0;
    pm.raidOk = pm.raidFlute || pm.raidHasArceus;
    if (this.legendPity === undefined && u?.guild) this.legendPity = Number(u.guild.legendPity) || 0;
    const moves = Array.isArray(opts.moves) ? opts.moves.filter((m) => this.M.Rn[m]).slice(0, 2) : [];
    p.specials = moves.join(",");
    p.specialLv = moves.map(() => "0").join(",");
    pm.resident = res?.id;
    // MO del Taller: cuentan para todo el grupo (luz de Destello, niebla, rocas, agua)
    pm.hms = res?.hms || lu?.hms || [];
    s.hms = [...new Set([...this.meta.values()].flatMap((x) => x.hms || []))].join(",");
    pm.level = Math.max(1, Number(res?.level) || 1);
    pm.training = Number(res?.training) || 0;
    // Naturaleza (o menta), IVs y Dojo: alimentan la fórmula de estadísticas del juego
    pm.nature = res?.nature || "hardy";
    pm.mint = res?.mint || null;
    pm.ivs = res?.ivs || null;
    p.evolved = Math.min(2, Number(res?.evolved) || 0);
    pm.awaken = Math.min(2, Number(res?.awaken) || 0);
    this.applyStats(p, pm);
    this.updateRoster();
  }

  applyStats(p, pm) {
    const sp = this.M.Kr[p.species];
    const st = sp?.stats || { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 };
    pm.types = sp?.types || ["normal"];
    pm.atk = Math.max(st.atk, st.spa);
    pm.def = (st.def + st.spd) / 2;
    p.level = pm.level;
    // Fórmula exacta del juego (Jo): especie + naturaleza/menta + IVs + Dojo → PS, daño, daño recibido y velocidad.
    // Cada nivel suma lo de la tabla Tn (+8 % daño, +10 PS máx.).
    const lvT = this.M.Tn || { damage: 0.08, hp: 10, heal: 15 };
    const base = this.M.Jo(p.species, { nature: pm.nature, mint: pm.mint, ivs: pm.ivs || undefined, training: pm.training || 0 });
    const vit = upN(p, "vitality");
    const V = this.M._i?.vitality || { hp: 20, perLevel: 0.8 };
    const maxHp = Math.round((base.hp + lvT.hp * (p.level - 1)) * (1 + ((this.M.qt?.awaken?.hp ?? 12) / 100) * (pm.awaken || 0)) + (pm.meal?.includes("moomoo-milk") ? 25 : 0) + vit * (V.hp + V.perLevel * p.level));
    pm.dmgMul = base.damage * (1 + lvT.damage * (p.level - 1)) * (1 + (this.M.qt?.awaken?.damage ?? 0.14) * (pm.awaken || 0));
    pm.taken = base.taken * (1 - (this.M.qt?.awaken?.guard ?? 0.1) * (pm.awaken || 0));
    const ratio = p.maxHp ? p.hp / p.maxHp : 1;
    p.maxHp = maxHp;
    p.hp = Math.max(1, Math.round(maxHp * ratio));
    p.speed = Math.round(80 * base.speed * (1 + 0.04 * upN(p, "swift")) * (p.pact === "gloom" ? 0.85 : 1));
    p.dodgeCd = this.M.Wt?.cooldown ?? 1.2;
    p.xpNext = xpNeed(p.level);
  }

  onJoin(client, options) {
    const s = this.state;
    const p = initStrings(new Player());
    p.name = "Entrenador";
    p.species = "0025";
    p.level = 1;
    p.maxHp = 100;
    p.hp = 100;
    p.speed = 80;
    p.dir = 0;
    p.anim = "Idle";
    p.ready = false;
    p.specials = "";
    p.specialLv = "";
    p.upgrades = "";
    p.bag = "";
    p.carried = "";
    this.meta.set(client.sessionId, { client, level: 1, user: null, types: ["normal"], atk: 50, def: 50 });
    s.players.set(client.sessionId, p);
    if (!s.host) s.host = client.sessionId;
    this.applyPick(client, options);
    if (s.phase !== "lobby" && this.layout) this.placePlayer(client.sessionId, p, s.players.size - 1);
    this.sendGroup();
  }

  onLeave(client) {
    const s = this.state;
    s.players.delete(client.sessionId);
    this.meta.delete(client.sessionId);
    if (s.host === client.sessionId) s.host = s.players.keys().next().value || "";
    this.updateRoster();
    this.sendGroup();
  }

  onDispose() {
    announce(null);
  }

  /** Información del grupo (el código que los demás escriben para unirse). */
  sendGroup() {
    const members = [...this.meta.entries()].map(([sessionId, pm]) => ({ sessionId, userId: pm.userId || sessionId }));
    this.broadcast("group", { mode: "open", code: this.code, members });
  }

  /** Anuncia la sala en la wifi mientras se puede entrar (solo en el APK). */
  announce() {
    const s = this.state;
    const hostP = s.players.get(s.host);
    if (!hostP) return;
    announce({
      roomId: this.roomId,
      code: this.code,
      name: hostP.name,
      dex: [...s.players.values()].map((p) => p.species),
      biome: s.route,
      players: s.players.size,
      phase: s.phase,
      deepest: s.floor,
    });
  }

  updateRoster() {
    const s = this.state;
    const set = new Set();
    for (const e of s.enemies.values()) set.add(e.species);
    if (s.rescueSpecies) set.add(s.rescueSpecies);
    for (const p of s.players.values()) set.add(p.species);
    s.roster = [...set].filter(Boolean).join(",");
  }

  // ---------- Expedición ----------
  beginRun() {
    const s = this.state;
    s.floor = this.startFloor;
    s.kills = 0;
    s.coins = 0;
    s.rescuedTotal = 0;
    this.runStart = Date.now();
    this.carried = [];
    this.heartScales = 0;
    this.starPieces = 0;
    this.incenseFrom = 0;
    this.bossesBeaten = 0;
    this.legendsBeaten = 0;
    this.legendCaught = false;
    this.legendEscaped = 0;
    this.campsSaved = [];
    // Lo comprado en la tienda de Kecleon se gasta al salir
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      const g = pm?.user ? guildOf(pm.user) : null;
      const bag = g?.bag || {};
      pm.bag = { ...bag };
      // Pergamino: nada más salir quiere aprender un movimiento
      if (pm.bag.scroll > 0) {
        pm.bag.scroll--;
        p.learnPending = Math.min(255, p.learnPending + 1);
      }
      // Platos del Café: se comen al salir
      pm.meal = [...(g?.meal || [])];
      // Malasada: empiezas con un objeto de mejora al azar
      if (pm.meal.includes("malasada")) {
        const k = pick(this.upgradePool());
        const cur = ups(p);
        cur[k] = (cur[k] || 0) + 1;
        p.upgrades = Object.entries(cur).map(([a, n]) => `${a}:${n}`).join(",");
      }
      if (g) g.meal = [];
      this.applyStats(p, pm);
      p.hp = p.maxHp;
      p.bag = Object.entries(bag).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(",");
      if (g) {
        g.bag = {};
        save();
      }
    }
    this.newFloor();
    s.phase = "exploring";
  }

  newFloor() {
    const s = this.state;
    s.seed = (Math.random() * 2 ** 31) >>> 0;
    s.biome = s.route;
    s.enemies.clear();
    s.projectiles.clear();
    this.shots?.clear();
    this.zones = [];
    this.traps = [];
    s.pickups.clear();
    this.pickVal.clear();
    this.bossId = null;
    s.ropeX = -1;
    s.ropeY = -1;
    s.mods.clear();
    this.enemyAI.clear();
    this.pendingHits = [];
    const pool = this.speciesPool();
    s.rescueSpecies = pick(pool.rescue) || "0025";
    // El roster del estado (especies del piso) entra en el generador, como hace el cliente.
    this.layout = this.M.$a({ route: s.route, floor: s.floor, seed: s.seed, mode: s.raid ? "raid" : s.mansion ? "mansion" : "normal", roster: s.roster });
    const L = this.layout;
    s.stairsX = L.stairs.x;
    s.stairsY = L.stairs.y;
    s.rescueX = L.rescue.x;
    s.rescueY = L.rescue.y;
    s.rescued = false;
    s.rescueLost = false;
    s.escort = "";
    s.rescueMaxHp = 40 + s.floor * 6;
    s.rescueHp = s.rescueMaxHp;
    let i = 0;
    for (const [id, p] of s.players) this.placePlayer(id, p, i++);
    if (s.raid) {
      // Sala del Origen: solo Arceus
      this.hz = null;
      this.setupRaid();
      this.updateRoster();
      for (const pm of this.meta.values()) pm.floorReady = 0;
      return;
    }
    if (s.mansion) {
      // Mansión Encantada: su propia planta (fantasmas, farolillos, lápidas, Mimic, Spiritomb en la 10)
      this.hz = null;
      this.setupMansion();
      this.updateRoster();
      for (const pm of this.meta.values()) pm.floorReady = 0;
      return;
    }
    const count = Math.min(L.enemySpawns.length, 6 + Math.floor(s.floor * 0.8));
    const spawns = [...L.enemySpawns].sort(() => Math.random() - 0.5).slice(0, count);
    for (const sp of spawns) this.spawnEnemy(pick(pool.foes), sp.x, sp.y);
    // Alfa de vez en cuando
    if (s.floor % 5 !== 0 && s.floor > 2 && Math.random() < 0.35 && spawns.length) {
      const sp = pick(spawns);
      this.spawnEnemy(pick(pool.alpha), sp.x + 12, sp.y, { alpha: true });
    }
    // Clima del piso: a oscuras, en penumbra, niebla, lluvia o nieve (el cliente pinta la luz y la niebla;
    // Destello y Despejar amplían la vista). En el original lo decide el servidor: aquí, por bioma y profundidad.
    s.event = L.boss ? "" : this.rollEvent(s.route, s.floor);
    const EV = {
      dark: ["Piso a oscuras", "Pitch-dark floor", "Destello ilumina mucho más lejos", "Flash lights much farther"],
      dim: ["Piso en penumbra", "Dim floor", "Se ve menos de lo normal", "You see less than usual"],
      fog: ["Niebla espesa", "Thick fog", "Despejar deja ver mucho más lejos", "Defog lets you see much farther"],
      rain: ["Lluvia", "Rain", "Todos están mojados: lo Eléctrico pega más", "Everyone is wet: Electric hits harder"],
      snow: ["Nevada", "Snowfall", "", ""],
    }[s.event];
    if (EV) this.fx.push({ t: "banner", text: { es: EV[0], en: EV[1] }, sub: EV[2] ? { es: EV[2], en: EV[3] } : undefined });
    this.setupHazards();

    // Pisos 25, 50, 75, 100…: arena del guardián legendario (la genera el propio generador de pisos).
    // La puerta se cierra al entrar; las escaleras no sirven hasta vencerlo.
    s.legend = "";
    this.arena = null;
    if (L.boss) {
      const byFloor = LATE_GUARDIANS[s.route]?.[s.floor];
      const list = byFloor || this.M.Cn?.[s.route] || [];
      s.legend = list.length ? list[Math.abs(s.seed + s.floor) % list.length] : "";
      this.arena = { ...L.boss, sealed: false, won: false };
      if (L.camp?.rope) {
        s.ropeX = L.camp.rope.x;
        s.ropeY = L.camp.rope.y;
      }
    }
    // Campamento (cada 5 pisos, lo pone el generador): saco de dormir de pago y hoguera
    this.campFireLit = false;
    if (L.camp?.bag) {
      const id = this.spawnPickup("camp", L.camp.bag.x, L.camp.bag.y);
      s.pickups.get(id).price = Math.min(65535, 30 + s.floor * 4);
    }
    // Cofres del mapa
    for (const c of L.chests || []) this.spawnPickup("chest", c.x, c.y);
    // Halloween (siempre activo): calabazas llenas de Caramelos
    if (!L.boss) this.spawnPumpkins();
    // Cuerda Huida: cada 5 pisos aparece junto a la salida para volver al pueblo con todo
    if (!L.boss && s.floor > 1 && (s.floor - 1) % 5 === 0) {
      s.ropeX = L.spawns[0].x + 24;
      s.ropeY = L.spawns[0].y;
    }
    this.updateRoster();
    for (const pm of this.meta.values()) pm.floorReady = 0;
    // Incienso Estrella: se enciende solo en el primer piso del 50 para abajo
    if (!this.incenseFrom && s.floor >= (this.M.Zr?.from ?? 50) && [...this.meta.values()].some((m) => m.bag?.incense > 0)) {
      this.incenseFrom = s.floor;
      for (const m of this.meta.values()) if (m.bag?.incense) m.bag.incense--;
      this.fx.push({ t: "banner", text: { es: "¡Incienso Estrella encendido!", en: "Star Incense lit!" }, sub: { es: "+50 % de Trozos Estrella durante 5 pisos", en: "+50% Star Pieces for 5 floors" } });
    }
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      if (pm) this.offerLearn(p, pm);
    }
  }

  speciesPool() {
    const M = this.M;
    const s = this.state;
    const types = M.W[s.route] || ["normal"];
    const total = (st) => st.hp + st.atk + st.def + st.spa + st.spd + st.spe;
    const cap = 290 + s.floor * 18;
    const fit = Object.entries(M.Kr).filter(([, v]) => v.types.some((t) => types.includes(t)) && (v.capture ?? 45) >= 45);
    let foes = fit.filter(([, v]) => total(v.stats) <= cap).map(([k]) => k);
    if (foes.length < 6) foes = fit.sort((a, b) => total(a[1].stats) - total(b[1].stats)).slice(0, 12).map(([k]) => k);
    const alpha = fit.filter(([, v]) => total(v.stats) > cap && total(v.stats) <= cap + 120).map(([k]) => k);
    // Capa honda (pisos 26+): su fauna propia (tabla del juego) se mezcla con la del bioma
    if (s.floor > 25) {
      const deep = (M.ni?.[s.route]?.[1]?.fauna || []).filter((d) => M.Kr[d]);
      // ~40 % de lo que sale en la capa honda es su fauna
      if (deep.length) foes = [...foes, ...Array.from({ length: Math.ceil((foes.length * 0.67) / deep.length) }, () => deep).flat()];
    }
    return { foes, rescue: foes, alpha: alpha.length ? alpha : foes };
  }

  placePlayer(id, p, i) {
    const L = this.layout;
    const sp = L.spawns[i % L.spawns.length] || L.spawns[0];
    p.x = sp.x;
    p.y = sp.y;
    p.vx = 0;
    p.vy = 0;
    p.dodgeT = 0;
    p.holdT = 0;
    p.downed = false;
    const pm = this.meta.get(id);
    if (pm) pm.pred = null;
  }

  spawnEnemy(species, x, y, extra = {}) {
    const s = this.state;
    const e = initStrings(new Enemy());
    const id = "e" + ++this.enemySeq;
    const sp = this.M.Kr[species];
    const st = sp?.stats || { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 };
    e.kind = "wild";
    e.species = species;
    e.x = x;
    e.y = y;
    e.dir = Math.floor(Math.random() * 8);
    e.anim = "Idle";
    const mult = extra.boss ? (extra.legend ? 16 : 10) : extra.alpha ? 4 : 1;
    const hp = Math.round((18 + s.floor * 9) * (0.6 + st.hp / 110) * mult);
    e.maxHp = hp;
    e.hp = hp;
    e.alpha = !!extra.alpha;
    e.boss = !!extra.boss;
    s.enemies.set(id, e);
    this.enemyAI.set(id, {
      types: sp?.types || ["normal"],
      atk: Math.max(st.atk, st.spa),
      def: (st.def + st.spd) / 2,
      speed: clamp(34 + st.spe * 0.18, 34, 64) * (extra.alpha || extra.boss ? 0.9 : 1),
      slamT: extra.boss ? 3 : 0,
      move: this.M.ki(species),
      ranged: (() => {
        const mv = this.M.ki(species);
        return !!mv && mv.kind === "projectile" && (mv.range || 0) >= 100 && !extra.alpha && Math.random() < 0.7;
      })(),
      cd: rnd(0.5, 1.5),
      home: { x, y },
      wander: { x, y, t: 0 },
      pred: null,
      deadT: 0,
    });
    return id;
  }

  motionOf(o) {
    return { seq: 0, x: o.x, y: o.y, vx: o.vx ?? 0, vy: o.vy ?? 0, dodgeT: o.dodgeT ?? 0, dodgeX: o.dodgeX ?? 0, dodgeY: o.dodgeY ?? 0, dash: false, holdT: o.holdT ?? 0, frozen: false, locked: false };
  }

  playerEnv(p) {
    const blockers = [];
    for (const e of this.state.enemies.values()) if (!e.dead) blockers.push({ x: e.x, y: e.y, r: e.alpha ? 12 : 8, squeeze: !e.alpha });
    return { layout: this.layout, speed: p.speed || 80, flip: !!this.state.flip, surf: (this.state.hms || "").split(",").includes("surf"), blockers };
  }

  /** Un paso de movimiento con la física del juego (colisiones con el mapa incluidas). */
  stepMover(holder, o, dx, dy, env) {
    if (!holder.pred) holder.pred = new this.M.Bn(this.motionOf(o));
    const pr = holder.pred;
    pr.acc = 0;
    pr.advance(TICK, () => ({ x: dx, y: dy }), env, () => true);
    pr.pending.length = 0;
    const m = pr.motion;
    o.x = m.x;
    o.y = m.y;
    if (holder.isPlayer) {
      o.vx = m.vx;
      o.vy = m.vy;
      o.dodgeT = m.dodgeT;
      o.dodgeX = m.dodgeX;
      o.dodgeY = m.dodgeY;
      o.holdT = m.holdT ?? 0;
    }
    return m;
  }

  onInput(client, m) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!p || !pm || !Number.isInteger(m.seq) || m.seq <= p.seq) return;
    if (!this.layout || s.phase === "lobby") {
      p.seq = m.seq;
      return;
    }
    pm.isPlayer = true;
    const dx = clamp(Number(m.x) || 0, -1, 1);
    const dy = clamp(Number(m.y) || 0, -1, 1);
    const paused = !!s.pausedBy;
    if (!p.downed && !paused && s.phase === "exploring" && !p.evoTo && !p.frozen) {
      const env = this.playerEnv(p);
      if (p.paralyzed) env.speed *= 0.6;
      if (this.rd) env.speed *= this.raidSlow(p);
      this.stepMover(pm, p, dx, dy, env);
      p.moving = Math.hypot(p.vx, p.vy) > 10 || p.dodgeT > 0;
      if (dx || dy) p.dir = dirOf(dx, dy);
      // Empujar contra rocas agrietadas (Golpe Roca) o matorrales (tipo Fuego): misma regla que el cliente (Ss)
      if ((dx || dy) && !(p.dodgeT > 0)) {
        const o = this.M.Ss(this.layout, p.x, p.y, dx, dy, pm.types || ["normal"], this.hasHm("rock-smash"));
        if (o?.by) this.setTile(o.i, this.M.Ui(o.t));
      }
    }
    // Enfriamiento del básico, igual que el predictor del cliente
    if (!paused) {
      p.basicCd = Math.fround(Math.max(-1, p.basicCd - TICK));
      if (p.basicCd <= 0) {
        if (Array.isArray(m.aim) && m.aim.length && !p.downed) {
          const mv = this.M.ki(p.species);
          const lvBonus = Math.min(4, Math.floor(p.level / 5));
          // Igual que el juego: cooldown / (1 + 0,15·Ráfaga + 0,08·bono de nivel) / (Pañuelo activo ? 1,5 : 1)
          p.basicCd = Math.fround(mv ? mv.cooldown / (1 + 0.15 * upN(p, "haste") + 0.08 * lvBonus) / (p.frenzy ? 1.5 : 1) : 0.7);
          this.fireBasic(client.sessionId, p, mv, m.aim);
        } else {
          p.basicCd = Math.fround(0.1);
        }
      }
    }
    p.seq = m.seq;
  }

  onDodge(client, m) {
    const p = this.state.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!p || !pm || !Number.isInteger(m.seq) || m.seq <= p.seq) return;
    if (!p.downed && p.cdDodge <= 0.15 && this.layout) {
      pm.isPlayer = true;
      if (!pm.pred) pm.pred = new this.M.Bn(this.motionOf(p));
      const len = Math.hypot(m.x, m.y) || 1;
      pm.pred.act({ kind: "dodge", dir: { x: m.x / len, y: m.y / len } });
      pm.pred.pending.length = 0;
      const mo = pm.pred.motion;
      p.dodgeT = mo.dodgeT;
      p.dodgeX = mo.dodgeX;
      p.dodgeY = mo.dodgeY;
      p.cdDodge = (p.dodgeCd || 1.2) * (1 - 0.12 * upN(p, "reflex"));
      // Cinta Fuerte: esquivar a través de un enemigo le hace daño
      const ram = upN(p, "ram");
      if (ram) {
        const to = { x: p.x + (m.x / len) * 50, y: p.y + (m.y / len) * 50 };
        for (const [eid, e] of this.state.enemies) if (!e.dead && distToSegment(e, p, to) < 16) this.hitEnemy(eid, client.sessionId, p, pm, { power: (this.M._i?.ram?.power ?? 10) * ram * (pm.deep?.ram && [10, 11, 12, 13].includes(tileAt(this.layout, p)) ? 2 : 1), type: "normal", id: "tackle" });
      }
      pm.invuln = this.M.Wt?.invulnerable ?? 0.3;
    }
    p.seq = m.seq;
  }

  onSkill(client, m) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!p || !pm) return;
    if (Number.isInteger(m.seq) && m.seq > p.seq) p.seq = m.seq;
    const slot = Number(m.slot) === 2 ? 2 : 1;
    const id = p.specials.split(",")[slot - 1];
    const mv = id && this.M.Rn[id];
    if (!mv || p.downed || s.phase !== "exploring") return;
    const cdKey = slot === 1 ? "cd1" : "cd2";
    if (p[cdKey] > 0.1) return;
    const lvCd = 1 + (this.M.Ea?.cooldown ?? 0.1) * Math.min(4, Math.floor(p.level / 5));
    p[cdKey] = Math.min(63, ((mv.cooldown || 5) * ((pm.bag?.elixir || 0) > 0 && s.floor === this.startFloor ? 0.75 : 1)) / (1 + 0.2 * upN(p, "focus")) / lvCd);
    p.anim = mv.anim || "Attack";
    p.animSeq = (p.animSeq + 1) & 0xffff;
    const sid = client.sessionId;
    const M = this.M;
    const L = this.layout;
    const tgt = m.target && s.enemies.get(m.target);
    const area = 1 + (M._i?.area ?? 0.08) * upN(p, "area");
    const from = { x: p.x, y: p.y };
    let aim = Number.isFinite(m.x) ? { x: m.x, y: m.y } : tgt ? { x: tgt.x, y: tgt.y } : null;
    if (!aim) {
      const n = this.nearestEnemyPos(p, (mv.range || 100) * area);
      const f = M.Aa(p.dir);
      aim = n || { x: from.x + f.x * (mv.range || 100) * 0.6, y: from.y + f.y * (mv.range || 100) * 0.6 };
    }
    const enemies = [...s.enemies.entries()].filter(([, e]) => !e.dead).map(([id, e]) => ({ id, x: e.x, y: e.y }));
    const los = (x1, y1, x2, y2) => M.Ro(L, x1, y1 - 8, x2, y2 - 8);
    // Geometría, efectos y golpes con las MISMAS funciones del juego que usa el cliente para predecir
    const spot = M.ea(L, mv, from, aim, area);
    // Maestría «+»: cambia la forma del especial (rayo que cae en otro, línea doble, segundo estallido…)
    const plus = Number(p.specialLv.split(",")[slot - 1] || 0) >= 1;
    const strike = mv.kind === "strike" ? M.rc(enemies, spot, from, plus, los) : undefined;
    const cast = { layout: L, move: mv, from, face: M.Aa(p.dir), spot, area, plus, strike };
    this.addMastery(p, pm, slot);
    let fxs = { now: [] };
    try {
      fxs = M.Qi(cast) || fxs;
    } catch (e) {
      console.warn("[offline] cast", mv.id, e);
    }
    const trapId = mv.kind === "trap" ? "~" + ++this.trapSeq : null;
    for (const f of fxs.now || []) if (f.t === "trap" && trapId) f.id = trapId;
    this.toOthers(sid, fxs.now || []);
    let hits = [];
    try {
      hits = M.$i(cast, enemies, los) || [];
    } catch {}
    const hitAll = (ids, mult = 1) => {
      for (const eid of ids) this.hitEnemy(eid, sid, p, pm, mv, mult);
    };
    switch (mv.kind) {
      case "heal": {
        const r = (mv.radius || 60) * area;
        for (const [qid, q] of s.players) {
          if (q.downed || dist(q, p) > r) continue;
          const n = Math.round((q.maxHp * (mv.power || 15)) / 100);
          q.hp = Math.min(q.maxHp, q.hp + n);
          this.fx.push({ t: "heal", id: qid, n, x: q.x, y: q.y - 20 });
        }
        break;
      }
      case "shield":
        pm.invuln = Math.max(pm.invuln || 0, mv.duration || 2);
        p.shielded = true;
        pm.shieldT = mv.duration || 2;
        break;
      case "counter":
        pm.counter = { t: mv.duration || 1.2, mv };
        pm.invuln = Math.max(pm.invuln || 0, mv.duration || 1.2);
        break;
      case "dash": {
        // El cliente ya movió a su Pokémon por la misma ruta: aquí se repite para que no "rebote"
        if (!pm.pred) pm.pred = new M.Bn(this.motionOf(p));
        const path = M.xa(from.x, from.y, aim.x, aim.y, (mv.range || 100) * area, M.Aa(p.dir));
        pm.pred.act({ kind: "dash", path });
        pm.pred.pending.length = 0;
        const end = path?.[path.length - 1] || spot || aim;
        const r = (mv.radius || 14) + 8;
        hitAll(enemies.filter((e) => distToSegment(e, from, end) <= r).map((e) => e.id));
        break;
      }
      case "projectile": {
        // Vuela hasta el primer enemigo de su trayectoria
        const range = (mv.range || 110) * area;
        const dir = { x: aim.x - from.x, y: aim.y - from.y };
        const len = Math.hypot(dir.x, dir.y) || 1;
        const end = { x: from.x + (dir.x / len) * range, y: from.y + (dir.y / len) * range };
        const first = enemies.filter((e) => distToSegment(e, from, end) <= 14).sort((a2, b2) => dist(a2, from) - dist(b2, from))[0];
        if (first) this.pendingHits.push({ t: dist(first, from) / (mv.speed || 200), eid: first.id, sid, mv, mult: 1 });
        break;
      }
      case "zone":
        this.zones.push({ x: spot.x, y: spot.y, r: (mv.radius || 34) * area, left: mv.duration || 4, every: 0.5, acc: 0, sid, mv, ticks: Math.max(1, Math.round((mv.duration || 4) / 0.5)) });
        break;
      case "trap":
        this.traps.push({ id: trapId, x: spot.x, y: spot.y, r: (mv.radius || 26) * area, left: mv.duration || 20, sid, mv });
        break;
      default:
        hitAll(hits);
    }
    if (fxs.later) {
      const later = fxs.later;
      this.clock.setTimeout(() => {
        const q = s.players.get(sid);
        if (!q || q.downed) return;
        this.toOthers(sid, later.fx({ x: q.x, y: q.y }) || []);
      }, later.delay * 1000);
    }
    p.ult = Math.min(1, p.ult + 0.08);
  }

  /** ¿Entra alguien en la arena? Se cierra la puerta y aparece el guardián. */
  tickArena() {
    const a = this.arena;
    const s = this.state;
    if (!a || a.sealed || !s.legend) return;
    const gateY = Math.floor(a.gate[0] / this.layout.width) * 16;
    const inside = [...s.players.values()].some((p) => !p.downed && p.y < gateY - 4 && Math.hypot(p.x - a.x, p.y - a.y) < a.r);
    if (!inside) return;
    a.sealed = true;
    for (const i of a.gate) this.setTile(i, 1);
    this.bossId = this.spawnEnemy(s.legend, a.x, a.y - 16, { boss: true, legend: true });
    const sp = this.M.Kr[s.legend];
    this.fx.push({ t: "boss-intro", name: sp?.names, title: this.M.wn?.[s.route], x: a.x, y: a.y - 16 });
  }

  /** Guardián vencido: tirada para que se quede (fórmula del juego: 35 % + 20 % con Baya Frambu + 10 % por cada vez que se escapó). */
  guardianBeaten(e, sid) {
    const s = this.state;
    const a = this.arena;
    this.legendsBeaten = (this.legendsBeaten || 0) + 1;
    if (s.floor === 25) this.plateWon = true;
    const razz = [...this.meta.values()].some((m) => (m.bag?.razz || 0) > 0);
    const chance = this.M.Zi ? this.M.Zi(razz, this.legendPity || 0) : Math.min(0.95, 0.35 + (razz ? 0.2 : 0) + 0.1 * (this.legendPity || 0));
    const ok = Math.random() < chance;
    if (razz) for (const m of this.meta.values()) if (m.bag?.razz) m.bag.razz--;
    if (ok) {
      this.carried.push(s.legend);
      this.legendCaught = true;
      if (s.floor % 25 === 0) this.guardianSpecies = s.legend;
      this.legendPity = 0;
    } else {
      this.legendEscaped = (this.legendEscaped || 0) + 1;
      this.legendPity = (this.legendPity || 0) + 1;
    }
    this.fx.push({ t: "capture", x: e.x, y: e.y, ok, species: s.legend, by: sid });
    // Se abre la Etapa siguiente: la próxima vez se puede empezar en el piso de después
    if (!this.campsSaved.includes(s.floor + 1)) this.campsSaved.push(s.floor + 1);
    this.fx.push({ t: "camp-saved", floor: s.floor + 1 });
    if (a) {
      a.won = true;
      for (const i of a.gate) this.setTile(i, 0);
      if (this.layout.campWin?.rope) {
        s.ropeX = this.layout.campWin.rope.x;
        s.ropeY = this.layout.campWin.rope.y;
      }
    }
  }

  rollEvent(route, floor) {
    // Lodazal: su peligro de bioma es "lluvia y barro"
    if (route === "swamp" && floor <= 25 && floor >= 2 && Math.random() < 0.5) return "rain";
    if (floor < 3 || Math.random() > Math.min(0.35, 0.12 + floor * 0.01)) return "";
    const by = {
      forest: ["fog", "rain", "dim"],
      desert: ["dim", "dark"],
      lava: ["dark", "dim"],
      sea: ["rain", "fog"],
      ice: ["snow", "fog", "dim"],
      swamp: ["fog", "fog", "rain"],
      ruins: ["dark", "dark", "dim"],
      shroom: ["dark", "dim", "fog"],
      storm: ["rain", "dark"],
    }[route] || ["dim"];
    return pick(by);
  }

  /** Saco de dormir del campamento: el grupo recupera media vida, pagando con las Pokecoins de la expedición. */
  onCamp(client) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    if (!p || p.downed) return;
    const entry = [...s.pickups.entries()].find(([, k]) => k.kind === "camp");
    if (!entry || dist(entry[1], p) > 44 || s.coins < entry[1].price) return;
    s.coins -= entry[1].price;
    s.pickups.delete(entry[0]);
    for (const [qid, q] of s.players) {
      if (q.downed) continue;
      const n = Math.round(q.maxHp / 2);
      q.hp = Math.min(q.maxHp, q.hp + n);
      this.fx.push({ t: "heal", id: qid, n, x: q.x, y: q.y - 20 });
    }
  }

  tickCamp() {
    const c = this.layout?.camp?.fire;
    if (!c || this.campFireLit) return;
    for (const p of this.state.players.values()) {
      if (!p.downed && dist(p, c) < 40) {
        this.campFireLit = true;
        this.fx.push({ t: "fire-lit", x: c.x, y: c.y });
        return;
      }
    }
  }

  hasHm(id) {
    return (this.state.hms || "").split(",").includes(id);
  }

  /** Cambia una casilla del piso (roca rota, matorral ardiendo) y la sincroniza con todos. */
  setTile(i, t) {
    const L = this.layout;
    if (!L || t === undefined || i < 0 || i >= L.width * L.height) return;
    const row = L.tiles[Math.floor(i / L.width)];
    if (row[i % L.width] === t) return;
    row[i % L.width] = t;
    this.state.mods.set(String(i), t);
  }

  /** Disparo sin blanco: vuela en la dirección del Pokémon y, si choca con algo rompible, lo rompe (Bi). */
  shotWall(p, mv) {
    const L = this.layout;
    const f = this.M.Aa(p.dir);
    const range = mv.range || 110;
    for (let d = 8; d <= range; d += 6) {
      const x = p.x + f.x * d;
      const y = p.y - 10 + f.y * d;
      const tx = Math.floor(x / 16);
      const ty = Math.floor(y / 16);
      const t = L.tiles[ty]?.[tx];
      if (t === undefined) return;
      if (t === 0 || t === 3 || t === 2 || t === 14 || t === 15) continue;
      const nt = this.M.Bi(t, mv.type, this.meta.get([...this.state.players.entries()].find(([, q]) => q === p)?.[0])?.types || [], this.hasHm("rock-smash"));
      if (nt !== undefined) this.setTile(ty * L.width + tx, nt);
      return;
    }
  }

  /** Cada uso llena el aro amarillo: 80 usos → «+», 180 más → ★ (y el movimiento evoluciona). Tabla del juego (Vo, Ia). */
  addMastery(p, pm, slot) {
    const ids = p.specials.split(",");
    const lvs = p.specialLv.split(",").map(Number);
    pm.uses ||= [0, 0];
    const i = slot - 1;
    const lv = lvs[i] || 0;
    if (lv >= 2 || !ids[i]) return;
    const need = this.M.Vo(lv);
    if (++pm.uses[i] >= need) {
      pm.uses[i] = 0;
      lvs[i] = lv + 1;
      if (lvs[i] >= 2) {
        const evo = this.M.Ia(ids[i]);
        if (evo && this.M.Rn[evo]) ids[i] = evo;
        p.specials = ids.join(",");
      }
      p.specialLv = lvs.join(",");
    }
    p.mastery = ids.map((_, k) => ((lvs[k] || 0) >= 2 ? 100 : Math.round(((pm.uses[k] || 0) / this.M.Vo(lvs[k] || 0)) * 100))).join(",");
  }

  /** Movimiento nuevo: se ofrece al llegar al piso (uno de los especiales que puede llevar por sus tipos y aún no lleva). */
  offerLearn(p, pm) {
    if (p.learn || !p.learnPending) return;
    const have = new Set(p.specials.split(",").filter(Boolean));
    for (const id of [...have]) {
      const base = Object.keys(this.M.Rn).find((k) => this.M.Ia(k) === id);
      if (base) have.add(base);
    }
    let pool = [];
    try {
      pool = (this.M.ko(p.species) || []).filter((m) => this.M.Rn[m] && !have.has(m));
    } catch {}
    p.learnPending--;
    if (pool.length) p.learn = pick(pool);
  }

  onChoose(client, m) {
    const p = this.state.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!p || !pm || !p.learn || (m.learn && m.learn !== p.learn)) return;
    const i = Number(m.index);
    if (i === 0 || i === 1) {
      const ids = p.specials.split(",");
      const lvs = p.specialLv.split(",");
      while (ids.length < 2) ids.push("");
      while (lvs.length < 2) lvs.push("0");
      // El hueco conserva lo crecido (si ya era ★, el nuevo llega evolucionado)
      ids[i] = Number(lvs[i]) >= 2 && this.M.Rn[this.M.Ia(p.learn)] ? this.M.Ia(p.learn) : p.learn;
      p.specials = ids.filter((x, k) => x || k === 0).join(",");
      p.specialLv = lvs.slice(0, p.specials.split(",").length).join(",");
      (pm.uses ||= [0, 0])[i] = 0;
      if (i === 0) p.cd1 = 0;
      else p.cd2 = 0;
    }
    p.learn = "";
    this.offerLearn(p, pm);
  }

  /** Efectos para los demás jugadores (el que lanza ya los dibujó al predecir). */
  toOthers(sid, list) {
    if (!list.length) return;
    for (const c of this.clients) if (c.sessionId !== sid) c.send("fxs", list);
  }

  tickAreas(dt) {
    const s = this.state;
    for (const z of this.zones) {
      z.left -= dt;
      // Lente Amplia · de Hondonada: tus zonas sobre un sumidero atraen a los enemigos
      if (this.meta.get(z.sid)?.deep?.area && this.hz?.holes.some((h) => dist(h, z) < h.r)) {
        for (const e of s.enemies.values()) {
          const d = dist(e, z);
          if (!e.dead && !e.boss && d > 4 && d < z.r * 2) {
            e.x += ((z.x - e.x) / d) * 40 * dt;
            e.y += ((z.y - e.y) / d) * 40 * dt;
          }
        }
      }
      z.acc += dt;
      if (z.acc >= z.every) {
        z.acc = 0;
        const p = s.players.get(z.sid);
        const pm = this.meta.get(z.sid);
        if (p && pm) for (const [eid, e] of s.enemies) if (!e.dead && dist(e, z) <= z.r + 6) this.hitEnemy(eid, z.sid, p, pm, z.mv, 1 / Math.max(2, z.ticks / 2));
      }
    }
    this.zones = this.zones.filter((z) => z.left > 0);
    for (const t of this.traps) {
      t.left -= dt;
      const p = s.players.get(t.sid);
      const pm = this.meta.get(t.sid);
      const victim = [...s.enemies.entries()].find(([, e]) => !e.dead && dist(e, t) <= t.r);
      if (victim && p && pm) {
        for (const [eid, e] of s.enemies) if (!e.dead && dist(e, t) <= t.r + 10) this.hitEnemy(eid, t.sid, p, pm, t.mv);
        t.left = 0;
      }
      if (t.left <= 0) this.fx.push({ t: "trap", id: t.id, on: false, x: t.x, y: t.y });
    }
    this.traps = this.traps.filter((t) => t.left > 0);
  }

  onUlt(client, m) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!p || !pm || p.ult < 1 || p.downed) return;
    if (Number.isInteger(m.seq) && m.seq > p.seq) p.seq = m.seq;
    p.ult = 0;
    const mv = this.M.ki(p.species) || { power: 10, type: "normal", id: "tackle" };
    this.fx.push({ t: "ult", id: client.sessionId, x: p.x, y: p.y, r: 120, ty: mv.type, phase: "fire" });
    for (const [eid, e] of s.enemies) if (!e.dead && dist(e, p) <= 130) this.hitEnemy(eid, client.sessionId, p, pm, { ...mv, power: mv.power * 6 }, 1, true);
  }

  onMenu(client, m) {
    const s = this.state;
    if (s.players.size === 1) s.pausedBy = m.open ? "·menu" : "";
    const p = s.players.get(client.sessionId);
    if (p && Number.isInteger(m.seq) && m.seq > p.seq) p.seq = m.seq;
  }

  nearestEnemy(p, maxD) {
    let best = null;
    let bd = maxD;
    for (const [id, e] of this.state.enemies) {
      if (e.dead) continue;
      const d = dist(e, p);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }
  nearestEnemyPos(p, maxD) {
    const id = this.nearestEnemy(p, maxD);
    const e = id && this.state.enemies.get(id);
    return e ? { x: e.x, y: e.y } : null;
  }

  fireBasic(sid, p, mv, aim) {
    if (!mv) return;
    const s = this.state;
    p.anim = mv.anim || "Shoot";
    p.animSeq = (p.animSeq + 1) & 0xffff;
    const speed = mv.speed || 200;
    if (aim.includes("@")) this.shotWall(p, mv);
    for (const tid of aim) {
      const e = tid !== "@" && s.enemies.get(tid);
      if (!e || e.dead) continue;
      const d = dist(p, e);
      if (d > (mv.range || 110) + 40) continue;
      this.pendingHits.push({ t: d / speed, eid: tid, sid, mv, basic: true });
    }
    // Dados Trucados: otro enemigo cercano recibe un disparo al 70 %
    const split = upN(p, "split") + upN(p, "pierce");
    if (split) {
      const hit = new Set(aim);
      const extra = [...s.enemies.entries()].filter(([id, e]) => !e.dead && !hit.has(id) && dist(p, e) <= (mv.range || 110)).sort((a, b) => dist(p, a[1]) - dist(p, b[1])).slice(0, split);
      for (const [id, e] of extra) this.pendingHits.push({ t: dist(p, e) / speed, eid: id, sid, mv, basic: true, mult: 0.7 });
    }
  }

  hitEnemy(eid, sid, p, pm, mv, mult = 1, big = false) {
    if (typeof mult === "number") mult = { m: mult };
    const s = this.state;
    const e = s.enemies.get(eid);
    const ai = this.enemyAI.get(eid);
    if (!e || e.dead || !ai) return;
    const eff = effectiveness(mv.type, ai.types);
    const stab = pm.types.includes(mv.type) ? 1.2 : 1;
    // Periscopio · de Bruma: desde la niebla, tus golpes son críticos
    const crit = (pm.deep?.crit && this.state.event === "fog") || Math.random() < 0.06 + 0.05 * upN(p, "crit");
    // Pila · Rúnica: sobre una losa rúnica encendida, tus especiales pegan aún más
    const onRune = pm.deep?.overload && this.hz?.pend.some((w) => w.ty === "psychic" && w.circles.some((c) => dist(c, p) <= c.r + 4));
    const special = !mult.basic && mv.kind !== undefined && mv.cooldown > 1.5;
    const upMul = (1 + (this.M._i?.power ?? 0.15) * upN(p, "power")) * (special ? 1 + (this.M._i?.overload ?? 0.2) * upN(p, "overload") * (onRune ? 2 : 1) : 1);
    let dmg = upMul * (mv.power || 6) * (pm.dmgMul || 1) * (pm.meal?.includes("curry") ? 1.12 : 1) * (pm.obeliskT > 0 ? 1.3 : 1) * this.pactDamage(p) * Math.sqrt(75 / Math.max(20, ai.def)) * eff * stab * (typeof mult === "number" ? mult : mult.m) * rnd(0.9, 1.1) * (crit ? 2 : 1) * ((e.wet || s.event === "rain") && mv.type === "electric" ? 1.25 : 1) * this.deepGuard(e, ai) * (s.raid && eid === this.bossId ? this.raidTaken() : 1);
    dmg = Math.max(1, Math.round(dmg));
    e.hp = Math.max(0, e.hp - dmg);
    ai.aggro = Math.max(ai.aggro || 0, 6);
    this.fx.push({ t: "dmg", id: eid, by: sid, x: e.x, y: e.y - 16, n: dmg, crit, eff: eff > 1 ? 1 : eff < 1 ? -1 : 0, ty: mv.type, mv: mv.id, big: big || undefined });
    // Raíz Grande: te curas el 1 % del daño (con tope por golpe)
    // Raíz Grande · Antigua: se duplica sobre hierba alta
    const leech = upN(p, "leech") * (pm.deep?.leech && tileAt(this.layout, p) === 3 ? 2 : 1);
    if (leech) p.hp = Math.min(p.maxHp, p.hp + Math.min(dmg * 0.01 * leech, p.maxHp * 0.006 * leech));
    // Estados del movimiento (quemado, envenenado, paralizado, congelado, mojado)
    const st = mv.applies?.status;
    if (st && Math.random() < (mv.cooldown > 1.5 ? 0.8 : 0.3)) {
      ai.st ||= {};
      ai.st[st] = Math.max(ai.st[st] || 0, mv.applies.duration || 3);
      ai.stBy = sid;
      if (st in e) e[st] = true;
    }
    if (e.hp <= 0) this.killEnemy(eid, sid);
    s.combo = Math.min(65535, s.combo + 1);
    s.comboT = 1;
    s.bestCombo = Math.max(s.bestCombo, s.combo);
  }

  killEnemy(eid, sid) {
    const s = this.state;
    const e = s.enemies.get(eid);
    const ai = this.enemyAI.get(eid);
    if (!e || e.dead) return;
    e.dead = true;
    // Pacto de las almas: cada enemigo vencido cura un 5 % de los PS máximos
    const kp = s.players.get(sid);
    if (kp?.pact === "souls" && !kp.downed) kp.hp = Math.min(kp.maxHp, kp.hp + kp.maxHp * 0.05);
    e.anim = "Hurt";
    e.animSeq = (e.animSeq + 1) & 0xffff;
    ai.deadT = 1.2;
    s.kills++;
    if (e.alpha) s.alphas++;
    const alive = [...s.enemies.values()].filter((x) => !x.dead).length;
    this.fx.push({ t: "kill", id: eid, by: sid, x: e.x, y: e.y, alpha: e.alpha || undefined, last: alive === 0 || undefined });
    const big = e.boss ? 10 : e.alpha ? 4 : 1;
    const killer = s.players.get(sid);
    if (killer && !killer.downed) {
      const rg = upN(killer, "regen");
      if (rg) killer.hp = Math.min(killer.maxHp, killer.hp + killer.maxHp * 0.01 * rg);
      const fz = upN(killer, "frenzy");
      if (fz) {
        killer.frenzy = true;
        const km = this.meta.get(sid);
        if (km) km.frenzyT = (this.M._i?.frenzy?.secs ?? 2) + (this.M._i?.frenzy?.perLevel ?? 1.5) * (fz - 1);
      }
    }
    this.dropLoot(e.x, e.y, big * (ai?.loot || 1), false, killer ? upN(killer, "fortune") : 0, e);
    if (ai?.deep) this.dropDeep(e.x + 10, e.y + 6);
    if (eid === this.bossId) {
      this.bossId = null;
      this.bossesBeaten = (this.bossesBeaten || 0) + 1;
      if (s.raid && this.rd) this.raidWin(e);
      else if (s.legend && e.species === s.legend) {
        if (s.mansion) this.mansionWin();
        else this.guardianBeaten(e, sid);
      }
    }
    const xp = Math.round((6 + s.floor * 2) * (e.boss ? 12 : e.alpha ? 5 : 1));
    for (const [id, p] of s.players) if (!p.downed) this.giveXp(id, p, xp);
  }

  giveXp(id, p, xp) {
    const pm = this.meta.get(id);
    if (!pm) return;
    let total = p.xp + Math.round(xp * (pm.meal?.includes("sitrus-pie") ? 1.2 : 1));
    while (total >= p.xpNext && p.level < 100) {
      total -= p.xpNext;
      pm.level = p.level + 1;
      this.applyStats(p, pm);
      p.hp = Math.min(p.maxHp, p.hp + (this.M.Tn?.heal ?? 15));
      // Cada 5 niveles quiere aprender un movimiento nuevo (se ofrece al llegar al próximo piso)
      const learn = p.level % 5 === 0;
      if (learn) p.learnPending = Math.min(255, p.learnPending + 1);
      this.fx.push({ t: "level", id, level: p.level, learn });
    }
    p.xp = Math.min(65535, total);
    this.checkEvolve(p, pm);
  }

  /** Evoluciona (o "despierta", si ya no tiene más evoluciones) al llegar al nivel que marca el juego. */
  checkEvolve(p, pm) {
    if (p.evoTo || p.downed) return;
    const lvl = this.M.is(p.species, p.evolved);
    if (lvl == null || p.level < lvl) return;
    const C = this.M.qt;
    const kids = this.evoOptions(p.species);
    if (kids.length > 1) {
      // Varias ramas (Eevee, Gloom…): el jugador elige en la ventana del juego; si no, al acabar el tiempo, una al azar
      p.evoTo = "?";
      p.evoT = C?.choose ?? 10;
      pm.invuln = Math.max(pm.invuln || 0, p.evoT + 0.2);
      return;
    }
    p.evoTo = kids.length ? kids[0] : "+";
    p.evoT = C?.seconds ?? 2;
    pm.invuln = Math.max(pm.invuln || 0, p.evoT + 0.2);
  }

  evoOptions(dex) {
    let kids = [];
    try {
      kids = (this.M.La(dex) || []).filter((k) => this.M.Kr[k]);
    } catch {}
    if (!kids.length) kids = (this.kids.get(Number(dex)) || []).filter((k) => this.M.Kr[k]);
    return kids;
  }

  onEvolveChoice(client, m) {
    const p = this.state.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!p || !pm || p.evoTo !== "?") return;
    const dex = String(m?.dex || "");
    if (!this.evoOptions(p.species).includes(dex)) return;
    p.evoTo = dex;
    p.evoT = this.M.qt?.seconds ?? 2;
    pm.invuln = Math.max(pm.invuln || 0, p.evoT + 0.2);
  }

  finishEvolve(id, p, pm) {
    if (p.evoTo === "?") {
      // Se acabó el tiempo para elegir
      p.evoTo = pick(this.evoOptions(p.species)) || "+";
      p.evoT = this.M.qt?.seconds ?? 2;
      return;
    }
    const from = this.M.Kr[p.species]?.names;
    if (p.evoTo === "+") {
      pm.awaken = Math.min(2, (pm.awaken || 0) + 1);
      p.evolved = Math.min(2, p.evolved + 1);
      this.applyStats(p, pm);
      this.fx.push({ t: "banner", to: id, text: { es: `¡${from?.es || "Tu Pokémon"} ha despertado su poder!`, en: `${from?.en || "Your Pokémon"} awakened!` } });
    } else {
      p.species = p.evoTo;
      p.evolved = Math.min(2, p.evolved + 1);
      this.applyStats(p, pm);
      p.hp = p.maxHp;
      const to = this.M.Kr[p.species]?.names;
      this.fx.push({ t: "banner", to: id, text: { es: `¡${from?.es} evolucionó a ${to?.es}!`, en: `${from?.en} evolved into ${to?.en}!` } });
      this.updateRoster();
    }
    p.evoTo = "";
    p.evoT = 0;
    pm.pred = null;
  }

  // ---------- Botín ----------
  spawnPickup(kind, x, y, val = 0) {
    const pk = initStrings(new Pickup());
    pk.kind = kind;
    pk.x = x;
    pk.y = y;
    const id = "k" + ++this.pickSeq;
    this.state.pickups.set(id, pk);
    if (val) this.pickVal.set(id, val);
    return id;
  }

  /** Lo que suelta un enemigo (o un cofre): monedas, bayas, materiales y, rara vez, caramelos. */
  dropLoot(x, y, big = 1, chest = false, fortune = 0, foe = null) {
    const s = this.state;
    const spot = () => this.freeSpot(x, y, chest ? 26 : 14);
    // Objetos hondos (capa honda): el alfa de la capa siempre suelta el suyo; los cofres, a veces
    if (s.floor > 25 && chest && Math.random() < 0.15) {
      const q = spot();
      this.dropDeep(q.x, q.y);
    }
    // Objetos de mejora: cofres, alfas y jefes (los de la Biblioteca solo si están desbloqueados)
    if (chest ? Math.random() < 0.55 : foe?.boss ? true : foe?.alpha ? Math.random() < 0.6 : Math.random() < 0.015) {
      const q = spot();
      this.spawnPickup("up-" + pick(this.upgradePool()), q.x, q.y);
    }
    // Escamas Corazón y boletos
    if (foe?.boss || (foe?.alpha && Math.random() < 0.25) || (chest && Math.random() < 0.12)) {
      const q = spot();
      this.spawnPickup("res-heartScales", q.x, q.y, foe?.boss && s.floor % 10 === 0 ? 2 : 1);
    }
    // Trozos Estrella: desde el piso 50 (tabla Zr del juego): alfas 1, jefes 2 (+2 cada 50 pisos), cofres 25 %.
    // Incienso Estrella: +50 % durante 5 pisos desde el primero del 50 para abajo.
    const SP = this.M.Zr || { from: 50, step: 50, alpha: 1, boss: 2, bossStep: 2, chest: 0.25 };
    if (s.floor >= SP.from) {
      let n = foe?.boss ? SP.boss + SP.bossStep * Math.floor((s.floor - SP.from) / SP.step) : foe?.alpha ? SP.alpha : chest && Math.random() < SP.chest ? 1 : 0;
      if (n && this.incenseFrom && s.floor < this.incenseFrom + 5) n = Math.ceil(n * 1.5);
      if (n) {
        const q = spot();
        this.spawnPickup("res-starPieces", q.x, q.y, n);
      }
    }
    if (foe?.boss || (chest && Math.random() < 0.08)) {
      const q = spot();
      this.spawnPickup("ticket", q.x, q.y);
    }
    const n = chest ? 2 + Math.floor(Math.random() * 3) : big > 1 ? 2 + Math.floor(big / 3) : 1;
    for (let i = 0; i < n; i++) {
      const q = spot();
      this.spawnPickup("coin", q.x, q.y, Math.round((rnd(1, 3) + s.floor * 0.5) * (chest ? 2 : 1) * Math.max(1, big / 2) * (1 + 0.15 * fortune) * COIN_EVENT * (s.route === featuredRoute() && !s.mansion ? 1.5 : 1)));
    }
    if (Math.random() < (chest ? 0.7 : 0.18 * big)) {
      const q = spot();
      this.spawnPickup("berry", q.x, q.y);
    }
    if (Math.random() < (chest ? 0.9 : 0.12 * big)) {
      const q = spot();
      this.spawnPickup("res-" + pick(RES_KINDS), q.x, q.y, chest ? 3 : 1 + Math.floor(big / 3));
    }
    // Mansión: los fantasmas sueltan Caramelos
    if (s.mansion) this.mansionLoot(x, y, chest ? 4 : 1 + (Math.random() < 0.4 ? 1 : 0));
    // Hojas de menta (para el Herbolario)
    if (Math.random() < (chest ? 0.35 : 0.04 * big)) {
      const q = spot();
      this.spawnPickup("leaf-" + pick(["atk", "def", "spa", "spd", "spe"]), q.x, q.y);
    }
  }

  upgradePool() {
    const pool = [...(this.M.z || ["power", "haste", "vitality", "swift", "regen", "area", "focus", "crit", "guard", "fortune"])];
    const unlocked = new Set();
    for (const pm of this.meta.values()) for (const u of (pm.user ? guildOf(pm.user).unlocked || [] : [])) unlocked.add(u);
    return [...pool, ...unlocked];
  }

  freeSpot(x, y, r) {
    const L = this.layout;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.4 + Math.random() * 0.6);
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      const tx = Math.floor(px / 16);
      const ty = Math.floor(py / 16);
      if (L.tiles?.[ty]?.[tx] !== undefined && L.tiles[ty][tx] !== 1) return { x: px, y: py };
    }
    return { x, y };
  }

  collect(id, p, pm, kid, pk) {
    const s = this.state;
    const val = this.pickVal.get(kid) || 1;
    s.pickups.delete(kid);
    this.pickVal.delete(kid);
    this.fx.push({ t: "pick", kind: pk.kind, x: pk.x, y: pk.y, id });
    if (pk.kind === "chest") {
      if (s.mansion) this.mansionLoot(pk.x, pk.y, 4 + Math.floor(Math.random() * 4));
      else this.dropLoot(pk.x, pk.y, 1, true);
    } else if (pk.kind === "coin") {
      s.coins += val * this.pactGreed(p);
    } else if (pk.kind === "berry") {
      if (p.hp < p.maxHp && !this.pactNoHeal(p)) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
      else s.berries = Math.min(65535, s.berries + 1);
    } else if (pk.kind.startsWith("up-") || pk.kind.startsWith("deep-")) {
      const deepK = pk.kind.startsWith("deep-");
      const k = pk.kind.slice(deepK ? 5 : 3);
      if (deepK) (pm.deep ||= {})[k] = true;
      const cur = ups(p);
      const max = this.M.gi?.[k]?.max ?? 3;
      if ((cur[k] || 0) < max) cur[k] = (cur[k] || 0) + 1;
      else s.coins += 10 + s.floor;
      p.upgrades = Object.entries(cur).map(([a, n]) => `${a}:${n}`).join(",");
      this.applyStats(p, pm);
      const deepInfo = deepK ? this.M.ni?.[s.route]?.[1]?.deepItem : null;
      this.fx.push({ t: "item", id, up: k, lv: cur[k] || 0, max, x: p.x, y: p.y, ...(deepInfo ? { deep: { names: deepInfo.names, desc: deepInfo.desc } } : {}) });
    } else if (pk.kind.startsWith("leaf-")) {
      const k = pk.kind.slice(5);
      pm.leaves ||= {};
      pm.leaves[k] = (pm.leaves[k] || 0) + 1;
      p.leaves = Object.entries(pm.leaves).map(([a, n]) => `${a}:${n}`).join(",");
    } else if (pk.kind === "ticket") {
      s.tickets = Math.min(65535, s.tickets + 1);
    } else if (pk.kind === "res-heartScales") {
      this.heartScales = (this.heartScales || 0) + val;
    } else if (pk.kind === "res-starPieces") {
      this.starPieces = Math.min(this.M.Zr?.max ?? 400, (this.starPieces || 0) + val);
    } else if (pk.kind.startsWith("res-")) {
      const k = pk.kind.slice(4);
      if (k in s) s[k] = Math.min(65535, s[k] + val);
    } else if (pk.kind === "candy") {
      // Caramelos de Halloween (Pacto de la codicia: el doble)
      s.candies = Math.min(65535, s.candies + val * this.pactGreed(p));
    } else if (pk.kind === "pumpkin") {
      s.candies = Math.min(65535, s.candies + 3 + Math.floor(Math.random() * 4));
    } else if (pk.kind === "mimic") {
      this.openMimic(pk);
    }
  }

  hurtPlayer(id, p, dmg, ty, from) {
    const pm = this.meta.get(id);
    if (!pm || p.downed) return;
    if ((pm.invuln || 0) > 0 || p.dodgeT > 0) return;
    const s = this.state;
    // Gafa Protectora: el primer golpe de cada piso no hace daño
    if (upN(p, "deepshield") && pm.shieldFloor !== s.floor) {
      pm.shieldFloor = s.floor;
      this.fx.push({ t: "dmg", id, by: from, x: p.x, y: p.y - 16, n: 0, ally: true, ty });
      return;
    }
    dmg *= (1 - 0.1 * upN(p, "guard")) * (pm.taken || 1) * this.pactTaken(p);
    if (pm.counter && pm.counter.t > 0 && from && s.enemies.get(from)) {
      // Contraataque (Búnker, Contraataque…): el que pega se lleva el golpe y el estado
      this.hitEnemy(from, id, p, pm, pm.counter.mv);
      this.fx.push({ t: "ring", x: p.x, y: p.y, r: 22, spring: true, ty: pm.counter.mv.type, mv: pm.counter.mv.id });
      pm.counter = null;
      return;
    }
    // Casco Dentado: el atacante cuerpo a cuerpo recibe daño
    const th = upN(p, "thorns");
    const foe = from && s.enemies.get(from);
    // Casco Dentado · Glacial: sobre el hielo, las púas pegan el doble
    const glacial = pm.deep?.thorns && tileAt(this.layout, p) === 15 ? this.M._i?.thorns?.glacial ?? 2 : 1;
    if (th && foe && !foe.dead && dist(foe, p) < 40) this.hitEnemy(from, id, p, pm, { power: (this.M._i?.thorns?.power ?? 10) * th * glacial, type: "normal", id: "tackle" });
    // Estado según el tipo del atacante
    const fs = FOE_STATUS[ty];
    if (fs && Math.random() < 0.12) {
      pm.st ||= {};
      pm.st[fs[0]] = fs[1];
      if (fs[0] in p) p[fs[0]] = true;
    }
    const d = Math.max(1, Math.round(dmg));
    p.hp = Math.max(0, p.hp - d);
    this.fx.push({ t: "dmg", id, by: from, x: p.x, y: p.y - 16, n: d, ally: true, ty });
    s.combo = 0;
    if (p.hp <= 0 && upN(p, "secondwind") && pm.windFloor !== s.floor) {
      // Revivir (objeto de mejora): te levantas con el 40 % una vez por piso
      pm.windFloor = s.floor;
      p.hp = Math.round(p.maxHp * 0.4);
      pm.invuln = 1.5;
      return;
    }
    if (p.hp <= 0 && (pm.bag?.seed || 0) > 0 && pm.seedFloor !== s.floor) {
      // Semilla Revivir: te levantas con el 75 % (una vez por piso)
      pm.bag.seed--;
      pm.seedFloor = s.floor;
      p.hp = Math.round(p.maxHp * 0.75);
      pm.invuln = 1.5;
      p.bag = Object.entries(pm.bag).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(",");
      this.fx.push({ t: "banner", to: id, text: { es: "¡La Semilla Revivir te levanta!", en: "The Revive Seed gets you up!" } });
      return;
    }
    if (p.hp <= 0) {
      p.downed = true;
      if (pm.user && pm.resident) {
        tire(guildOf(pm.user), pm.resident, s.floor);
        save();
      }
      p.hp = 0;
      p.anim = "Hurt";
      p.animSeq = (p.animSeq + 1) & 0xffff;
      if ([...s.players.values()].every((q) => q.downed)) this.wipe();
    }
  }

  wipe() {
    const s = this.state;
    if (s.phase !== "exploring") return;
    s.phase = "wipe";
    this.fx.push({ t: "banner", text: { es: "Habéis caído…", en: "You fainted…" } });
    this.clock.setTimeout(() => this.endRun(false), 2500);
  }

  goNextFloor() {
    const s = this.state;
    if (s.rescued && s.rescueSpecies) {
      this.carried.push(s.rescueSpecies);
      s.rescuedTotal++;
    }
    for (const p of s.players.values()) {
      p.carried = this.carried.join(",");
      if (p.downed) {
        p.downed = false;
        p.hp = Math.round(p.maxHp * 0.3);
      }
    }
    s.floor = Math.min(65535, s.floor + 1);
    this.newFloor();
  }

  /** Fin de la expedición: guarda el botín en el refugio de cada jugador de este teléfono y los manda al pueblo. */
  endRun(extracted) {
    const s = this.state;
    if (s.phase === "ended" || s.phase === "lobby") return;
    s.phase = "ended";
    const keep = extracted ? 1 : 0.25;
    const coins = Math.round(s.coins * keep);
    const res = { berries: Math.round(s.berries * keep), materials: Math.round(s.materials * keep), crystals: Math.round(s.crystals * keep), candies: Math.round(s.candies * keep), tickets: Math.round(s.tickets * keep), heartScales: Math.round((this.heartScales || 0) * keep), starPieces: Math.round((this.starPieces || 0) * keep) };
    const rescued = extracted ? [...this.carried, ...(s.rescued ? [s.rescueSpecies] : [])] : [];
    const lost = extracted ? [] : [...this.carried];
    // Para la clasificación local (cada teléfono apunta a los demás)
    const party = [...s.players.entries()].map(([pid, q]) => ({ userId: this.meta.get(pid)?.userId, displayName: q.name, starter: q.species, route: s.mansion ? null : s.route, floor: s.mansion ? 0 : s.floor, mansionSecs: this.mansionSecs || 0 }));
    rememberPlayers(party);
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      const leaves = Object.fromEntries(Object.entries(pm?.leaves || {}).map(([k, v]) => [k, Math.round(v * keep)]));
      const special = !!(s.mansion || s.raid);
      const joined = !!this.raidCaught?.includes(id);
      const run = { leaves, coins, res, rescued: joined ? [...rescued, "0493"] : rescued, floor: special ? 0 : s.floor, route: special ? null : s.route, level: s.raid ? pm?.origLevel ?? p.level : p.level, dex: p.species, evolved: p.evolved, awaken: pm?.awaken || 0, extracted: !!extracted, solo: s.players.size === 1, coop: s.players.size > 1, alphas: s.alphas, bosses: this.bossesBeaten || 0, legends: this.legendsBeaten || 0, legendCaught: !!this.legendCaught, legendEscaped: this.legendEscaped || 0, guardianRoute: this.legendsBeaten ? s.route : null, camps: this.campsSaved || [], plate: !!this.plateWon, guardianSpecies: this.guardianSpecies || null, mansionSecs: this.mansionSecs || 0, veil: !!this.mansionVeil, raidWin: !!this.raidWon, raidJoined: joined };
      if (pm?.user) grantRun(pm.user, { ...run, residentId: pm.resident });
      // Los jugadores de otros teléfonos guardan su botín al leer este mensaje (ver net.js).
      this.fx.push({ t: "end", to: id, extracted: !!extracted, lost, camps: this.campsSaved || [], stats: [], ...run, loot: res, party });
    }
    this.flushFx();
    this.clock.setTimeout(() => this.disconnect(), 6000);
  }

  // ---------- Simulación ----------
  tick(dt) {
    const s = this.state;
    if (s.phase === "exploring" || s.phase === "wipe") {
      if (s.pausedBy) return this.flushFx();
      s.runSecs = Math.floor((Date.now() - this.runStart) / 1000);
      if (s.comboT > 0) {
        s.comboT = Math.max(0, s.comboT - dt / 4);
        if (s.comboT === 0) s.combo = 0;
      }
      for (const h of this.pendingHits) h.t -= dt;
      const due = this.pendingHits.filter((h) => h.t <= 0);
      this.pendingHits = this.pendingHits.filter((h) => h.t > 0);
      for (const h of due) {
        const p = s.players.get(h.sid);
        const pm = this.meta.get(h.sid);
        if (p && pm) {
          this.hitEnemy(h.eid, h.sid, p, pm, h.mv, { m: h.mult || 1, basic: !!h.basic });
          p.ult = Math.min(1, p.ult + 0.015);
        }
      }
      for (const [id, p] of s.players) {
        const pm = this.meta.get(id);
        if (!pm) continue;
        p.cd1 = Math.max(0, p.cd1 - dt);
        p.cd2 = Math.max(0, p.cd2 - dt);
        p.cdDodge = Math.max(0, p.cdDodge - dt);
        if (pm.invuln > 0) pm.invuln -= dt;
        if (pm.shieldT > 0 && (pm.shieldT -= dt) <= 0) p.shielded = false;
        if (p.evoTo && (p.evoT -= dt) <= 0) this.finishEvolve(id, p, pm);
        if (pm.frenzyT > 0 && (pm.frenzyT -= dt) <= 0) p.frenzy = false;
        if (pm.counter && (pm.counter.t -= dt) <= 0) pm.counter = null;
        if (pm.obeliskT > 0) pm.obeliskT -= dt;
        if (pm.st) {
          for (const k of Object.keys(pm.st)) {
            pm.st[k] -= dt;
            if ((k === "burning" || k === "poisoned") && !p.downed) {
              pm.dotAcc = (pm.dotAcc || 0) + dt;
              if (pm.dotAcc >= 1) {
                pm.dotAcc = 0;
                const d = Math.max(1, Math.round(p.maxHp * (k === "burning" ? 0.03 : 0.02)));
                p.hp = Math.max(1, p.hp - d);
                this.fx.push({ t: "dmg", id, x: p.x, y: p.y - 16, n: d, ally: true, ty: k === "burning" ? "fire" : "poison" });
              }
            }
            if (pm.st[k] <= 0) {
              delete pm.st[k];
              if (k in p) p[k] = false;
            }
          }
        }
        if (s.phase !== "exploring") continue;
        if (!p.downed) {
          for (const [kid, pk] of s.pickups) {
            if (pk.kind === "camp") continue; // el saco de dormir se usa a propósito (mensaje "camp")
            const r = pk.kind === "chest" ? 20 : (pk.kind === "coin" ? 16 + 14 * upN(p, "magnet") : 16);
            if (Math.abs(pk.x - p.x) < r && Math.abs(pk.y - p.y) < r && Math.hypot(pk.x - p.x, pk.y - p.y) < r) this.collect(id, p, pm, kid, pk);
          }
        }
        if (!p.downed && p.hp < p.maxHp && !this.pactNoHeal(p)) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.004 * dt);
        if (!s.rescued && s.rescueSpecies && !p.downed && Math.hypot(p.x - s.rescueX, p.y - s.rescueY) < RESCUE_R) {
          s.rescued = true;
          s.escort = id;
          const name = this.M.Kr[s.rescueSpecies]?.names || { es: "Un Pokémon", en: "A Pokémon" };
          this.fx.push({ t: "banner", text: { es: `¡${name.es} se une!`, en: `${name.en} joins you!` }, sub: { es: "Llévalo a las escaleras", en: "Take it to the stairs" } });
        }
        if (!p.downed && Math.hypot(p.x - s.stairsX, p.y - s.stairsY) < STAIRS_R) {
          if (!this.mansionStairsOpen()) {
            if (Date.now() - (this.lampWarned || 0) > 4000) {
              this.lampWarned = Date.now();
              this.fx.push({ t: "banner", to: id, text: { es: "Enciende los farolillos", en: "Light the lanterns" } });
            }
            continue;
          }
          const boss = this.bossId && s.enemies.get(this.bossId);
          if (boss && !boss.dead) {
            if (Date.now() - this.bossWarned > 4000) {
              this.bossWarned = Date.now();
              this.fx.push({ t: "banner", to: id, text: { es: "Vence al jefe para bajar", en: "Defeat the boss to go down" } });
            }
            continue;
          }
          this.goNextFloor();
          break;
        }
      }
      if (s.rescued && s.escort) {
        const p = s.players.get(s.escort);
        if (p) {
          const d = Math.hypot(p.x - s.rescueX, p.y - s.rescueY);
          if (d > 18) {
            s.rescueX += ((p.x - s.rescueX) / d) * Math.min(d - 18, 90 * dt);
            s.rescueY += ((p.y - s.rescueY) / d) * Math.min(d - 18, 90 * dt);
          }
        }
      }
      this.tickEnemies(dt);
    }
    this.flushFx();
  }

  /** Disparo de un enemigo a distancia: proyectil del estado que avanza hasta dar o llegar a su alcance. */
  enemyShot(id, e, ai, p) {
    const mv = ai.move;
    const pr = initStrings(new Projectile());
    pr.x = e.x;
    pr.y = e.y - 6;
    pr.look = mv.look || "spark";
    pr.hostile = true;
    pr.owner = id;
    pr.shot = ++this.shotSeq;
    const d = Math.hypot(p.x - e.x, p.y - e.y) || 1;
    const pid = "s" + this.shotSeq;
    this.state.projectiles.set(pid, pr);
    this.shots.set(pid, { vx: ((p.x - e.x) / d) * (mv.speed || 170) * 0.8, vy: ((p.y - e.y) / d) * (mv.speed || 170) * 0.8, left: (mv.range || 120) + 30, from: id, ai });
    e.anim = mv.anim || "Shoot";
    e.animSeq = (e.animSeq + 1) & 0xffff;
  }

  tickShots(dt) {
    const s = this.state;
    for (const [pid, sh] of this.shots) {
      const pr = s.projectiles.get(pid);
      if (!pr) {
        this.shots.delete(pid);
        continue;
      }
      pr.x += sh.vx * dt;
      pr.y += sh.vy * dt;
      sh.left -= Math.hypot(sh.vx, sh.vy) * dt;
      const tile = this.layout?.tiles?.[Math.floor((pr.y + 6) / 16)]?.[Math.floor(pr.x / 16)];
      let done = sh.left <= 0 || tile === 1;
      for (const [qid, q] of s.players) {
        if (done || q.downed || Math.hypot(q.x - pr.x, q.y - 6 - pr.y) > 11) continue;
        const qm = this.meta.get(qid);
        this.hurtPlayer(qid, q, (4 + s.floor * 1.3) * Math.sqrt(sh.ai.atk / Math.max(30, qm?.def || 50)) * rnd(0.85, 1.15), sh.ai.types[0], sh.from);
        done = true;
      }
      if (done) {
        s.projectiles.delete(pid);
        this.shots.delete(pid);
      }
    }
  }

  tickEnemies(dt) {
    const s = this.state;
    this.tickShots(dt);
    this.tickAreas(dt);
    this.tickHazards(dt);
    this.tickMansion(dt);
    this.tickRaid(dt);
    this.tickCamp();
    this.tickArena();
    const players = [...s.players.entries()].filter(([, p]) => !p.downed);
    for (const [id, e] of s.enemies) {
      const ai = this.enemyAI.get(id);
      if (!ai) continue;
      if (e.dead) {
        ai.deadT -= dt;
        if (ai.deadT <= 0) {
          s.enemies.delete(id);
          this.enemyAI.delete(id);
        }
        continue;
      }
      if (ai.st) {
        let died = false;
        for (const k of Object.keys(ai.st)) {
          ai.st[k] -= dt;
          if (k === "burning" || k === "poisoned") {
            ai.dotAcc = (ai.dotAcc || 0) + dt;
            if (ai.dotAcc >= 1) {
              ai.dotAcc = 0;
              const d = Math.max(1, Math.round(e.maxHp * (k === "burning" ? 0.04 : 0.03) * (e.boss ? 0.4 : 1)));
              e.hp = Math.max(0, e.hp - d);
              this.fx.push({ t: "dmg", id, by: ai.stBy, x: e.x, y: e.y - 16, n: d, ty: k === "burning" ? "fire" : "poison" });
              if (e.hp <= 0) died = true;
            }
          }
          if (ai.st[k] <= 0) {
            delete ai.st[k];
            if (k in e) e[k] = false;
          }
        }
        if (died) {
          this.killEnemy(id, ai.stBy);
          continue;
        }
      }
      let target = null;
      let td = Infinity;
      for (const [pid, p] of players) {
        const d = dist(p, e);
        if (d < td) {
          td = d;
          target = [pid, p];
        }
      }
      // A oscuras o con niebla los enemigos te ven de más cerca (Destello/Despejar no les ayudan a ellos)
      const blind = s.event === "dark" ? 0.6 : s.event === "fog" ? 0.55 : s.event === "dim" ? 0.8 : 1;
      const aggroR = (ai.aggro || 0) > 0 ? 260 : (e.boss ? 170 : e.alpha ? 150 : 120) * blind;
      if (ai.aggro > 0) ai.aggro -= dt;
      ai.cd -= dt;
      let dx = 0;
      let dy = 0;
      if (target && td < aggroR && s.phase === "exploring") {
        const [pid, p] = target;
        if (ai.ranged && !e.boss) {
          // Enemigo a distancia: mantiene unos 80 px y dispara su movimiento
          const want = 80;
          const k = td > want + 15 ? 1 : td < want - 20 ? -0.8 : 0;
          dx = ((p.x - e.x) / td) * k;
          dy = ((p.y - e.y) / td) * k;
          ai.shotCd = (ai.shotCd ?? rnd(1, 2)) - dt;
          if (ai.shotCd <= 0 && td < 150) {
            ai.shotCd = rnd(1.8, 2.6) * (e.paralyzed ? 1.5 : 1);
            this.enemyShot(id, e, ai, p);
          }
        } else if (td > ENEMY_HIT_R - 4) {
          dx = (p.x - e.x) / td;
          dy = (p.y - e.y) / td;
        }
        if (e.boss && td < 150) {
          ai.slamT -= dt;
          if (ai.slamT <= 0.7 && !ai.slamAt) {
            ai.slamAt = { x: p.x, y: p.y };
            e.anim = "Attack";
            e.animSeq = (e.animSeq + 1) & 0xffff;
            this.fx.push({ t: "burst", x: p.x, y: p.y, r: 52, color: "#ff5040", ty: ai.types[0] });
          }
          if (ai.slamT <= 0) {
            const at = ai.slamAt || { x: p.x, y: p.y };
            ai.slamAt = null;
            ai.slamT = 3.2;
            this.fx.push({ t: "slam", x: at.x, y: at.y, r: 52 });
            for (const [qid, q] of players) {
              if (Math.hypot(q.x - at.x, q.y - at.y) < 52) {
                const qm = this.meta.get(qid);
                this.hurtPlayer(qid, q, (10 + s.floor * 2.4) * Math.sqrt(ai.atk / Math.max(30, qm?.def || 50)), ai.types[0], id);
              }
            }
          }
        }
        if (td < ENEMY_HIT_R + (e.alpha || e.boss ? 8 : 0) && ai.cd <= 0 && !e.frozen && !(e.paralyzed && Math.random() < 0.25)) {
          ai.cd = e.alpha ? 1.1 : 1.4;
          e.anim = "Attack";
          e.animSeq = (e.animSeq + 1) & 0xffff;
          const pm = this.meta.get(pid);
          const dmg = (5 + s.floor * 1.6) * Math.sqrt(ai.atk / Math.max(30, pm?.def || 50)) * (e.boss ? 2.2 : e.alpha ? 1.8 : 1) * rnd(0.85, 1.15);
          this.hurtPlayer(pid, p, dmg, ai.types[0], id);
        }
      } else {
        ai.wander.t -= dt;
        if (ai.wander.t <= 0) ai.wander = { x: ai.home.x + rnd(-40, 40), y: ai.home.y + rnd(-40, 40), t: rnd(2, 4) };
        const wd = Math.hypot(ai.wander.x - e.x, ai.wander.y - e.y);
        if (wd > 6) {
          dx = ((ai.wander.x - e.x) / wd) * 0.5;
          dy = ((ai.wander.y - e.y) / wd) * 0.5;
        }
      }
      const bx = e.x;
      const by = e.y;
      if (e.frozen) dx = dy = 0;
      const ds = ai.deep ? this.deepStep(id, e, ai, dx, dy, players, dt) : null;
      if (ds) ({ dx, dy } = ds);
      this.stepMover(ai, e, dx, dy, { layout: this.layout, speed: ai.speed * (e.paralyzed ? 0.5 : 1) * (ds?.mul || 1), flip: false, surf: false, blockers: [] });
      ds?.after?.();
      const moved = Math.hypot(e.x - bx, e.y - by) > 0.2;
      if (dx || dy) e.dir = dirOf(dx, dy);
      if (e.anim !== "Attack" || ai.cd < (e.alpha ? 0.7 : 1.0)) {
        const want = moved ? "Walk" : "Idle";
        if (e.anim !== want) e.anim = want;
      }
    }
  }

  flushFx() {
    if (!this.fx.length) return;
    const list = this.fx;
    this.fx = [];
    this.broadcast("fxs", list);
  }
}

/** Dirección 0..7 de las hojas de sprites (abajo, abajo-dcha, dcha, arriba-dcha, arriba, arriba-izq, izq, abajo-izq). */
function dirOf(x, y) {
  const a = Math.atan2(y, x); // 0 = derecha, +π/2 = abajo (pantalla)
  const oct = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8; // 0 dcha, 1 abajo-dcha, 2 abajo, …
  return [2, 1, 0, 7, 6, 5, 4, 3][oct];
}
function clampTo(p, aim, range) {
  const d = Math.hypot(aim.x - p.x, aim.y - p.y);
  if (d <= range || d === 0) return { x: aim.x, y: aim.y };
  return { x: p.x + ((aim.x - p.x) / d) * range, y: p.y + ((aim.y - p.y) / d) * range };
}
function distToSegment(pt, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy || 1;
  const t = clamp(((pt.x - a.x) * vx + (pt.y - a.y) * vy) / l2, 0, 1);
  return Math.hypot(pt.x - (a.x + vx * t), pt.y - (a.y + vy * t));
}

Object.assign(ExpeditionRoom.prototype, hazardMethods, mansionMethods, raidMethods);
