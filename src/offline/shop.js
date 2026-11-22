// Tienda de Kecleon dentro de las rutas, cofres sellados y el Cuaderno de Rutas.
// Del juego: los objetos de la tienda y sus precios base, categorías y pesos (tabla ls; los "up-…" son mejoras para
// todo el grupo), el saco de dormir (ps), qué abre un cofre sellado (un ataque de su tipo, zs) y todas las notas del
// cuaderno (Un). Reconstruido: en qué pisos aparece la tienda, cuántos objetos pone, la subida de precio con la
// profundidad, qué cofres salen sellados o con guardián y cuándo se apunta cada nota.

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ITEMS = ["sitrus", "potion", "lum", "seed", "elixir", "xattack", "xdefense", "orb", "pull", "key", "scroll", "candy", "egg", "amulet"];
const WEIGHTS = { sitrus: 14, potion: 12, lum: 8, seed: 10, elixir: 9, xattack: 7, xdefense: 7, orb: 10, pull: 6, key: 5, scroll: 8, candy: 2, egg: 5, amulet: 5 };
const LOOT_OF = { forest: "berries", swamp: "berries", desert: "materials", lava: "materials", ruins: "materials", sea: "crystals", ice: "crystals", shroom: "crystals", storm: "crystals" };
const TYPES = ["fire", "water", "grass", "electric", "ice", "rock", "ground", "poison", "bug", "flying", "psychic", "fighting", "ghost", "dark", "steel", "fairy", "dragon", "normal"];

export const shopMethods = {
  // ---------- Tienda ----------
  setupShop() {
    const s = this.state;
    const L = this.layout;
    s.shopX = -1;
    s.shopY = -1;
    if (s.mansion || s.raid || L.boss || s.floor < 3 || s.floor % 5 === 0 || Math.random() > 0.3) return;
    const spots = (L.enemySpawns || []).filter((sp) => dist(sp, L.spawns[0]) > 120 && dist(sp, L.stairs) > 80);
    const at = pick(spots);
    if (!at) return;
    s.shopX = at.x;
    s.shopY = at.y;
    // Que no haya enemigos encima del mostrador
    for (const [eid, e] of s.enemies) if (!e.boss && dist(e, at) < 60) s.enemies.delete(eid), this.enemyAI.delete(eid);
    const bag = [];
    const pool = ITEMS.flatMap((k) => Array(WEIGHTS[k]).fill(k));
    while (bag.length < 4) {
      const k = pick(pool);
      if (!bag.includes(k)) bag.push(k);
    }
    // A veces, una mejora para todo el grupo
    if (Math.random() < 0.5) bag.push("up-" + pick(this.upgradePool()));
    const sale = Math.floor(Math.random() * bag.length);
    bag.forEach((k, i) => {
      const def = this.M.Ws?.(k) || null;
      const base = k.startsWith("up-") ? 40 : this.shopBase(k);
      let price = Math.round(base * (1 + s.floor * 0.04));
      const onSale = i === sale && Math.random() < 0.5;
      if (onSale) price = Math.round(price * 0.6);
      const id = this.spawnPickup("shop-" + k, at.x - 36 + i * 18, at.y + 26);
      const pk = s.pickups.get(id);
      pk.price = Math.min(65535, price);
      pk.sale = onSale;
      void def;
    });
  },

  shopBase(k) {
    return { sitrus: 13, potion: 6, lum: 12, seed: 18, elixir: 14, xattack: 16, xdefense: 16, orb: 8, pull: 22, key: 14, scroll: 24, candy: 26, egg: 20, amulet: 8 }[k] || 15;
  },

  onBuy(client, m) {
    const s = this.state;
    const p = s.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    const pk = s.pickups.get(String(m?.id));
    if (!p || !pm || !pk || !pk.kind.startsWith("shop-") || pk.buyer || p.downed) return;
    if (s.shopX < 0 || Math.hypot(p.x - s.shopX, p.y - (s.shopY + 22)) > 80) return;
    if (s.coins < pk.price) return;
    s.coins -= pk.price;
    pk.buyer = p.name || client.sessionId;
    this.shopBuys = (this.shopBuys || 0) + 1;
    this.fx.push({ t: "pick", kind: "buy", x: pk.x, y: pk.y, id: client.sessionId });
    this.applyShopItem(client.sessionId, p, pm, pk.kind.slice(5));
  },

  applyShopItem(id, p, pm, k) {
    const s = this.state;
    const all = [...s.players.entries()].filter(([, q]) => !q.downed);
    const buff = (name) => ((this.buffs ||= {})[name] = 3);
    const heal = (q, qid, f) => {
      const n = Math.round(q.maxHp * f);
      q.hp = Math.min(q.maxHp, q.hp + n);
      this.fx.push({ t: "heal", id: qid, n, x: q.x, y: q.y - 20 });
    };
    if (k.startsWith("up-")) {
      // Mejora para todo el grupo
      const up = k.slice(3);
      for (const [qid, q] of s.players) {
        const cur = Object.fromEntries((q.upgrades || "").split(",").filter(Boolean).map((x) => x.split(":")).map(([a, n]) => [a, Number(n)]));
        const max = this.M.gi?.[up]?.max ?? 3;
        if ((cur[up] || 0) < max) cur[up] = (cur[up] || 0) + 1;
        q.upgrades = Object.entries(cur).map(([a, n]) => `${a}:${n}`).join(",");
        const qm = this.meta.get(qid);
        if (qm) this.applyStats(q, qm);
        this.fx.push({ t: "item", id: qid, up, lv: cur[up] || 0, max, x: q.x, y: q.y });
      }
      return;
    }
    switch (k) {
      case "sitrus":
        for (const [qid, q] of all) heal(q, qid, 0.35);
        break;
      case "potion":
        heal(p, id, 0.5);
        break;
      case "lum":
        for (const [qid, q] of all) {
          const qm = this.meta.get(qid);
          if (qm?.st) for (const st of Object.keys(qm.st)) qm.st[st] = 0;
          for (const st of ["burning", "poisoned", "paralyzed", "frozen", "asleep", "confused"]) if (st in q) q[st] = false;
        }
        buff("lum");
        break;
      case "seed":
        pm.bag ||= {};
        pm.bag.seed = (pm.bag.seed || 0) + 1;
        break;
      case "elixir":
        for (const [, q] of s.players) {
          q.cd1 = 0;
          q.cd2 = 0;
        }
        buff("elixir");
        break;
      case "xattack":
        buff("xattack");
        break;
      case "xdefense":
        buff("xdefense");
        break;
      case "orb":
        this.fx.push({ t: "reveal" });
        s.event = "";
        break;
      case "pull":
        pm.pull = true;
        break;
      case "key":
        for (const pk of s.pickups.values()) if (pk.kind === "chest" && pk.lock) this.unlockChest(pk);
        break;
      case "scroll":
        p.learnPending = Math.min(255, p.learnPending + 1);
        this.offerLearn(p, pm);
        break;
      case "candy":
        for (let i = 0; i < 3; i++) this.giveXp(id, p, Math.max(1, p.xpNext - p.xp));
        break;
      case "egg":
        buff("egg");
        break;
      case "amulet":
        buff("amulet");
        break;
    }
  },

  /** Efectos de los objetos que duran 3 pisos. */
  buffOn(k) {
    return (this.buffs?.[k] || 0) > 0;
  },
  tickBuffsFloor() {
    if (!this.buffs) return;
    for (const k of Object.keys(this.buffs)) this.buffs[k]--;
    if (this.buffOn("elixir")) for (const p of this.state.players.values()) {
      p.cd1 = 0;
      p.cd2 = 0;
    }
  },

  // ---------- Cofres sellados ----------
  sealChests() {
    const s = this.state;
    if (s.mansion || s.raid || s.floor < 3) return;
    const chests = [...s.pickups.entries()].filter(([, k]) => k.kind === "chest");
    if (!chests.length) return;
    const [cid, ch] = pick(chests);
    const r = Math.random();
    if (r < 0.35) {
      // Sello de un tipo: se abre con un ataque de ese tipo
      const routeTypes = (this.M.W?.[s.route] && Object.values(this.M.W[s.route]).flatMap((v) => v?.types || [])) || [];
      ch.lock = pick(routeTypes.length ? routeTypes : TYPES);
    } else if (r < 0.6) {
      // Con guardián: un alfa al lado; al vencerlo se abre
      ch.lock = "guard";
      const pool = this.speciesPool();
      const gid = this.spawnEnemy(pick(pool.alpha), ch.x + 18, ch.y + 10, { alpha: true });
      this.chestGuard = { gid, cid };
    }
  },

  unlockChest(pk) {
    pk.lock = "";
    this.fx.push({ t: "text", x: pk.x, y: pk.y - 20, text: { es: "¡Abierto!", en: "Unlocked!" }, color: "#ffe066" });
    this.fx.push({ t: "burst", x: pk.x, y: pk.y, r: 18, ty: "normal", color: "#ffe066" });
  },

  /** Un ataque del tipo del sello que alcanza al cofre lo abre (misma regla que el cliente). */
  hitSeals(p, mv) {
    if (!mv?.type) return;
    for (const pk of this.state.pickups.values()) {
      if (pk.kind !== "chest" || !pk.lock || pk.lock === "guard" || pk.lock !== mv.type) continue;
      if (dist(p, pk) < (mv.range || 110) * 1.25) this.unlockChest(pk);
    }
  },

  onEnemyGone(eid) {
    if (this.chestGuard?.gid === eid) {
      const pk = this.state.pickups.get(this.chestGuard.cid);
      if (pk) this.unlockChest(pk);
      this.chestGuard = null;
    }
  },

  // ---------- Cuaderno de Rutas ----------
  note(key) {
    if (!this.M.Un?.[key]) return;
    this.runNotes ||= new Set();
    if (this.runNotes.has(key) || this.knownNotes?.has(key)) return;
    this.runNotes.add(key);
    this.fx.push({ t: "note", key });
  },
  layerKey() {
    const s = this.state;
    return `${s.route}:${s.floor > 25 ? 1 : 0}`;
  },
  noteKill(e, ai) {
    const s = this.state;
    if (s.mansion || s.raid) return;
    const lk = this.layerKey();
    if (s.floor <= 25) for (const t of this.M.Kr[e.species]?.types || []) this.note(`${lk}:type-${t}`);
    else {
      this.note(`${lk}:mon-${e.species}`);
      if (ai?.deep) this.note(`${lk}:alpha`);
    }
  },
  noteLoot(kind) {
    const s = this.state;
    if (s.floor <= 25 && kind === "res-" + LOOT_OF[s.route]) this.note(`${s.route}:0:loot`);
  },
};
