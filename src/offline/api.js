// La API REST del juego (/api/...), respondida en el teléfono.
import { load, save, rid } from "./store.js";
import { listLanRooms } from "./lan.js";

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
    raidCosm: null,
    flute: null,
    catch: null,
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
  hm: null,
  friends: {},
});

/** Completa campos que el cliente espera (y migra partidas guardadas con versiones anteriores del port). */
export function normalizeGuild(g) {
  const base = newGuild();
  for (const k of Object.keys(base)) if (g[k] === undefined) g[k] = base[k];
  for (const r of g.residents) {
    const d = RESIDENT_DEFAULTS();
    for (const k of Object.keys(d)) if (r[k] === undefined) r[k] = d[k];
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
  for (const dex of r.rescued || []) g.residents.push(newResident(dex));
  const res = g.residents.find((x) => x.id === r.residentId) || g.residents.find((x) => x.partner);
  if (res && r.level) res.level = Math.max(res.level || 1, r.level);
  if (r.route) {
    const rt = ((u.routes ||= {})[r.route] ||= { deepest: 0, camps: [] });
    rt.deepest = Math.max(rt.deepest, r.floor || 0);
  }
  const meta = metaOf(u);
  meta.stats.runs = (meta.stats.runs || 0) + 1;
  meta.stats.deepest = Math.max(meta.stats.deepest || 0, r.floor || 0);
  meta.stats.rescued = (meta.stats.rescued || 0) + (r.rescued || []).length;
  meta.stats.coins = (meta.stats.coins || 0) + (r.coins || 0);
  for (const dex of r.rescued || []) if (!meta.dex.owned.includes(dex)) meta.dex.owned.push(dex);
  save();
}

/** Lo que el anfitrión necesita saber de un jugador que entra desde otro teléfono. */
export function lanUserOf(token, residentId) {
  const u = userByToken(token);
  if (!u) return null;
  const g = guildOf(u);
  const res = g.residents.find((r) => r.id === residentId) || g.residents.find((r) => r.partner);
  return { id: u.id, displayName: u.displayName, dex: res?.dex || u.starter || "0025", shiny: !!res?.shiny, level: res?.level || 1 };
}

let residentSeq = 0;
export function newResident(dex, extra = {}) {
  return {
    ...RESIDENT_DEFAULTS(),
    id: Date.now().toString(36) + (residentSeq++).toString(36) + rid(4),
    dex: String(dex).padStart(4, "0"),
    at: Date.now(),
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
route("GET", "/status", () => ok({ ok: true }));
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
route("GET", "/meta", (c) => ok(metaOf(c.user)));
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
route("GET", "/rankings", () => ok({ entries: [], me: null }));
route("GET", "/clans/chips", () => ok({}));
route("GET", "/users/:id/profile", (c) => {
  const u = load().users[c.params.id];
  return ok({ id: c.params.id, displayName: u?.displayName || "Entrenador", avatar: u?.avatar ?? null, frame: u?.frame ?? null, deepest: u?.guild?.deepest || 0, clan: null, friend: false, achievements: [] });
});
route("POST", "/expedition/saved/abandon", () => noContent());

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
