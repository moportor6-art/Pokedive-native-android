// La API REST del juego (/api/...), respondida en el teléfono.
import { load, save, rid } from "./store.js";
import { listLanRooms } from "./lan.js";
import { registerGuildRoutes } from "./guild.js";
import { loadShared } from "./shared.js";

let SH = null;
loadShared().then((m) => (SH = m));

const ok = (body) => ({ status: 200, body });
const noContent = () => ({ status: 204 });
const fail = (status, message, code) => ({ status, body: { message, code } });

export const unknownSeen = new Map();

export function userByToken(tok) {
  const db = load();
  const id = tok && db.tokens[tok];
  return id ? db.users[id] : null;
}

function userOf(headers) {
  const auth = headers.get("authorization") || "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const db = load();
  const id = tok && db.tokens[tok];
  return id ? db.users[id] : null;
}

function publicUser(u) {
  const { guild, meta, ...rest } = u;
  rest.deepest = guild?.deepest ?? 0;
  return rest;
}

const RES = ["berries", "materials", "crystals", "poke", "heartScales", "starPieces", "tickets", "candies", "raidCoins"];

/** Refugio vacío de una cuenta nueva. */
export function newGuild() {
  const g = {
    buildings: [],
    residents: [],
    arrivals: [],
    guardians: {},
    expansions: 0,
    burnedTrees: [],
    decor: [],
    friends: {},
    costumes: [],
    boxes: 0,
    bag: {},
    plates: [],
    deepest: 0,
    legendPity: 0,
    eggPity: 0,
    level: 1,
    banner: { a: "#e8403a", b: "#ffffff", e: "ball" },
    clanBanner: null,
    plaza: null,
    meal: [],
    tent: null,
    raidCosm: [],
    raidWins: 0,
    raidCaps: 0,
    raidOwned: [],
    raidTitle: null,
    flute: null,
    catch: null,
    unlocked: [],
    leaves: {},
  };
  for (const k of RES) g[k] = 0;
  g.poke = 50;
  g.berries = 20;
  g.materials = 20;
  return g;
}

const RESIDENT_DEFAULTS = () => ({
  shiny: false,
  level: 1,
  xp: 0,
  nature: "hardy",
  mint: null,
  ivs: { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 },
  training: 0,
  plus: [],
  job: null,
  home: null,
  partner: false,
  favorite: false,
  stored: false,
  nickname: null,
  costume: null,
  hms: [],
  friends: {},
  evolved: 0,
  awaken: 0,
});

/** Completa campos que el cliente espera (y migra partidas guardadas con versiones anteriores del port). */
export function normalizeGuild(g) {
  const base = newGuild();
  for (const k of Object.keys(base)) if (g[k] === undefined) g[k] = base[k];
  for (const [k, v] of Object.entries(g.guardians || {})) if (typeof v !== "string") delete g.guardians[k];
  for (const r of g.residents) {
    const d = RESIDENT_DEFAULTS();
    for (const k of Object.keys(d)) if (r[k] === undefined) r[k] = d[k];
    // 0.6 guardaba una sola MO en "hm"; el juego usa la lista "hms"
    if (r.hm) {
      if (!r.hms.includes(r.hm)) r.hms.push(r.hm);
      delete r.hm;
    }
  }
  return g;
}

export function guildOf(u) {
  if (!u.guild) u.guild = newGuild();
  return normalizeGuild(u.guild);
}

export function metaOf(u) {
  if (!u.meta) u.meta = { achievements: [], daily: null, challenge: null, dex: { owned: [], seen: [] }, stats: { runs: 0, rescued: 0, deepest: 0, extractions: 0, coins: 0 } };
  u.meta.dex ||= { owned: [], seen: [] };
  return u.meta;
}

/** Botín de una expedición terminada → refugio, récords y Pokédex de esa cuenta. */
export function grantRun(u, r) {
  const g = guildOf(u);
  g.poke = (g.poke || 0) + (r.coins || 0);
  g.deepest = Math.max(g.deepest || 0, r.floor || 0);
  // Como en el original, los rescatados esperan en la entrada del refugio (Llegadas) para darles la bienvenida.
  for (const dex of r.rescued || [])
    // Variocolor: 1 de cada 256, el doble con el evento de variocolores (siempre activo)
    g.arrivals.push(newResident(dex, { shiny: Math.random() < 2 / 256, originFloor: r.floor || 1, nature: NATURES[Math.floor(Math.random() * 25)], ivs: { hp: iv(), atk: iv(), def: iv(), spa: iv(), spd: iv(), spe: iv() } }));
  for (const [k, v] of Object.entries(r.res || {})) g[k] = (g[k] || 0) + (v || 0);
  g.leaves ||= {};
  for (const [k, v] of Object.entries(r.leaves || {})) g.leaves[k] = (g.leaves[k] || 0) + (v || 0);
  const res = g.residents.find((x) => x.id === r.residentId) || g.residents.find((x) => x.partner);
  if (res && r.level) res.level = Math.max(res.level || 1, r.level);
  // Lo que evolucionó en la mazmorra se queda evolucionado
  if (res && r.dex && r.evolved > (res.evolved || 0)) {
    res.dex = r.dex;
    res.evolved = r.evolved;
    res.awaken = r.awaken || 0;
    if (u.starter && res.partner) u.starter = r.dex;
  }
  if (r.route) {
    const rt = ((u.routes ||= {})[r.route] ||= { deepest: 0, camps: [] });
    rt.deepest = Math.max(rt.deepest, r.floor || 0);
    // Etapas abiertas al vencer al guardián: se puede empezar ahí la próxima vez
    for (const f of r.camps || []) if (!rt.camps.includes(f)) rt.camps.push(f);
    rt.camps.sort((x, y) => x - y);
  }
  // Guardián legendario: si se queda, la mala racha vuelve a 0; si se escapa, +10 % la próxima vez
  if (r.legendCaught) g.legendPity = 0;
  else if (r.legendEscaped) g.legendPity = (g.legendPity || 0) + r.legendEscaped;
  // Estatua del guardián de la ruta: la especie del legendario que se quedó contigo
  if (r.guardianRoute && r.guardianSpecies) (g.guardians ||= {})[r.guardianRoute] = r.guardianSpecies;
  // Evento de Arceus: el guardián del piso 25 de cada ruta guarda su tabla
  if (r.guardianRoute && r.plate && !(g.plates ||= []).includes(r.guardianRoute)) g.plates.push(r.guardianRoute);
  // Halloween: Caramelos; Mansión: récord de tiempo contra Spiritomb
  g.candies = (g.candies || 0) + (r.candies || 0);
  if (r.mansionSecs) u.mansionSecs = u.mansionSecs ? Math.min(u.mansionSecs, r.mansionSecs) : r.mansionSecs;
  if (r.veil && !(g.costumes ||= []).includes("veil")) g.costumes.push("veil");
  // Raid de Arceus
  if (r.raidWin) {
    const again = g.raidWins > 0;
    g.raidWins = (g.raidWins || 0) + 1;
    if (again) g.raidCoins = (g.raidCoins || 0) + 10;
    if (g.raidWins % 10 === 0) g.raidCaps = (g.raidCaps || 0) + 1;
  }
  // La Flauta Azur se desvanece al vencer a Arceus (las tablas se quedan)
  if (r.raidWin) g.flute = null;
  dailyProgress(u, r);
  // Cuaderno de Rutas
  if (Array.isArray(r.notes) && r.notes.length) u.notes = [...new Set([...(u.notes || []), ...r.notes])];
  const meta = metaOf(u);
  const st = meta.stats;
  st.runs = (st.runs || 0) + 1;
  if (r.extracted) st.extractions = (st.extractions || 0) + 1;
  if (r.extracted && r.coop) st.coopExtractions = (st.coopExtractions || 0) + 1;
  if (r.solo) st.soloDeepest = Math.max(st.soloDeepest || 0, r.floor || 0);
  st.alphas = (st.alphas || 0) + (r.alphas || 0);
  st.bosses = (st.bosses || 0) + (r.bosses || 0);
  st.legends = (st.legends || 0) + (r.legends || 0);
  st.guardians = (st.guardians || 0) + (r.legends || 0);
  st.bestRescue = Math.max(st.bestRescue || 0, (r.rescued || []).length);
  if (r.route) st.routeSet = [...new Set([...(st.routeSet || []), r.route])];
  st.deepest = Math.max(st.deepest || 0, r.floor || 0);
  st.rescued = (st.rescued || 0) + (r.rescued || []).length;
  st.coins = (st.coins || 0) + (r.coins || 0);
  for (const dex of r.rescued || []) if (!meta.dex.owned.includes(dex)) meta.dex.owned.push(dex);
  save();
}

/** Lo que el anfitrión necesita saber de un jugador que entra desde otro teléfono. */
export function lanUserOf(token, residentId) {
  const u = userByToken(token);
  if (!u) return null;
  const g = guildOf(u);
  const res = g.residents.find((r) => r.id === residentId) || g.residents.find((r) => r.partner);
  return { id: u.id, displayName: u.displayName, dex: res?.dex || u.starter || "0025", shiny: !!res?.shiny, level: res?.level || 1, hms: res?.hms || [], deepest: u.guild?.deepest || 0, raid: { guardians: g.guardians || {}, flute: !!g.flute, raidWins: g.raidWins || 0, hasArceus: [...g.residents, ...g.arrivals].some((r) => r.dex === "0493") } };
}

const NATURES = ["hardy","lonely","brave","adamant","naughty","bold","docile","relaxed","impish","lax","timid","hasty","serious","jolly","naive","modest","mild","quiet","bashful","rash","calm","gentle","sassy","careful","quirky"];
const iv = () => Math.floor(Math.random() * 32);

let residentSeq = 0;
export function newResident(dex, extra = {}) {
  return {
    ...RESIDENT_DEFAULTS(),
    id: Date.now().toString(36) + (residentSeq++).toString(36) + rid(4),
    dex: String(dex).padStart(4, "0"),
    at: Date.now(),
    joinedAt: Date.now(),
    ...extra,
  };
}

function newUser(displayName) {
  const db = load();
  const id = rid(16);
  const u = {
    id,
    displayName: displayName || "Entrenador",
    guest: false,
    starter: null,
    avatar: null,
    frame: null,
    routes: {},
    notes: [],
    flags: [],
    guide: 0,
    deepest: 0,
    createdAt: Date.now(),
  };
  db.users[id] = u;
  const token = rid(32);
  db.tokens[token] = id;
  save();
  return { token, user: u };
}

const routes = [];
function route(method, pattern, fn) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, fn });
}

// ---- Varios ----
route("GET", "/beta", () => ok({ closed: false }));
route("GET", "/auth/captcha", () => ok({}));
// Eventos: en el original los activa el servidor por fechas. Aquí están todos activos siempre (Mansión Encantada,
// Sala del Origen y raid de Arceus, variocolores, Pokecoins) y la ruta destacada cambia cada día.
const ROUTES9 = ["forest", "desert", "swamp", "ruins", "lava", "shroom", "ice", "sea", "storm"];
export function featuredRoute(t = new Date()) {
  return ROUTES9[Math.floor((t.getTime() - t.getTimezoneOffset() * 60000) / 864e5) % ROUTES9.length];
}
export const EVENT_KINDS = ["halloween", "arceus", "raid", "shiny", "coins", "route"];
function eventsNow() {
  const startsAt = "2024-01-01T00:00:00.000Z";
  const endsAt = "2099-12-31T23:59:59.000Z";
  const n = (es, en) => ({ es, en });
  return [
    { id: "halloween", kind: "halloween", name: n("Mansión Encantada", "Haunted Mansion"), startsAt, endsAt },
    { id: "arceus", kind: "arceus", name: n("Las tablas de Arceus", "Arceus's plates"), startsAt, endsAt },
    { id: "raid", kind: "raid", name: n("Sala del Origen", "Hall of Origin"), startsAt, endsAt },
    { id: "shiny", kind: "shiny", name: n("Más variocolores", "More shinies"), startsAt, endsAt },
    { id: "coins", kind: "coins", name: n("Lluvia de Pokecoins", "Pokecoin shower"), startsAt, endsAt },
    { id: "route", kind: "route", biome: featuredRoute(), name: n("Ruta destacada del día", "Featured route of the day"), startsAt, endsAt },
  ];
}
route("GET", "/status", () => ok({ ok: true, maintenance: null, announcements: [], events: eventsNow(), upcoming: [] }));
route("GET", "/live", () => ok({}));
route("POST", "/telemetry", () => noContent());
route("GET", "/news", () => ok([]));
route("GET", "/regions", (c) =>
  ok([{ id: "eu", name: { es: "Este teléfono", en: "This phone" }, url: null, probe: null, open: true, down: false, versions: [Number(c.headers.get("x-state")) || 0] }]),
);

// ---- Cuenta ----
route("POST", "/auth/guest", () => {
  const db = load();
  // Una sola partida local: si ya existe, se reutiliza.
  const first = Object.values(db.users)[0];
  if (first) {
    const token = rid(32);
    db.tokens[token] = first.id;
    save();
    return ok({ token, user: publicUser(first) });
  }
  const r = newUser("Entrenador");
  return ok({ token: r.token, user: publicUser(r.user) });
});
route("POST", "/auth/here", () => ok({ prev: null }));
route("GET", "/auth/here", () => ok({ unclaimed: 0 }));
route("POST", "/auth/offline", () => noContent());
route("GET", "/auth/me", (c) => (c.user ? ok(publicUser(c.user)) : fail(401, "Sin sesión")));
route("POST", "/auth/starter", (c) => {
  c.user.starter = String(c.body?.species || "0001");
  const g = guildOf(c.user);
  if (!g.residents.some((r) => r.partner)) g.residents.push(newResident(c.user.starter, { partner: true }));
  save();
  return ok(publicUser(c.user));
});
route("POST", "/auth/avatar", (c) => ((c.user.avatar = c.body?.species ?? null), save(), ok(publicUser(c.user))));
route("POST", "/auth/frame", (c) => ((c.user.frame = c.body?.frame ?? null), save(), ok(publicUser(c.user))));
route("POST", "/auth/guide", (c) => ((c.user.guide = Number(c.body?.step ?? -1)), save(), ok(publicUser(c.user))));
route("POST", "/auth/flags", (c) => {
  c.user.flags = [...new Set([...(c.user.flags || []), String(c.body?.flag)])];
  save();
  return ok(publicUser(c.user));
});
route("POST", "/auth/rename", (c) => {
  c.user.displayName = String(c.body?.displayName || c.user.displayName).slice(0, 20);
  save();
  return ok({ token: c.headers.get("authorization").slice(7), user: publicUser(c.user) });
});
route("GET", "/auth/frames", () => ok([]));
route("GET", "/auth/playable", (c) => ok(guildOf(c.user).residents.filter((r) => !r.stored || r.partner)));

// ---- Refugio ----
route("GET", "/guild", (c) => ok(guildOf(c.user)));

// ---- Logros y diarias ----
// Logros: misma lista, metas y recompensas que el juego (tabla N del módulo compartido)
function statValue(u, stat) {
  const g = guildOf(u);
  const m = metaOf(u);
  const st = m.stats;
  switch (stat) {
    case "owned": return m.dex.owned.length;
    case "seen": return new Set([...m.dex.seen, ...m.dex.owned]).size;
    case "buildings": return g.buildings.length;
    case "residents": return g.residents.length;
    case "species": return new Set(g.residents.map((r) => r.dex)).size;
    case "shinies": return g.residents.filter((r) => r.shiny).length;
    case "decor": return g.decor.length;
    case "routes": return (st.routeSet || []).length;
    default: return st[stat] || 0;
  }
}
function metaView(u) {
  const m = metaOf(u);
  dailyOf(u);
  const N = SH?.N || {};
  m.claimed ||= [];
  m.achievements = Object.entries(N).map(([id, a]) => {
    const progress = Math.min(a.goal, statValue(u, a.stat));
    return { id, progress, unlocked: progress >= a.goal, claimed: m.claimed.includes(id) };
  });
  return m;
}
// Encargos del día: tabla del juego (Pt), racha de 7 días (ti) y premio por los tres (Ft). Se renuevan a medianoche local.
const dayKey = (t = new Date()) => `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
function nextMidnight() {
  const t = new Date();
  t.setHours(24, 0, 0, 0);
  return t.toISOString();
}
function hashStr(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
function dailyOf(u) {
  const m = metaOf(u);
  const T = SH?.Pt || {};
  const ids = Object.keys(T);
  const today = dayKey();
  let d = m.daily;
  if (!d || d.day !== today || (!d.tasks.length && ids.length)) {
    // Racha: si ayer no recogiste ninguno, vuelve al día 1
    const y = new Date();
    y.setDate(y.getDate() - 1);
    let streak = d?.streak || { day: 1, lit: false, count: 0 };
    if (d && d.streak?.lit && d.day === dayKey(y)) streak = { day: (streak.day % 7) + 1, lit: false, count: streak.count };
    else if (!(d && d.day === dayKey(y) && d.streak?.lit)) streak = { day: 1, lit: false, count: 0 };
    // Tres encargos distintos del día (siempre los mismos ese día)
    const pool = [...ids];
    const pickN = [];
    let h = hashStr(today + (u.id || ""));
    while (pickN.length < 3 && pool.length) {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      pickN.push(pool.splice(h % pool.length, 1)[0]);
    }
    d = m.daily = {
      day: today,
      tasks: pickN.map((id) => ({ id, progress: 0, done: false, claimed: false })),
      bonus: { ready: false, claimed: false },
      streak,
      base: { ...(m.stats || {}) },
    };
  }
  d.resetsAt = nextMidnight();
  return d;
}
/** Avanza los encargos con lo que trajo una expedición. */
export function dailyProgress(u, r) {
  const d = dailyOf(u);
  const T = SH?.Pt || {};
  for (const t of d.tasks) {
    const def = T[t.id];
    if (!def || t.done) continue;
    let add = 0;
    switch (def.stat) {
      case "runs": add = 1; break;
      case "extractions": add = r.extracted ? 1 : 0; break;
      case "rescued": add = (r.rescued || []).length; break;
      case "deepest": t.progress = Math.max(t.progress, r.floor || 0); break;
      case "coop": add = r.extracted && r.coop ? 1 : 0; break;
      case "coins": add = r.coins || 0; break;
    }
    t.progress += add;
    if (t.progress >= def.goal) t.done = true;
  }
}
function addRes(g, rw) {
  for (const [k, v] of Object.entries(rw || {})) g[k] = (g[k] || 0) + v;
}
function claimDaily(u, id) {
  const d = dailyOf(u);
  const g = guildOf(u);
  const st = metaOf(u).stats;
  if (id === (SH?.It || "bonus")) {
    if (!d.bonus.ready || d.bonus.claimed) return false;
    d.bonus.claimed = true;
    addRes(g, SH?.Ft);
    st.dailyBonus = (st.dailyBonus || 0) + 1;
    return true;
  }
  const t = d.tasks.find((x) => x.id === id);
  if (!t || !t.done || t.claimed) return false;
  t.claimed = true;
  addRes(g, SH?.Pt?.[id]?.reward);
  st.dailies = (st.dailies || 0) + 1;
  // El primer encargo recogido del día enciende la racha y da su premio
  if (!d.streak.lit) {
    d.streak.lit = true;
    d.streak.count = (d.streak.count || 0) + 1;
    addRes(g, (SH?.ti || [])[d.streak.day - 1]);
  }
  if (d.tasks.every((x) => x.claimed)) d.bonus.ready = true;
  return true;
}
route("POST", "/meta/daily/:id/claim", (c) => {
  if (!claimDaily(c.user, c.params.id)) return fail(400, "Aún no puedes recogerlo");
  save();
  return ok(metaView(c.user));
});

route("GET", "/meta", (c) => ok(metaView(c.user)));
route("POST", "/meta/achievements/:id/claim", (c) => {
  const a = SH?.N?.[c.params.id];
  const m = metaView(c.user);
  const row = m.achievements.find((x) => x.id === c.params.id);
  if (!a || !row?.unlocked || row.claimed) return fail(400, "Aún no puedes reclamarlo");
  m.claimed.push(c.params.id);
  const g = guildOf(c.user);
  for (const [k, v] of Object.entries(a.reward || {})) g[k] = (g[k] || 0) + v;
  save();
  return ok(metaView(c.user));
});
route("GET", "/mail", () => ok([]));

// ---- Social: sin internet no hay amigos, clanes ni clasificaciones ----
route("GET", "/friends", () => ok([]));
route("GET", "/invites", () => ok([]));
route("GET", "/clan", () => ok(null));
route("GET", "/blocked", () => ok([]));
route("GET", "/expedition/saved", () => ok({ saved: null }));

// ---- Grupos: las salas que se oyen en la wifi ----
function lanGroups() {
  return listLanRooms()
    .filter((r) => r.phase === "lobby" && r.players < 4)
    .map((r) => ({
      id: r.roomId,
      roomId: r.roomId,
      mode: "open",
      groupId: r.roomId,
      host: { displayName: r.name || "Anfitrión", userId: "lan-" + r.roomId, avatar: null, frame: null, title: null, deepest: r.deepest || 1 },
      members: (r.dex || []).map((dex) => ({ dex })),
      players: r.players || 1,
      camp: 1,
      biome: r.biome || "forest",
      region: "eu",
    }));
}
route("GET", "/groups", () => ok({ groups: lanGroups(), mine: null }));
route("GET", "/groups/requests/mine", () => ok(null));
route("GET", "/groups/requests", () => ok([]));
route("GET", "/groups/code/:code", (c) => {
  const code = String(c.params.code || "").trim().toUpperCase();
  const r = listLanRooms().find((x) => String(x.code).toUpperCase() === code);
  return r ? ok({ roomId: r.roomId }) : fail(404, "No hay ningún grupo con ese código en tu wifi");
});
// Clasificaciones locales: tú y los jugadores con los que has jugado por wifi en este teléfono.
function localPlayers() {
  const st = load();
  const out = [];
  for (const u of Object.values(st.users || {})) {
    const g = u.guild || {};
    out.push({
      userId: u.id,
      displayName: u.displayName || "Tú",
      avatar: u.avatar || u.starter || null,
      starter: u.starter ?? null,
      frame: u.frame ?? null,
      routes: Object.fromEntries(Object.entries(u.routes || {}).map(([k, v]) => [k, v.deepest || 0])),
      mansion: u.mansionSecs || 0,
      challenge: g.deepest || 0,
      local: true,
    });
  }
  for (const k of Object.values(st.known || {})) out.push({ ...k, local: false });
  return out;
}
route("GET", "/rankings", (c) => {
  const q = Object.fromEntries(c.query || []);
  const period = q.period || "all";
  const biome = q.biome || undefined;
  const me = c.user;
  const mansion = period === "mansion" || period === "mansion-group";
  let rows = localPlayers().map((p) => ({
    userId: p.userId,
    displayName: p.displayName,
    avatar: p.avatar,
    starter: p.starter,
    frame: p.frame,
    deepest: mansion ? 0 : biome ? p.routes?.[biome] || 0 : Object.values(p.routes || {}).reduce((a, b) => a + b, 0),
    secs: p.mansion || 0,
  }));
  rows = mansion ? rows.filter((r) => r.secs > 0).sort((a, b) => a.secs - b.secs) : rows.filter((r) => r.deepest > 0).sort((a, b) => b.deepest - a.deepest);
  rows.forEach((r, i) => (r.rank = i + 1));
  const mine = rows.find((r) => r.userId === me?.id) || null;
  return ok({ period, biome: mansion || period === "challenge" ? undefined : biome, friends: q.scope === "friends", entries: rows.slice(0, 10), me: mine, near: [], tiers: [] });
});
/** Apunta a los compañeros de wifi para la clasificación local. */
export function rememberPlayers(list) {
  const st = load();
  st.known ||= {};
  for (const p of list) {
    if (!p?.userId || st.users?.[p.userId]) continue;
    const k = (st.known[p.userId] ||= { userId: p.userId, routes: {}, mansion: 0 });
    k.displayName = p.displayName || k.displayName || "?";
    k.avatar = p.avatar || p.starter || k.avatar || null;
    k.starter = p.starter ?? k.starter ?? null;
    if (p.route && p.floor) k.routes[p.route] = Math.max(k.routes[p.route] || 0, p.floor);
    if (p.mansionSecs) k.mansion = k.mansion ? Math.min(k.mansion, p.mansionSecs) : p.mansionSecs;
  }
  save();
}
route("GET", "/clans/chips", () => ok({}));
route("GET", "/users/:id/profile", (c) => {
  const u = load().users[c.params.id];
  return ok({ id: c.params.id, displayName: u?.displayName || "Entrenador", avatar: u?.avatar ?? null, frame: u?.frame ?? null, deepest: u?.guild?.deepest || 0, clan: null, friend: false, achievements: [] });
});
route("POST", "/expedition/saved/abandon", () => noContent());

registerGuildRoutes(route, { ok, guildOf, newResident });

export async function handleApi(method, path, query, body, headers) {
  const user = userOf(headers);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const res = await r.fn({ params, query, body, headers, user });
    return res;
  }
  const k = method + " " + path;
  unknownSeen.set(k, (unknownSeen.get(k) || 0) + 1);
  console.warn("[offline api] sin implementar:", k, body ?? "");
  (window.__pdLog ||= []).push(["api?", k, body === undefined ? "" : JSON.stringify(body).slice(0, 200)]);
  return method === "GET" ? fail(404, "No disponible sin conexión") : fail(501, "No disponible sin conexión");
}
