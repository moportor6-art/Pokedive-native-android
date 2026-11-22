// Sala de expedición: la mazmorra que antes simulaba el servidor de PokéDive.
//
// Lo que el cliente predice (movimiento, esquiva, ataque básico) se calcula aquí con el MISMO código del
// juego (módulo compartido townArt): así la predicción del cliente y el "servidor" coinciden y no hay tirones.
// El resto (enemigos, daño, experiencia, rescates, escaleras, botín) está escrito desde cero para el port.
import { Room } from "@colyseus/core/Room";
import { ExpeditionState, Player, Enemy, Pickup, Projectile } from "./schema.js";
import { guildOf, grantRun, userByToken } from "./api.js";
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
    on("choose", () => {});
    on("evolve", () => {});
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
    const moves = Array.isArray(opts.moves) ? opts.moves.filter((m) => this.M.Rn[m]).slice(0, 2) : [];
    p.specials = moves.join(",");
    p.specialLv = moves.map(() => "0").join(",");
    pm.resident = res?.id;
    pm.hm = res?.hm || lu?.hm || null;
    s.hms = [...new Set([...this.meta.values()].map((x) => x.hm).filter(Boolean))].join(",");
    pm.level = Math.max(1, Number(res?.level) || 1);
    pm.training = Number(res?.training) || 0;
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
    // Dojo: +4 % por sesión (tabla del juego). Leche Mu-mu: +25 PS.
    const train = 1 + (this.M.li?.per ?? 0.04) * (pm.training || 0);
    const vit = upN(p, "vitality");
    const maxHp = Math.round((60 + st.hp * 0.6 + p.level * 9) * (1 + 0.12 * (pm.awaken || 0)) * train + (pm.meal?.includes("moomoo-milk") ? 25 : 0) + vit * (20 + 0.8 * p.level));
    const ratio = p.maxHp ? p.hp / p.maxHp : 1;
    p.maxHp = maxHp;
    p.hp = Math.max(1, Math.round(maxHp * ratio));
    p.speed = Math.round(clamp(72 + (st.spe - 60) * 0.25, 64, 96) * (1 + 0.04 * upN(p, "swift")) * (1 + (this.M.Ea?.speed ?? 0.03) * Math.min(4, Math.floor(p.level / 5))));
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
    this.bossesBeaten = 0;
    this.legendsBeaten = 0;
    // Lo comprado en la tienda de Kecleon se gasta al salir
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      const g = pm?.user ? guildOf(pm.user) : null;
      const bag = g?.bag || {};
      pm.bag = { ...bag };
      // Platos del Café: se comen al salir
      pm.meal = [...(g?.meal || [])];
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
    this.layout = this.M.$a({ route: s.route, floor: s.floor, seed: s.seed, mode: "normal", roster: s.roster });
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
    const count = Math.min(L.enemySpawns.length, 6 + Math.floor(s.floor * 0.8));
    const spawns = [...L.enemySpawns].sort(() => Math.random() - 0.5).slice(0, count);
    for (const sp of spawns) this.spawnEnemy(pick(pool.foes), sp.x, sp.y);
    // Alfa de vez en cuando
    if (s.floor % 5 !== 0 && s.floor > 2 && Math.random() < 0.35 && spawns.length) {
      const sp = pick(spawns);
      this.spawnEnemy(pick(pool.alpha), sp.x + 12, sp.y, { alpha: true });
    }
    // Jefe cada 5 pisos (cada 10, un legendario guardián de la ruta). Las escaleras no funcionan hasta vencerlo.
    if (s.floor % 5 === 0) {
      const o = L.spawns[0];
      const cands = [...L.enemySpawns, L.stairs].filter(Boolean);
      const far = cands.sort((a, b) => Math.hypot(b.x - o.x, b.y - o.y) - Math.hypot(a.x - o.x, a.y - o.y))[0] || L.stairs;
      const guardians = this.M.Cn?.[s.route] || [];
      const legend = s.floor % 10 === 0 && guardians.length;
      const species = legend ? pick(guardians) : pick(pool.alpha);
      this.bossId = this.spawnEnemy(species, far.x, far.y, { boss: true, legend: !!legend });
      this.fx.push({ t: "banner", text: { es: legend ? "¡Un guardián legendario custodia este piso!" : "¡Un jefe custodia las escaleras!", en: legend ? "A legendary guardian guards this floor!" : "A boss guards the stairs!" } });
    }
    // Cofres del mapa
    for (const c of L.chests || []) this.spawnPickup("chest", c.x, c.y);
    // Cuerda Huida: cada 5 pisos aparece junto a la salida para volver al pueblo con todo
    if (s.floor > 1 && (s.floor - 1) % 5 === 0) {
      s.ropeX = L.spawns[0].x + 24;
      s.ropeY = L.spawns[0].y;
    }
    this.updateRoster();
    for (const pm of this.meta.values()) pm.floorReady = 0;
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
    return { layout: this.layout, speed: p.speed || 80, flip: !!this.state.flip, surf: false, blockers };
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
      this.stepMover(pm, p, dx, dy, env);
      p.moving = Math.hypot(p.vx, p.vy) > 10 || p.dodgeT > 0;
      if (dx || dy) p.dir = dirOf(dx, dy);
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
        for (const [eid, e] of this.state.enemies) if (!e.dead && distToSegment(e, p, to) < 16) this.hitEnemy(eid, client.sessionId, p, pm, { power: (this.M._i?.ram?.power ?? 10) * ram, type: "normal", id: "tackle" });
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
    const tgt = m.target && s.enemies.get(m.target);
    const aim = Number.isFinite(m.x) ? { x: m.x, y: m.y } : tgt ? { x: tgt.x, y: tgt.y } : this.nearestEnemyPos(p, 160) || { x: p.x + 30, y: p.y };
    if (mv.kind === "heal") {
      for (const q of s.players.values()) if (!q.downed && dist(q, p) <= (mv.radius || 60)) q.hp = Math.min(q.maxHp, q.hp + (q.maxHp * (mv.power || 15)) / 100);
      return;
    }
    if (mv.kind === "shield" || mv.kind === "counter") {
      pm.invuln = Math.max(pm.invuln || 0, mv.duration || 2);
      p.shielded = true;
      pm.shieldT = mv.duration || 2;
      return;
    }
    const areaMul = 1 + (this.M._i?.area ?? 0.08) * upN(p, "area");
    const range = (mv.range || 90) * areaMul;
    const radius = (mv.radius || (["zone", "burst", "ring", "trap"].includes(mv.kind) ? 40 : 18)) * areaMul;
    const center = mv.kind === "ring" ? { x: p.x, y: p.y } : clampTo(p, aim, range);
    const targets = [];
    for (const [eid, e] of s.enemies) {
      if (e.dead) continue;
      const d = ["line", "dash", "projectile"].includes(mv.kind) ? distToSegment(e, p, center) : dist(e, center);
      if (d <= radius + 8) targets.push(eid);
    }
    if (!targets.length && (mv.kind === "projectile" || mv.kind === "strike")) {
      const n = this.nearestEnemy(p, range + 20);
      if (n) targets.push(n);
    }
    this.fx.push({ t: "burst", x: center.x, y: center.y, r: radius, color: "#ffffff", ty: mv.type, mv: mv.id });
    for (const eid of targets) this.hitEnemy(eid, client.sessionId, p, pm, mv, 1.0);
    p.ult = Math.min(1, p.ult + 0.08);
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
    const crit = Math.random() < 0.06 + 0.05 * upN(p, "crit");
    const special = !mult.basic && mv.kind !== undefined && mv.cooldown > 1.5;
    const upMul = (1 + (this.M._i?.power ?? 0.15) * upN(p, "power")) * (special ? 1 + (this.M._i?.overload ?? 0.2) * upN(p, "overload") : 1);
    let dmg = upMul * (mv.power || 6) * (1 + p.level * 0.12) * (1 + 0.14 * (pm.awaken || 0)) * (1 + (this.M.li?.per ?? 0.04) * (pm.training || 0)) * (pm.meal?.includes("curry") ? 1.12 : 1) * Math.sqrt(pm.atk / ai.def) * eff * stab * (typeof mult === "number" ? mult : mult.m) * rnd(0.9, 1.1) * (crit ? 2 : 1) * (e.wet && mv.type === "electric" ? 1.25 : 1);
    dmg = Math.max(1, Math.round(dmg));
    e.hp = Math.max(0, e.hp - dmg);
    ai.aggro = Math.max(ai.aggro || 0, 6);
    this.fx.push({ t: "dmg", id: eid, by: sid, x: e.x, y: e.y - 16, n: dmg, crit, eff: eff > 1 ? 1 : eff < 1 ? -1 : 0, ty: mv.type, mv: mv.id, big: big || undefined });
    // Raíz Grande: te curas el 1 % del daño (con tope por golpe)
    const leech = upN(p, "leech");
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
    this.dropLoot(e.x, e.y, big, false, killer ? upN(killer, "fortune") : 0, e);
    if (eid === this.bossId) {
      this.bossId = null;
      this.bossesBeaten = (this.bossesBeaten || 0) + 1;
      if (s.floor % 10 === 0) this.legendsBeaten = (this.legendsBeaten || 0) + 1;
      s.ropeX = e.x;
      s.ropeY = e.y + 20;
      this.fx.push({ t: "banner", text: { es: "¡Jefe derrotado! Puedes bajar o volver con la cuerda", en: "Boss defeated! Go down or use the rope" } });
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
      p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.25));
      this.fx.push({ t: "banner", to: id, text: { es: `¡Nivel ${p.level}!`, en: `Level ${p.level}!` } });
    }
    p.xp = Math.min(65535, total);
    this.checkEvolve(p, pm);
  }

  /** Evoluciona (o "despierta", si ya no tiene más evoluciones) al llegar al nivel que marca el juego. */
  checkEvolve(p, pm) {
    if (p.evoTo || p.downed) return;
    const lvl = this.M.is(p.species, p.evolved);
    if (lvl == null || p.level < lvl) return;
    const kids = (this.kids.get(Number(p.species)) || []).filter((k) => this.M.Kr[k]);
    p.evoTo = kids.length ? pick(kids) : "+";
    p.evoT = 2;
    pm.invuln = Math.max(pm.invuln || 0, 2.2);
  }

  finishEvolve(id, p, pm) {
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
    if (foe?.boss || (chest && Math.random() < 0.08)) {
      const q = spot();
      this.spawnPickup("ticket", q.x, q.y);
    }
    const n = chest ? 2 + Math.floor(Math.random() * 3) : big > 1 ? 2 + Math.floor(big / 3) : 1;
    for (let i = 0; i < n; i++) {
      const q = spot();
      this.spawnPickup("coin", q.x, q.y, Math.round((rnd(1, 3) + s.floor * 0.5) * (chest ? 2 : 1) * Math.max(1, big / 2) * (1 + 0.15 * fortune)));
    }
    if (Math.random() < (chest ? 0.7 : 0.18 * big)) {
      const q = spot();
      this.spawnPickup("berry", q.x, q.y);
    }
    if (Math.random() < (chest ? 0.9 : 0.12 * big)) {
      const q = spot();
      this.spawnPickup("res-" + pick(RES_KINDS), q.x, q.y, chest ? 3 : 1 + Math.floor(big / 3));
    }
    if (Math.random() < (chest ? 0.25 : 0.02 * big)) {
      const q = spot();
      this.spawnPickup("candy", q.x, q.y);
    }
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
      this.dropLoot(pk.x, pk.y, 1, true);
    } else if (pk.kind === "coin") {
      s.coins += val;
    } else if (pk.kind === "berry") {
      if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
      else s.berries = Math.min(65535, s.berries + 1);
    } else if (pk.kind.startsWith("up-")) {
      const k = pk.kind.slice(3);
      const cur = ups(p);
      const max = this.M.gi?.[k]?.max ?? 3;
      if ((cur[k] || 0) < max) cur[k] = (cur[k] || 0) + 1;
      else s.coins += 10 + s.floor;
      p.upgrades = Object.entries(cur).map(([a, n]) => `${a}:${n}`).join(",");
      this.applyStats(p, pm);
      const nm = this.M.vi?.[k];
      if (nm) this.fx.push({ t: "banner", to: id, text: { es: `¡${nm.es}! ${this.M.gi[k].desc.es}`, en: `${nm.en}! ${this.M.gi[k].desc.en}` } });
    } else if (pk.kind.startsWith("leaf-")) {
      const k = pk.kind.slice(5);
      pm.leaves ||= {};
      pm.leaves[k] = (pm.leaves[k] || 0) + 1;
      p.leaves = Object.entries(pm.leaves).map(([a, n]) => `${a}:${n}`).join(",");
    } else if (pk.kind === "ticket") {
      s.tickets = Math.min(65535, s.tickets + 1);
    } else if (pk.kind === "res-heartScales") {
      this.heartScales = (this.heartScales || 0) + val;
    } else if (pk.kind.startsWith("res-")) {
      const k = pk.kind.slice(4);
      if (k in s) s[k] = Math.min(65535, s[k] + val);
    } else if (pk.kind === "candy") {
      s.candies = Math.min(65535, s.candies + 1);
      this.giveXp(id, p, p.xpNext);
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
    dmg *= 1 - 0.1 * upN(p, "guard");
    // Casco Dentado: el atacante cuerpo a cuerpo recibe daño
    const th = upN(p, "thorns");
    const foe = from && s.enemies.get(from);
    if (th && foe && !foe.dead && dist(foe, p) < 40) this.hitEnemy(from, id, p, pm, { power: (this.M._i?.thorns?.power ?? 10) * th, type: "normal", id: "tackle" });
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
    const res = { berries: Math.round(s.berries * keep), materials: Math.round(s.materials * keep), crystals: Math.round(s.crystals * keep), candies: Math.round(s.candies * keep), tickets: Math.round(s.tickets * keep), heartScales: Math.round((this.heartScales || 0) * keep) };
    const rescued = extracted ? [...this.carried, ...(s.rescued ? [s.rescueSpecies] : [])] : [];
    const lost = extracted ? [] : [...this.carried];
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      const leaves = Object.fromEntries(Object.entries(pm?.leaves || {}).map(([k, v]) => [k, Math.round(v * keep)]));
      const run = { leaves, coins, res, rescued, floor: s.floor, route: s.route, level: p.level, dex: p.species, evolved: p.evolved, awaken: pm?.awaken || 0, extracted: !!extracted, solo: s.players.size === 1, coop: s.players.size > 1, alphas: s.alphas, bosses: this.bossesBeaten || 0, legends: this.legendsBeaten || 0 };
      if (pm?.user) grantRun(pm.user, { ...run, residentId: pm.resident });
      // Los jugadores de otros teléfonos guardan su botín al leer este mensaje (ver net.js).
      this.fx.push({ t: "end", to: id, extracted: !!extracted, lost, camps: [], stats: [], ...run, loot: res });
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
            const r = pk.kind === "chest" ? 20 : (pk.kind === "coin" ? 16 + 14 * upN(p, "magnet") : 16);
            if (Math.abs(pk.x - p.x) < r && Math.abs(pk.y - p.y) < r && Math.hypot(pk.x - p.x, pk.y - p.y) < r) this.collect(id, p, pm, kid, pk);
          }
        }
        if (!p.downed && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.004 * dt);
        if (!s.rescued && s.rescueSpecies && !p.downed && Math.hypot(p.x - s.rescueX, p.y - s.rescueY) < RESCUE_R) {
          s.rescued = true;
          s.escort = id;
          const name = this.M.Kr[s.rescueSpecies]?.names || { es: "Un Pokémon", en: "A Pokémon" };
          this.fx.push({ t: "banner", text: { es: `¡${name.es} se une!`, en: `${name.en} joins you!` }, sub: { es: "Llévalo a las escaleras", en: "Take it to the stairs" } });
        }
        if (!p.downed && Math.hypot(p.x - s.stairsX, p.y - s.stairsY) < STAIRS_R) {
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
      const aggroR = (ai.aggro || 0) > 0 ? 260 : e.boss ? 170 : e.alpha ? 150 : 120;
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
      this.stepMover(ai, e, dx, dy, { layout: this.layout, speed: ai.speed * (e.paralyzed ? 0.5 : 1), flip: false, surf: false, blockers: [] });
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
