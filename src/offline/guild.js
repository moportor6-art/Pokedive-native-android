// El refugio (pueblo): edificios, trabajos, llegadas, caseta y tienda de Kecleon.
// Costes, mejoras, capacidades, ritmos de producción, bonos de amistad, recompensas por liberar y artículos de
// la tienda salen tal cual del módulo compartido del juego (M.*), así que coinciden con el original.
import { loadShared } from "./shared.js";
import { save, rid } from "./store.js";

let M;
loadShared().then((m) => (M = m));

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
      const cap = M.Js(b.kind, b.level || 1);
      const now = g.residents.filter((x) => x.job === b.id && x.id !== r.id).length;
      if (now >= cap) throw err("No quedan puestos libres");
      r.job = b.id;
      r.stored = false;
    } else r.job = null;
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
    const cost = M.li.costs[g.boxes || 0];
    if (!cost) throw err("La caseta ya está al máximo");
    pay(g, cost);
    g.boxes = (g.boxes || 0) + 1;
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
