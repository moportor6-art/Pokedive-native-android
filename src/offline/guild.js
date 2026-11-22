// El refugio (pueblo): edificios, trabajos, llegadas, caseta y tienda de Kecleon.
// Costes, mejoras, capacidades, ritmos de producción, bonos de amistad, recompensas por liberar y artículos de
// la tienda salen tal cual del módulo compartido del juego (M.*), así que coinciden con el original.
import { loadShared } from "./shared.js";
import { save, rid } from "./store.js";

let M;
loadShared().then((m) => (M = m));

// Ampliaciones de la caseta (tabla del juego; el cliente la enseña igual)
const BOX_COSTS = [
  { materials: 30, poke: 40 }, { materials: 60, poke: 80 }, { materials: 100, poke: 140 },
  { materials: 150, poke: 220, crystals: 20 }, { materials: 250, poke: 400, crystals: 40 },
  { materials: 400, poke: 700, crystals: 70 }, { materials: 650, poke: 1200, crystals: 120 },
  { materials: 1000, poke: 2000, crystals: 200 }, { materials: 1600, poke: 3200, crystals: 320 },
];
// Platos por expedición según el nivel del Café (descripción de sus niveles)
const MEAL_SEATS = [1, 1, 2, 3];
// Minutos de cansancio de un Pokémon que cae en una expedición (reconstruido; el Centro Nv 2+ lo deja en la mitad)
const TIRED_MIN = 30;

const RES = ["berries", "materials", "crystals", "poke", "heartScales", "starPieces", "tickets", "candies", "raidCoins"];
const iso = (t = Date.now()) => new Date(t).toISOString();
const err = (message, status = 400) => Object.assign(new Error(message), { status });

function afford(g, cost) {
  return Object.entries(cost || {}).every(([k, v]) => (g[k] || 0) >= v);
}
function pay(g, cost) {
  if (!afford(g, cost)) {
    const miss = Object.entries(cost).filter(([k, v]) => (g[k] || 0) < v).map(([k, v]) => `${v - (g[k] || 0)} ${M.jr?.[k]?.es?.toLowerCase() || k}`);
    throw err(`Te faltan ${miss.join(", ")}`);
  }
  for (const [k, v] of Object.entries(cost || {})) g[k] -= v;
}
function gain(g, res) {
  for (const [k, v] of Object.entries(res || {})) g[k] = (g[k] || 0) + v;
}

/** Ritmos de los trabajadores de un edificio (igual que el cliente: tipos → ritmo, con el bono de amigos). */
function workerRates(g, b) {
  const ws = g.residents.filter((r) => r.job === b.id);
  const types = (dex) => M.Kr[String(dex).padStart(4, "0")]?.types ?? ["normal"];
  return M.Ja(
    ws.map((r) => r.id),
    ws.map((r) => M.Do(types(r.dex), b.kind)),
    g.friends || {},
  );
}

/** Congela lo producido hasta ahora (antes de cambiar trabajadores o nivel). */
function settle(g, b, now = Date.now()) {
  if (!M.Y[b.kind]?.produces) return;
  b.stored = M.tc(b, workerRates(g, b), now);
  b.updatedAt = iso(now);
}

function collectOne(g, b, now = Date.now()) {
  const kind = M.Y[b.kind]?.produces;
  if (!kind) return 0;
  const have = M.tc(b, workerRates(g, b), now);
  const n = Math.floor(have);
  b.stored = have - n;
  b.updatedAt = iso(now);
  g[kind] = (g[kind] || 0) + n;
  return n;
}

const NATS = ["hardy","lonely","brave","adamant","naughty","bold","docile","relaxed","impish","lax","timid","hasty","serious","jolly","naive","modest","mild","quiet","bashful","rash","calm","gentle","sassy","careful","quirky"];
const randomGenes = () => ({
  nature: NATS[Math.floor(Math.random() * NATS.length)],
  ivs: Object.fromEntries(["hp", "atk", "def", "spa", "spd", "spe"].map((k) => [k, Math.floor(Math.random() * 32)])),
});

const best = (g, kind) => g.buildings.filter((b) => b.kind === kind).sort((a, b) => (b.level || 1) - (a.level || 1))[0];

/** Un Pokémon de este teléfono cayó en una expedición: queda cansado un rato (el Centro lo cura). */
export function tire(g, residentId, floor) {
  const r = g.residents.find((x) => x.id === residentId);
  if (!r) return;
  const centro = best(g, "centro");
  const mins = TIRED_MIN * ((centro?.level || 0) >= 2 ? 0.5 : 1);
  r.tiredUntil = iso(Date.now() + mins * 60e3);
  r.tiredFloor = floor;
}

const findB = (g, id) => {
  const b = g.buildings.find((x) => x.id === id);
  if (!b) throw err("Ese edificio ya no existe");
  return b;
};
const findR = (g, id) => {
  const r = g.residents.find((x) => x.id === id);
  if (!r) throw err("Ese Pokémon ya no está en el refugio");
  return r;
};

export function registerGuildRoutes(route, { ok, guildOf, newResident }) {
  const G = (fn) => async (c) => {
    if (!M) M = await loadShared();
    const g = guildOf(c.user);
    try {
      const out = await fn(g, c);
      save();
      return ok(out ?? g);
    } catch (e) {
      if (e.status) return { status: e.status, body: { message: e.message } };
      throw e;
    }
  };

  // ---- Edificios ----
  route("POST", "/guild/buildings", G((g, c) => {
    const { kind, x, y } = c.body || {};
    const def = M.Y[kind];
    if (!def) throw err("Ese edificio no existe");
    pay(g, def.cost);
    g.buildings.push({ id: rid(10), kind, x: Math.round(x), y: Math.round(y), level: 1, stored: 0, updatedAt: iso(), style: 0, roof: 0 });
  }));
  route("POST", "/guild/buildings/:id/move", G((g, c) => {
    const b = findB(g, c.params.id);
    b.x = Math.round(c.body?.x ?? b.x);
    b.y = Math.round(c.body?.y ?? b.y);
  }));
  route("POST", "/guild/buildings/:id/demolish", G((g, c) => {
    const b = findB(g, c.params.id);
    collectOne(g, b);
    for (const r of g.residents) {
      if (r.job === b.id) r.job = null;
      if (r.home === b.id) r.home = null;
    }
    g.buildings = g.buildings.filter((x) => x !== b);
  }));
  route("POST", "/guild/buildings/:id/upgrade", G((g, c) => {
    const b = findB(g, c.params.id);
    const cost = M.Y[b.kind]?.upgrade?.[(b.level || 1) - 1];
    if (!cost) throw err("Ya está al máximo");
    pay(g, cost);
    settle(g, b);
    b.level = (b.level || 1) + 1;
  }));
  route("POST", "/guild/buildings/:id/collect", G((g, c) => {
    collectOne(g, findB(g, c.params.id));
  }));
  route("POST", "/guild/collect", G((g) => {
    for (const b of g.buildings) collectOne(g, b);
  }));
  route("POST", "/guild/buildings/:id/roof", G((g, c) => {
    findB(g, c.params.id).roof = Number(c.body?.roof) || 0;
  }));
  route("POST", "/guild/buildings/:id/style", G((g, c) => {
    findB(g, c.params.id).style = Number(c.body?.style) || 0;
  }));

  // ---- Residentes ----
  route("POST", "/guild/residents/:id/job", G((g, c) => {
    const r = findR(g, c.params.id);
    const { buildingId, swapId, replaceId } = c.body || {};
    const touched = new Set([r.job, buildingId].filter(Boolean));
    for (const id of touched) {
      const b = g.buildings.find((x) => x.id === id);
      if (b) settle(g, b);
    }
    if (replaceId) {
      const out = g.residents.find((x) => x.id === replaceId);
      if (out) out.job = null;
    }
    if (swapId) {
      const o = g.residents.find((x) => x.id === swapId);
      if (o) [o.job, r.job] = [r.job, o.job];
      return;
    }
    if (buildingId) {
      const b = findB(g, buildingId);
      if (b.kind === "guarderia") {
        settleNests(g, b);
        r.job = b.id;
        r.nestSlot = Number.isInteger(c.body?.slot) ? c.body.slot : null;
        r.stored = false;
        return;
      }
      const cap = M.Js(b.kind, b.level || 1);
      const now = g.residents.filter((x) => x.job === b.id && x.id !== r.id).length;
      if (now >= cap) throw err("No quedan puestos libres");
      r.job = b.id;
      r.stored = false;
    } else {
      const old = g.buildings.find((x) => x.id === r.job);
      if (old?.kind === "guarderia") settleNests(g, old);
      r.job = null;
      r.nestSlot = null;
    }
  }));
  route("POST", "/guild/residents/fill", G((g, c) => {
    const exclude = c.body?.exclude;
    const types = (dex) => M.Kr[String(dex).padStart(4, "0")]?.types ?? ["normal"];
    for (const b of g.buildings) {
      if (!M.Y[b.kind]?.produces) continue;
      settle(g, b);
      const cap = M.Js(b.kind, b.level || 1);
      let n = g.residents.filter((x) => x.job === b.id).length;
      const free = g.residents
        .filter((r) => !r.job && !r.partner && !r.favorite && !r.stored && r.id !== exclude)
        .map((r) => [r, M.Do(types(r.dex), b.kind)])
        .filter(([, v]) => v > 0)
        .sort((a, b2) => b2[1] - a[1]);
      for (const [r] of free) {
        if (n >= cap) break;
        r.job = b.id;
        n++;
      }
    }
  }));
  route("POST", "/guild/residents/:id/home", G((g, c) => {
    findR(g, c.params.id).home = c.body?.buildingId ?? null;
  }));
  route("POST", "/guild/residents/:id/favorite", G((g, c) => {
    findR(g, c.params.id).favorite = !!c.body?.favorite;
  }));
  route("POST", "/guild/residents/:id/nickname", G((g, c) => {
    findR(g, c.params.id).nickname = String(c.body?.nickname || "").slice(0, 12) || null;
  }));
  route("POST", "/guild/residents/:id/costume", G((g, c) => {
    findR(g, c.params.id).costume = c.body?.costume ?? null;
  }));
  route("POST", "/guild/residents/store", G((g, c) => {
    const { ids = [], stored, swapId } = c.body || {};
    for (const id of ids) {
      const r = findR(g, id);
      if (r.partner && stored) throw err("Tu compañero no puede ir a la caseta");
      if (stored && r.job) {
        const b = g.buildings.find((x) => x.id === r.job);
        if (b) settle(g, b);
        r.job = null;
      }
      r.stored = !!stored;
    }
    if (swapId) {
      const o = g.residents.find((x) => x.id === swapId);
      if (o) o.stored = !stored;
    }
  }));
  const release = (g, ids) => {
    const set = new Set(ids);
    if (g.residents.some((r) => set.has(r.id) && r.partner)) throw err("No puedes liberar a tu compañero");
    gain(g, M.Ns(g.residents, ids));
    for (const r of g.residents) if (set.has(r.id) && r.job) {
      const b = g.buildings.find((x) => x.id === r.job);
      if (b) settle(g, b);
    }
    g.residents = g.residents.filter((r) => !set.has(r.id));
  };
  route("POST", "/guild/residents/:id/release", G((g, c) => release(g, [c.params.id])));
  route("POST", "/guild/residents/release", G((g, c) => release(g, c.body?.ids || [])));

  // ---- Llegadas (Pokémon rescatados que esperan en la entrada) ----
  const welcome = (g, a, keep, nickname) => {
    g.arrivals = g.arrivals.filter((x) => x.id !== a.id);
    if (keep) g.residents.push({ ...a, nickname: nickname || a.nickname || null, at: Date.now() });
    else gain(g, M.Ci(g.residents, [a], [a.id]));
  };
  route("POST", "/guild/arrivals/decide", G((g, c) => {
    const keep = new Set(c.body?.keep || []);
    const rel = new Set(c.body?.release || []);
    const relList = g.arrivals.filter((a) => rel.has(a.id));
    if (relList.length) gain(g, M.Ci(g.residents, g.arrivals, [...rel]));
    for (const a of [...g.arrivals]) {
      if (keep.has(a.id)) g.residents.push({ ...a, at: Date.now() });
      if (keep.has(a.id) || rel.has(a.id)) g.arrivals = g.arrivals.filter((x) => x.id !== a.id);
    }
  }));
  route("POST", "/guild/arrivals/:id", G((g, c) => {
    const a = g.arrivals.find((x) => x.id === c.params.id);
    if (!a) throw err("Ya no está en la entrada");
    welcome(g, a, c.body?.keep !== false, c.body?.nickname);
  }));
  route("POST", "/guild/arrivals", G((g) => {
    for (const a of [...g.arrivals]) welcome(g, a, true);
  }));

  // ---- Caseta (almacén de Pokémon) ----
  route("POST", "/guild/caseta/expand", G((g) => {
    const cost = BOX_COSTS[g.boxes || 0];
    if (!cost) throw err("La caseta ya está al máximo");
    pay(g, cost);
    g.boxes = (g.boxes || 0) + 1;
  }));

  // ---- Ampliar terreno: parcelas del pueblo (tablas del juego: Xn parcelas, Xi si se puede, ds coste, fs piso necesario) ----
  route("POST", "/guild/expand/:id", G((g, c) => {
    const id = c.params.id;
    const P = M.Xn?.[id];
    if (!P) throw err("Esa parcela no existe");
    const exp = g.expansions || 0;
    if (exp & (1 << P.bit)) throw err("Ya está despejada");
    if (!M.Xi(exp, id)) throw err("Despeja antes una de al lado");
    const n = M.ps(exp).length;
    const need = M.fs(n);
    if ((g.deepest || 0) < need) throw err(`Llega al piso ${need}`);
    pay(g, M.ds(n));
    g.expansions = exp | (1 << P.bit);
  }));

  // ---- Quemar un árbol del pueblo con un Pokémon de fuego (no vuelve a crecer) ----
  route("POST", "/guild/trees/:tile/burn", G((g, c) => {
    const tile = Number(c.params.tile);
    if (!Number.isInteger(tile) || tile < 0) throw err("Ese árbol no existe");
    const r = findR(g, c.body?.by);
    if (r.stored) throw err("Hace falta un Pokémon de tipo Fuego en el pueblo (fuera de la caseta)");
    if (!(M.Kr[String(r.dex).padStart(4, "0")]?.types || []).includes("fire")) throw err("Hace falta un Pokémon de tipo Fuego");
    g.burnedTrees ||= [];
    if (!g.burnedTrees.includes(tile)) g.burnedTrees.push(tile);
  }));

  // ---- Evento de Halloween: disfraces con Caramelos (tabla jt del juego) ----
  route("POST", "/guild/costumes/buy", G((g, c) => {
    const id = c.body?.costume ?? c.body?.id;
    const cos = M.jt?.[id];
    if (!cos || !cos.price) throw err("Ese disfraz no se vende");
    g.costumes ||= [];
    if (g.costumes.includes(id)) throw err("Ya lo tienes");
    pay(g, { candies: cos.price });
    g.costumes.push(id);
  }));

  // ---- Columna Lanza: Flauta Azur, chapas, variocolor, tienda y estilo de la raid de Arceus ----
  const arceusOf = (g) => [...g.residents, ...g.arrivals].find((r) => r.dex === Number(M.Kn));
  route("POST", "/guild/flute", G((g) => {
    const all = M.U || [];
    if (g.flute) throw err("Ya tienes la Flauta Azur");
    if (!all.every((r) => (g.plates || []).includes(r))) throw err("Te faltan tablas");
    g.flute = true;
  }));
  route("POST", "/guild/raid-cap", G((g, c) => {
    const st = c.body?.stat;
    const a = arceusOf(g);
    if (!a) throw err("Arceus aún no está contigo");
    if (!(g.raidCaps > 0)) throw err("No tienes chapas");
    a.ivs ||= { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 };
    if (!(st in a.ivs) || a.ivs[st] >= 31) throw err("Ese IV ya está al máximo");
    a.ivs[st] = 31;
    g.raidCaps--;
  }));
  route("POST", "/guild/arceus-reroll", G((g) => {
    const a = arceusOf(g);
    if (!a || a.shiny) throw err("No hace falta");
    pay(g, { raidCoins: 100 });
    if (Math.random() < (M.xr ?? 0.01)) a.shiny = true;
    return { shiny: !!a.shiny };
  }));
  route("POST", "/guild/raid-shop", G((g, c) => {
    const id = c.body?.id;
    const it = M.Sr?.[id];
    if (!it) throw err("Eso no se vende");
    g.raidOwned ||= [];
    if (g.raidOwned.includes(id)) throw err("Ya lo tienes");
    pay(g, { raidCoins: it.price });
    g.raidOwned.push(id);
  }));
  route("POST", "/guild/raid-style", G((g, c) => {
    const b = c.body || {};
    if ("title" in b) {
      if (b.title && !(g.raidOwned || []).includes("titulo-" + b.title)) throw err("No tienes ese título");
      g.raidTitle = b.title || null;
    }
    if (Array.isArray(b.cosm)) g.raidCosm = b.cosm.filter((x) => (g.raidOwned || []).includes(x));
  }));

  // ---- Tienda de Kecleon ----
  route("POST", "/guild/buy", G((g, c) => {
    const id = c.body?.item;
    const it = M.ci[id];
    if (!it) throw err("Kecleon no vende eso");
    const shop = g.buildings.filter((b) => b.kind === "tienda").sort((a, b) => (b.level || 1) - (a.level || 1))[0];
    if (!shop) throw err("Primero construye la Tienda de Kecleon");
    if ((shop.level || 1) < it.level) throw err("Mejora la tienda para venderlo");
    g.bag ||= {};
    if ((g.bag[id] || 0) >= it.max) throw err("No puedes llevar más");
    const cheap = (shop.level || 1) >= 3 ? 0.8 : 1;
    const cost = Object.fromEntries(Object.entries(it.cost).map(([k, v]) => [k, Math.round(v * cheap)]));
    pay(g, cost);
    g.bag[id] = (g.bag[id] || 0) + 1;
    (c.user.meta ||= { stats: {} }).stats ||= {};
    c.user.meta.stats.purchases = (c.user.meta.stats.purchases || 0) + 1;
  }));

  // ---- Café de Spinda: platos para la próxima expedición ----
  route("POST", "/guild/meal", G((g, c) => {
    const id = c.body?.dish;
    const dish = M.Ut[id];
    if (!dish) throw err("Spinda no sirve eso");
    const cafe = best(g, "cafe");
    if (!cafe) throw err("Primero construye el Café de Spinda");
    if ((cafe.level || 1) < dish.level) throw err("Mejora el Café para pedirlo");
    g.meal ||= [];
    if (g.meal.includes(id)) throw err("Ya lo has pedido");
    if (g.meal.length >= MEAL_SEATS[(cafe.level || 1) - 1]) throw err("La mesa está llena");
    pay(g, dish.cost);
    g.meal.push(id);
  }));

  // ---- Dojo de Makuhita: entrenamiento permanente con Escamas Corazón ----
  route("POST", "/guild/residents/:id/train", G((g, c) => {
    const r = findR(g, c.params.id);
    const dojo = best(g, "dojo");
    if (!dojo) throw err("Primero construye el Dojo de Makuhita");
    const cap = M.li.caps[Math.min(M.li.caps.length, dojo.level || 1) - 1];
    const times = Math.max(1, Math.min(Number(c.body?.times) || 1, cap - (r.training || 0)));
    if ((r.training || 0) >= cap) throw err("Ya no puede entrenar más aquí");
    pay(g, { heartScales: M.gc(r.training || 0, times) });
    r.training = (r.training || 0) + times;
  }));

  // ---- Centro Pokémon de Audino: curar el cansancio ----
  route("POST", "/guild/residents/:id/heal", G((g, c) => {
    const r = findR(g, c.params.id);
    const centro = best(g, "centro");
    if (!centro) throw err("Primero construye el Centro Pokémon");
    pay(g, M.ao(centro.level || 1, r.tiredFloor || 0));
    r.tiredUntil = null;
    r.tiredFloor = null;
  }));

  // ---- Guardería de Chansey: huevos ----
  const DITTO = "0132";
  const pad = (d) => String(d).padStart(4, "0");
  const nestsOf = (g, b) => M.Sa(g.residents.filter((r) => r.job === b.id), b.level || 1, (a, d) => M.Ji(pad(a), pad(d), DITTO));
  function settleNests(g, b, now = Date.now()) {
    const nests = nestsOf(g, b);
    b.nests ||= [];
    for (const n of nests) b.nests[n.index] = M.rs(b, n.index, n.breeding, now);
    b.updatedAt = iso(now);
  }
  const baby = (dex) => {
    let d = Number(dex);
    for (let i = 0; i < 4 && M.Jt[d]; i++) d = Number(M.Jt[d]);
    return String(d).padStart(4, "0");
  };
  route("POST", "/guild/buildings/:id/egg", async (c) => {
    if (!M) M = await loadShared();
    const g = guildOf(c.user);
    try {
      const b = findB(g, c.params.id);
      const nests = nestsOf(g, b);
      const nest = nests[Number.isInteger(c.body?.nest) ? c.body.nest : nests.findIndex((n) => n.breeding)] || nests[0];
      if (!nest?.breeding) throw err("Esa pareja no es compatible");
      settleNests(g, b);
      const have = Math.floor(b.nests[nest.index] + 1e-9);
      const per = M.Lt.cost.berries || 0;
      const n = Math.min(have, c.body?.all ? Math.floor((g.berries || 0) / Math.max(1, per)) : 1);
      if (n < 1) throw err(have ? "Faltan bayas" : "Aún no hay huevos");
      pay(g, { berries: per * n });
      b.nests[nest.index] -= n;
      const lvl = b.level || 1;
      const inherit = M.Lt.inherit[Math.min(M.Lt.inherit.length, lvl) - 1];
      const hatched = [];
      for (let k = 0; k < n; k++) {
        // Cría con la función del propio juego: especie, IV heredados y naturaleza
        const a = { ...nest.a, dex: pad(nest.a.dex) };
        const d = { ...nest.b, dex: pad(nest.b.dex) };
        const born = M.Vi(a, d, inherit, lvl >= 2, DITTO);
        const kid = newResident(born.dex, { bred: true, ivs: born.ivs, nature: born.nature, shiny: Math.random() < 1 / 512 });
        g.arrivals.push(kid);
        hatched.push(kid);
        const st = ((c.user.meta ||= {}).stats ||= {});
        st.hatched = (st.hatched || 0) + 1;
        st.bred = (st.bred || 0) + 1;
      }
      save();
      return ok({ guild: g, hatched });
    } catch (e) {
      if (e.status) return { status: e.status, body: { message: e.message } };
      throw e;
    }
  });
  route("POST", "/guild/buildings/:id/egg/rush", G((g, c) => {
    const b = findB(g, c.params.id);
    const today = new Date().toDateString();
    if (b.rushDay !== today) {
      b.rushDay = today;
      b.rushes = 0;
    }
    const cost = M.Lt.rush[b.rushes || 0];
    if (!cost) throw err("Hoy ya no se puede adelantar más");
    pay(g, cost);
    settleNests(g, b);
    const i = Number(c.body?.nest) || 0;
    b.nests[i] = Math.floor((b.nests[i] || 0) + 1 + 1e-9);
    b.rushes = (b.rushes || 0) + 1;
  }));
  route("POST", "/guild/buildings/:id/basket", G((g, c) => {
    const b = findB(g, c.params.id);
    const cost = M.Lt.baskets[b.baskets || 0];
    if (!cost) throw err("Ya tiene todas las cestas");
    pay(g, cost);
    settleNests(g, b);
    b.baskets = (b.baskets || 0) + 1;
  }));

  // ---- Biblioteca de Unown: objetos nuevos para las mazmorras ----
  route("POST", "/guild/unlock", G((g, c) => {
    const id = c.body?.upgrade;
    const shelf = M.En.find((sh) => sh.ups.includes(id));
    if (!shelf) throw err("Ese libro no existe");
    const lib = best(g, "biblioteca");
    if (!lib) throw err("Primero construye la Biblioteca de Unown");
    if ((lib.level || 1) < shelf.level) throw err("Mejora la Biblioteca para leerlo");
    g.unlocked ||= [];
    if (g.unlocked.includes(id)) throw err("Ya lo tienes");
    pay(g, shelf.cost);
    g.unlocked.push(id);
  }));

  // ---- Poké Balls (boletos) ----
  route("POST", "/guild/hatch", async (c) => {
    if (!M) M = await loadShared();
    const g = guildOf(c.user);
    const count = Math.max(1, Math.min(10, Number(c.body?.count) || 1));
    const cost = { tickets: (M.dn?.tickets ?? 1) * count };
    if ((g.tickets || 0) < cost.tickets) return { status: 400, body: { message: "Te faltan Poké Balls" } };
    pay(g, cost);
    // Mismo reparto que enseña el juego: cada especie no legendaria pesa lo de su rareza
    const pool = Object.keys(M.Kr).filter((k) => M.Os(k) !== "legendary");
    const w = pool.map((k) => M.wr[M.Os(k)]?.weight ?? 0);
    const total = w.reduce((a, b) => a + b, 0);
    const rank = M.Er;
    const roll = (minRank = 0) => {
      for (let tries = 0; tries < 200; tries++) {
        let x = Math.random() * total;
        let i = 0;
        while (x > w[i]) x -= w[i++];
        const dex = pool[Math.min(i, pool.length - 1)];
        if (rank[M.Os(dex)] >= minRank) return dex;
      }
      return pool[0];
    };
    const meta = ((c.user.meta ||= {}).dex ||= { owned: [], seen: [] });
    const owned = new Set([...g.residents.map((r) => pad(r.dex)), ...g.arrivals.map((r) => pad(r.dex))]);
    const hatched = [];
    const fresh = [];
    let gotRare = false;
    for (let i = 0; i < count; i++) {
      g.eggPity = (g.eggPity || 0) + 1;
      const last = i === count - 1;
      // Seguro (como dice el juego): "Muy raro o mejor" en 30 como mucho; y en una tirada de 10, al menos un raro
      const minRank = g.eggPity >= 30 ? rank.epic : count >= 10 && last && !gotRare ? rank.rare : 0;
      const dex = roll(minRank);
      if (rank[M.Os(dex)] >= rank.rare) gotRare = true;
      if (rank[M.Os(dex)] >= rank.epic) g.eggPity = 0;
      const isNew = !owned.has(dex);
      owned.add(dex);
      const kid = newResident(dex, { ...M.Jt ? {} : {}, shiny: Math.random() < 1 / 512 });
      const r = { ...kid, ...randomGenes() };
      g.arrivals.push(r);
      hatched.push(r);
      fresh.push(isNew);
      if (!isNew) gain(g, { heartScales: M.Gt?.[M.Os(dex)] || 0 });
      if (!meta.seen.includes(dex)) meta.seen.push(dex);
    }
    const st = ((c.user.meta ||= {}).stats ||= {});
    st.hatched = (st.hatched || 0) + count;
    save();
    return ok({ guild: g, hatched, fresh });
  });

  // ---- Taller de Smeargle: MO ----
  route("POST", "/guild/residents/:id/hm", G((g, c) => {
    const r = findR(g, c.params.id);
    const id = c.body?.hm;
    const hm = M.fn[id];
    if (!hm) throw err("Smeargle no conoce esa MO");
    const tutor = best(g, "tutor");
    if (!tutor) throw err("Primero construye el Taller de Smeargle");
    if ((tutor.level || 1) < hm.level) throw err("Mejora el Taller para enseñarla");
    r.hms ||= [];
    if (r.hms.includes(id)) throw err("Ya la sabe");
    pay(g, hm.cost);
    r.hms.push(id);
  }));

  // ---- Herbolario de Bellossom: mentas y hojas ----
  route("POST", "/guild/residents/:id/mint", G((g, c) => {
    const r = findR(g, c.params.id);
    const mint = c.body?.mint;
    if (!best(g, "herbolario")) throw err("Primero construye el Herbolario");
    g.leaves ||= {};
    if (r.mint && (mint === r.nature || !mint)) {
      r.mint = null;
      return;
    }
    const cost = M.Ko(mint);
    for (const [k, v] of Object.entries(cost)) if ((g.leaves[k] || 0) < v) throw err("Te faltan hojas");
    for (const [k, v] of Object.entries(cost)) g.leaves[k] -= v;
    r.mint = mint;
    const st = ((c.user.meta ||= {}).stats ||= {});
    st.minted = (st.minted || 0) + 1;
  }));
  route("POST", "/guild/leaves/trade", G((g, c) => {
    const herb = best(g, "herbolario");
    const rate = [0, 3, 2, 1][Math.min(3, (herb?.level || 1) - 1)];
    if (!rate) throw err("Mejora el Herbolario para cambiar hojas");
    const { from, to } = c.body || {};
    const n = Math.max(1, Number(c.body?.n) || 1);
    g.leaves ||= {};
    if ((g.leaves[from] || 0) < rate * n) throw err("Te faltan hojas");
    g.leaves[from] -= rate * n;
    g.leaves[to] = (g.leaves[to] || 0) + n;
  }));

  // ---- Varios que solo guardan una elección ----
  route("POST", "/guild/banner", G((g, c) => {
    g.banner = { ...g.banner, ...(c.body || {}) };
  }));
  route("POST", "/guild/plaza", G((g, c) => {
    g.plaza = c.body?.kind ?? null;
  }));
  route("POST", "/guild/decor", G((g, c) => {
    g.decor.push(...(c.body?.items || []));
  }));
  route("POST", "/guild/decor/remove", G((g, c) => {
    const cells = new Set((c.body?.cells || []).map((p) => `${p.x},${p.y}`));
    g.decor = g.decor.filter((d) => !cells.has(`${d.x},${d.y}`));
  }));
  route("POST", "/guild/decor/move", G((g, c) => {
    const { from, x, y } = c.body || {};
    const d = g.decor.find((q) => q.x === from?.x && q.y === from?.y);
    if (d) Object.assign(d, { x, y });
  }));
  route("POST", "/guild/chats", G(() => {}));
}

export { RES };
