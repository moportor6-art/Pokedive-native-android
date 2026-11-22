// Peligros de cada bioma (capa normal y capa honda, pisos 26+) y monumentos ("una vez por piso").
// Qué peligro tiene cada capa, sus textos, la fauna honda y los monumentos vienen de las tablas del juego (ni, props,
// layout.landmark). Los tiempos, radios y daños los decide el servidor en el original: aquí están reconstruidos.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export const hazardMethods = {
  /** Al crear el piso. */
  setupHazards() {
    const s = this.state;
    const L = this.layout;
    const layer = s.floor > 25 ? 1 : 0;
    const info = this.M.ni?.[s.route]?.[layer];
    this.hz = { kind: L.boss ? null : info?.hazard || null, layer, t: 3, pend: [], zones: [], holes: [], seq: 0, fogOn: false };
    s.landmarkUsed = false;
    const k = this.hz.kind;
    if (k === "sinkholes") {
      const spots = [...(L.enemySpawns || [])].sort(() => Math.random() - 0.5).slice(0, 2);
      this.hz.holes = spots.map((p) => ({ x: p.x, y: p.y, r: 44, vx: rnd(-6, 6), vy: rnd(-6, 6), fx: 0 }));
    }
    if (k === "fog") s.event = "";
    // Alfa propio de la capa honda (uno por piso), con su comportamiento
    if (layer === 1 && !L.boss) {
      const fauna = (info?.fauna || []).filter((d) => this.M.Kr[d]);
      const at = this.hz.holes[0] || pick(L.enemySpawns || []) ;
      if (fauna.length && at) {
        const id = this.spawnEnemy(pick(fauna), at.x, at.y, { alpha: true });
        const ai = this.enemyAI.get(id);
        const e = s.enemies.get(id);
        if (ai && e) {
          ai.deep = s.route;
          ai.deepT = rnd(2, 4);
          if (s.route === "shroom") {
            // El más fuerte de esta capa, con mejor botín
            e.maxHp = Math.round(e.maxHp * 1.6);
            e.hp = e.maxHp;
            ai.loot = 2;
          }
        }
      }
    }
  },

  /** Daño que recibe un alfa hondo según su regla (los textos del juego dicen cuándo es vulnerable). */
  deepGuard(e, ai) {
    if (!ai?.deep) return 1;
    const hz = this.hz;
    switch (ai.deep) {
      case "lava": // con la marea alta apenas recibe daño
        return hz?.zones.length ? 0.2 : 1;
      case "swamp": // en la niebla apenas recibe daño
        return hz?.fogOn ? 0.2 : 1;
      case "ruins": // solo recibe daño sobre una losa encendida
        return hz?.pend.some((w) => w.ty === "psychic" && w.circles.some((c) => dist(c, e) <= c.r + 6)) ? 1.4 : 0.1;
      case "desert": { // espera en el centro de un sumidero: atácalo desde el borde
        return 1;
      }
      default:
        return 1;
    }
  },

  /** Comportamiento de los alfas hondos. Devuelve el movimiento a aplicar. */
  deepStep(id, e, ai, dx, dy, players, dt) {
    if (!ai?.deep || e.frozen) return { dx, dy, mul: 1 };
    const near = players.map(([pid, p]) => ({ pid, p, d: dist(p, e) })).sort((a, b) => a.d - b.d)[0];
    ai.deepT -= dt;
    switch (ai.deep) {
      case "raid": // Arceus no se mueve de su sitio
        return { dx: 0, dy: 0, mul: 1 };
      case "forest": { // echa raíces en anillo quieto y cada poco se arranca y camina hacia ti
        if (ai.rooted > 0) {
          ai.rooted -= dt;
          return { dx: 0, dy: 0, mul: 1 };
        }
        if (ai.deepT <= 0 && near && near.d < 160) {
          ai.deepT = rnd(5, 7);
          ai.rooted = 2.2;
          const circles = [];
          for (let i = 0; i < 8; i++) circles.push({ x: e.x + Math.cos((i / 8) * Math.PI * 2) * 54, y: e.y + Math.sin((i / 8) * Math.PI * 2) * 54, r: 16 });
          this.hzWarn(circles, 1.0, "grass", (c) => {
            for (const [qid, q] of this.hzPlayers()) if (dist(q, c) <= c.r + 4) this.hzStatusPlayer(qid, q, "frozen", 1.2);
            this.fx.push({ t: "burst", x: c.x, y: c.y, r: c.r, ty: "grass", color: "#8fd36a" });
          });
        }
        return { dx, dy, mul: 1 };
      }
      case "desert": { // se queda en el centro del sumidero
        const h = this.hz?.holes[0];
        if (!h) return { dx, dy, mul: 1 };
        const d = dist(h, e);
        return d > 6 ? { dx: (h.x - e.x) / d, dy: (h.y - e.y) / d, mul: 1 } : { dx: 0, dy: 0, mul: 1 };
      }
      case "sea":
      case "ice": { // carga en línea recta cada poco
        if (ai.charge) {
          ai.charge.t -= dt;
          const bx = e.x;
          const by = e.y;
          if (ai.charge.t <= 0) ai.charge = null;
          else return { dx: ai.charge.dx, dy: ai.charge.dy, mul: 3.2, after: () => {
            // Glaciar: si choca contra la pared, queda aturdido
            if (ai.deep === "ice" && Math.hypot(e.x - bx, e.y - by) < 0.3) {
              ai.charge = null;
              ai.st ||= {};
              ai.st.frozen = 2;
              e.frozen = true;
              this.fx.push({ t: "text", x: e.x, y: e.y - 30, text: { es: "¡Aturdido!", en: "Stunned!" }, color: "#9fe3ff" });
            }
          } };
        }
        if (ai.deepT <= 0 && near && near.d < 150) {
          ai.deepT = rnd(3.5, 5);
          const d = near.d || 1;
          ai.charge = { t: 0.9, dx: (near.p.x - e.x) / d, dy: (near.p.y - e.y) / d };
          this.fx.push({ t: "line", x1: e.x, y1: e.y, x2: e.x + ai.charge.dx * 120, y2: e.y + ai.charge.dy * 120, w: 10, ty: ai.types[0], color: "#9fd0ff" });
          return { dx: 0, dy: 0, mul: 1 };
        }
        return { dx, dy, mul: 1 };
      }
      case "storm": { // cada poco llama a los rayos a su alrededor
        if (ai.deepT <= 0 && near && near.d < 160) {
          ai.deepT = rnd(4, 5.5);
          const circles = [];
          for (let i = 0; i < 5; i++) circles.push({ x: e.x + rnd(-70, 70), y: e.y + rnd(-70, 70), r: 20 });
          this.hzWarn(circles, 1.0, "electric", (c) => {
            this.fx.push({ t: "strike", x: c.x, y: c.y });
            this.hzHurtPlayers(c, 1, "electric", ["paralyzed", 1.2]);
            this.hzBoltNear(c);
          });
        }
        return { dx, dy, mul: 1 };
      }
      default:
        return { dx, dy, mul: 1 };
    }
  },

  /** Variante de la capa honda: los del tipo de la ruta dejan algo al caer (textos del juego). */
  variantOnDeath(e) {
    const s = this.state;
    if (s.floor <= 25 || s.mansion || s.raid) return;
    const types = this.M.Kr[e.species]?.types || [];
    const want = s.route === "ruins" ? ["psychic", "ghost"] : [this.M.zr?.[s.route]];
    if (!types.some((t) => want.includes(t))) return;
    const c = { x: e.x, y: e.y, r: 22 };
    const ty = want[0];
    this.note(`${s.route}:1:variant`);
    const by = {
      forest: () => this.hzWarn([c], 1.6, "grass", (q) => {
        for (const [id, p] of this.hzPlayers()) if (dist(p, q) <= q.r + 4) this.hzStatusPlayer(id, p, "frozen", 1);
        this.fx.push({ t: "burst", x: q.x, y: q.y, r: q.r, ty: "grass", color: "#8fd36a" });
      }),
      desert: () => this.hz?.holes.push({ x: e.x, y: e.y, r: 24, vx: 0, vy: 0, fx: 0, small: true }),
      lava: () => this.hzWarn([c], 1.4, "fire", (q) => {
        this.fx.push({ t: "geyser", x: q.x, y: q.y });
        this.hzHurtPlayers(q, 1, "fire", ["burning", 2]);
      }),
      sea: () => this.hzWarn([{ ...c, r: 28 }], 1.0, "water", (q) => {
        this.fx.push({ t: "burst", x: q.x, y: q.y, r: q.r, ty: "water", color: "#7fc8ff" });
        this.hzHurtPlayers(q, 0.6, "water");
      }),
      ice: () => this.hzWarn([c], 1.0, "ice", (q) => {
        for (const [id, p] of this.hzPlayers()) if (dist(p, q) <= q.r + 4) this.hzStatusPlayer(id, p, "frozen", 1.2);
        this.fx.push({ t: "burst", x: q.x, y: q.y, r: q.r, ty: "ice", color: "#9fe3ff" });
      }),
      swamp: () => this.hzWarn([{ ...c, r: 30 }], 1.0, "poison", (q) => {
        this.fx.push({ t: "zone", x: q.x, y: q.y, r: q.r, dur: 3, ty: "poison", color: "#c08ae0" });
        for (const [id, p] of this.hzPlayers()) if (dist(p, q) <= q.r + 4) this.hzStatusPlayer(id, p, "poisoned", 3);
      }),
      ruins: () => this.hzWarn([c], 1.3, "psychic", (q) => {
        this.fx.push({ t: "burst", x: q.x, y: q.y, r: q.r, ty: "psychic", color: "#ff7fbf" });
        this.hzHurtPlayers(q, 0.9, "psychic");
        this.hzHitEnemies(q, 1.2);
      }),
      storm: () => this.hzWarn([c], 1.0, "electric", (q) => {
        this.fx.push({ t: "strike", x: q.x, y: q.y });
        this.hzHurtPlayers(q, 1, "electric", ["paralyzed", 1.2]);
        this.hzBoltNear(q);
      }),
    };
    void ty;
    by[s.route]?.();
  },

  /** Polvo Brillo · de Tormenta: si un rayo cae a tu lado sin tocarte, la esquiva se recarga al momento. */
  hzBoltNear(c) {
    for (const [id, p] of this.hzPlayers()) {
      const d = dist(p, c);
      const pm = this.meta.get(id);
      if (d > c.r + 4 && d < c.r + 40 && pm?.deep?.reflex) p.cdDodge = 0;
    }
  },

  /** Objeto hondo: el de la capa (deep-<base>), mismo efecto que el normal más su extra. */
  dropDeep(x, y) {
    const s = this.state;
    const it = this.M.ni?.[s.route]?.[1]?.deepItem;
    if (!it || s.floor <= 25) return;
    this.spawnPickup("deep-" + it.base, x, y);
  },

  hzDamage() {
    return 6 + this.state.floor * 1.1;
  },

  hzWarn(circles, secs, ty, effect) {
    const id = "hz" + ++this.hz.seq;
    this.fx.push({ t: "hazard", circles, warn: secs, ty, by: id });
    this.hz.pend.push({ id, t: secs, circles, ty, effect });
  },

  /** Un sitio de suelo cerca de un jugador. */
  hzSpotNear(p, min = 0, max = 70) {
    const L = this.layout;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rnd(min, max);
      const x = p.x + Math.cos(a) * d;
      const y = p.y + Math.sin(a) * d;
      const t = L.tiles[Math.floor(y / 16)]?.[Math.floor(x / 16)];
      if (t === 0 || t === 3) return { x, y };
    }
    return { x: p.x, y: p.y };
  },

  hzPlayers() {
    return [...this.state.players.entries()].filter(([, p]) => !p.downed);
  },

  hzHurtPlayers(c, mult = 1, ty = "normal", status) {
    for (const [id, p] of this.hzPlayers()) {
      if (dist(p, c) > c.r + 4) continue;
      this.hurtPlayer(id, p, this.hzDamage() * mult, ty, null);
      if (status) this.hzStatusPlayer(id, p, status[0], status[1]);
    }
  },

  hzStatusPlayer(id, p, k, secs) {
    const pm = this.meta.get(id);
    if (!pm) return;
    if (k !== "frozen" && this.buffOn?.("lum")) return; // Baya Ziuela: protegido de estados
    pm.st ||= {};
    pm.st[k] = Math.max(pm.st[k] || 0, secs);
    if (k in p) p[k] = true;
  },

  hzHitEnemies(c, mult = 1, status) {
    const s = this.state;
    const sid = [...s.players.keys()][0];
    for (const [eid, e] of s.enemies) {
      if (e.dead || dist(e, c) > c.r + 4) continue;
      const ai = this.enemyAI.get(eid);
      if (mult > 0 && !e.boss) {
        e.hp = Math.max(0, e.hp - Math.round(this.hzDamage() * mult * 1.5));
        this.fx.push({ t: "dmg", id: eid, x: e.x, y: e.y - 16, n: Math.round(this.hzDamage() * mult * 1.5), ty: "normal" });
      }
      if (status && ai) {
        ai.st ||= {};
        ai.st[status[0]] = Math.max(ai.st[status[0]] || 0, status[1]);
        if (status[0] in e) e[status[0]] = true;
      }
      if (e.hp <= 0 && sid) this.killEnemy(eid, sid);
    }
  },

  tickHazards(dt) {
    const hz = this.hz;
    const s = this.state;
    if (!hz || s.phase !== "exploring" || s.pausedBy) return;
    // Avisos que se cumplen
    for (const w of hz.pend) w.t -= dt;
    const due = hz.pend.filter((w) => w.t <= 0);
    hz.pend = hz.pend.filter((w) => w.t > 0);
    if (due.length && hz.kind) this.note(`${this.layerKey()}:hazard`);
    if (hz.guardian && !hz.phase2) {
      const b = s.enemies.get(this.bossId);
      if (b && b.hp < b.maxHp / 2) {
        hz.phase2 = true;
        this.note(`${s.route}:1:pattern-b`);
      }
    }
    for (const w of due) {
      this.fx.push({ t: "hazard-off", by: w.id });
      for (const c of w.circles) w.effect(c);
    }
    // Zonas que dañan mientras duran (marea de lava)
    for (const z of hz.zones) {
      z.left -= dt;
      z.acc = (z.acc || 0) + dt;
      if (z.acc >= 0.5) {
        z.acc = 0;
        this.hzHurtPlayers(z, 0.35, z.ty, z.status);
      }
    }
    hz.zones = hz.zones.filter((z) => z.left > 0);
    // Peligros del mapa (hierba alta, arenas movedizas, corrientes, hielo, lluvia): se apuntan al pisarlos
    hz.tileT = (hz.tileT || 0) - dt;
    if (hz.tileT <= 0 && s.floor <= 25 && !s.mansion) {
      hz.tileT = 1;
      const tiles = { forest: [3], desert: [9], sea: [10, 11, 12, 13], ice: [15] }[s.route];
      for (const [, p] of this.hzPlayers()) {
        const t = this.layout.tiles[Math.floor(p.y / 16)]?.[Math.floor(p.x / 16)];
        if (tiles?.includes(t)) this.note(`${s.route}:0:hazard`);
      }
      if (s.route === "swamp" && s.event === "rain") this.note("swamp:0:hazard");
    }
    // Raíces: brotan bajo quien se queda quieto
    if (hz.kind === "roots") {
      for (const [id, p] of this.hzPlayers()) {
        const pm = this.meta.get(id);
        if (!pm) continue;
        pm.stillT = p.moving ? 0 : (pm.stillT || 0) + dt;
        if (pm.stillT > 1.4) {
          pm.stillT = -2;
          this.hzWarn([{ x: p.x, y: p.y, r: 22 }], 0.8, "grass", (c) => {
            for (const [qid, q] of this.hzPlayers()) if (dist(q, c) <= c.r + 4) this.hzStatusPlayer(qid, q, "frozen", 1.2);
            this.hzHitEnemies(c, 0, ["frozen", 2]);
            this.fx.push({ t: "burst", x: c.x, y: c.y, r: c.r, ty: "grass", color: "#8fd36a" });
          });
        }
      }
    }
    // Hondonadas: atraen, se desplazan despacio y dañan en el centro
    if (hz.kind === "sinkholes") {
      for (const h of hz.holes) {
        h.x += h.vx * dt;
        h.y += h.vy * dt;
        const t = this.layout.tiles[Math.floor(h.y / 16)]?.[Math.floor(h.x / 16)];
        if (t !== 0 && t !== 3) {
          h.vx = -h.vx;
          h.vy = -h.vy;
        }
        h.fx -= dt;
        if (h.fx <= 0) {
          h.fx = 1.6;
          this.fx.push({ t: "zone", x: h.x, y: h.y, r: h.r, dur: 1.8, ty: "ground", color: "#d9b46a" });
        }
        for (const [id, p] of this.hzPlayers()) {
          const d = dist(p, h);
          if (d < 14) {
            const pm = this.meta.get(id);
            pm.sinkAcc = (pm.sinkAcc || 0) + dt;
            if (pm.sinkAcc > 0.6) {
              pm.sinkAcc = 0;
              this.hurtPlayer(id, p, this.hzDamage() * 0.4, "ground", null);
            }
          }
        }
      }
    }
    // Niebla tóxica en oleadas
    if (hz.kind === "fog") {
      hz.fogT = (hz.fogT ?? 6) - dt;
      if (hz.fogT <= 0) {
        hz.fogOn = !hz.fogOn;
        hz.fogT = hz.fogOn ? 9 : 8;
        s.event = hz.fogOn ? "fog" : "";
      }
      if (hz.fogOn) {
        hz.fogAcc = (hz.fogAcc || 0) + dt;
        if (hz.fogAcc > 3) {
          hz.fogAcc = 0;
          for (const [id, p] of this.hzPlayers()) this.hzStatusPlayer(id, p, "poisoned", 2);
        }
      }
    }
    // Pulsos periódicos
    hz.t -= dt;
    if (hz.t > 0) return;
    const players = this.hzPlayers();
    if (!players.length) return;
    const D = this.hzDamage();
    switch (hz.kind) {
      case "lightning": {
        hz.t = rnd(3.5, 5.5);
        const [, p] = pick(players);
        this.hzWarn([{ ...this.hzSpotNear(p, 0, 50), r: 20 }], 1.0, "electric", (c) => {
          this.fx.push({ t: "strike", x: c.x, y: c.y });
          this.hzHurtPlayers(c, 1, "electric", ["paralyzed", 1.2]);
          this.hzHitEnemies(c, 1);
          this.hzBoltNear(c);
        });
        break;
      }
      case "thunderstorm": {
        hz.t = rnd(2.4, 3.4);
        const circles = players.map(([, p]) => ({ ...this.hzSpotNear(p, 0, 30), r: 20 }));
        for (let i = 0; i < 2; i++) circles.push({ ...this.hzSpotNear(pick(players)[1], 30, 90), r: 20 });
        this.hzWarn(circles, 1.0, "electric", (c) => {
          this.fx.push({ t: "strike", x: c.x, y: c.y });
          this.hzHurtPlayers(c, 1, "electric", ["paralyzed", 1.2]);
          this.hzHitEnemies(c, 1);
          this.hzBoltNear(c);
        });
        break;
      }
      case undefined:
      case null:
        hz.t = 999;
        break;
      default:
        hz.t = this.hzPulse(hz.kind, players, D) * (hz.phase2 ? 0.6 : 1);
    }
  },

  /** Peligros con aviso en un sitio: devuelve el tiempo hasta el siguiente. */
  hzPulse(kind, players) {
    const L = this.layout;
    const near = (list, r) => list.filter((g) => players.some(([, p]) => dist(p, g) < r));
    switch (kind) {
      case "geysers": {
        // Los géiseres del mapa (props) que están cerca de alguien
        const gs = near(L.props.filter((g) => g.kind === "geyser"), 220);
        const spots = gs.length ? gs : [this.hzSpotNear(pick(players)[1], 20, 80)];
        const g = pick(spots);
        this.fx.push({ t: "geyser", x: g.x, y: g.y, warn: true });
        this.hzWarn([{ x: g.x, y: g.y, r: 22 }], 1.0, "fire", (c) => {
          this.fx.push({ t: "geyser", x: c.x, y: c.y });
          this.hzHurtPlayers(c, 1, "fire", ["burning", 2]);
          this.hzHitEnemies(c, 1, ["burning", 2]);
        });
        return rnd(3.5, 5.5);
      }
      case "puffballs":
      case "mycelium": {
        const ps = near(L.props.filter((g) => g.kind === "puffball"), 200);
        const n = kind === "mycelium" ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const g = ps.length ? pick(ps) : this.hzSpotNear(pick(players)[1], 20, 80);
          this.fx.push({ t: "geyser", x: g.x, y: g.y, warn: true, spore: true });
          this.hzWarn([{ x: g.x, y: g.y, r: kind === "mycelium" ? 34 : 26 }], 1.0, "poison", (c) => {
            this.fx.push({ t: "geyser", x: c.x, y: c.y, spore: true });
            // Pañuelo Elección · Fúngico: cuando estalla una seta cerca de ti, te da frenesí
            for (const [id, p] of this.hzPlayers()) {
              const pm = this.meta.get(id);
              if (pm?.deep?.frenzy && dist(p, c) < 70) {
                p.frenzy = true;
                pm.frenzyT = Math.max(pm.frenzyT || 0, 3);
              }
            }
            this.hzHurtPlayers(c, kind === "mycelium" ? 0.8 : 0.5, "poison", kind === "mycelium" ? null : ["poisoned", 3]);
            // El micelio envenena a los enemigos que tiene cerca
            this.hzHitEnemies(c, 0, ["poisoned", 4]);
          });
        }
        return kind === "mycelium" ? rnd(3, 4.5) : rnd(5, 7);
      }
      case "slabs": {
        const [, p] = pick(players);
        this.hzWarn([{ x: p.x, y: p.y, r: 18 }], 0.9, "rock", (c) => {
          this.fx.push({ t: "slam", x: c.x, y: c.y, r: c.r });
          this.hzHurtPlayers(c, 1, "rock");
          this.hzHitEnemies(c, 1);
        });
        return rnd(5, 8);
      }
      case "runes": {
        // Se encienden en patrones y estallan: en cruz alrededor de alguien
        const [, p] = pick(players);
        const o = this.hzSpotNear(p, 0, 40);
        const d = 36;
        const circles = [o, { x: o.x + d, y: o.y }, { x: o.x - d, y: o.y }, { x: o.x, y: o.y + d }, { x: o.x, y: o.y - d }].map((c) => ({ ...c, r: 18 }));
        this.hzWarn(circles, 1.3, "psychic", (c) => {
          this.fx.push({ t: "burst", x: c.x, y: c.y, r: c.r, ty: "psychic", color: "#ff7fbf" });
          this.hzHurtPlayers(c, 0.9, "psychic");
          this.hzHitEnemies(c, 1.2);
        });
        return rnd(4, 6);
      }
      case "tide": {
        // Zonas que se inundan de lava por ciclos tras un aviso, y se secan
        const circles = [];
        for (let i = 0; i < 2; i++) circles.push({ ...this.hzSpotNear(pick(players)[1], 0, 90), r: 34 });
        this.hzWarn(circles, 1.5, "fire", (c) => {
          this.fx.push({ t: "zone", x: c.x, y: c.y, r: c.r, dur: 3, ty: "fire", color: "#ff9a4a" });
          this.hz.zones.push({ ...c, left: 3, ty: "fire", status: ["burning", 2] });
          // Banda Focus · Volcánica: cada subida de la marea recarga un especial
          for (const [id, p] of this.hzPlayers()) {
            if (!this.meta.get(id)?.deep?.focus) continue;
            if (p.cd1 >= p.cd2) p.cd1 = 0;
            else p.cd2 = 0;
          }
          this.hzHitEnemies(c, 1, ["burning", 3]);
        });
        return rnd(5, 7);
      }
      case "riptide": {
        // Las corrientes invierten su dirección, con un pulso de aviso
        this.state.flip = !this.state.flip;
        this.fx.push({ t: "pulse" });
        return rnd(7, 10);
      }
      default:
        return 999; // hierba alta, arenas movedizas, corrientes, hielo: van en el mapa y la física del juego
    }
  },

  /** Monumento del piso (una vez por piso, para todo el grupo). Efectos: los textos del propio juego. */
  onLandmark(client) {
    const s = this.state;
    const lm = this.layout?.landmark;
    const p = s.players.get(client.sessionId);
    const pm = this.meta.get(client.sessionId);
    if (!lm || !p || !pm || s.landmarkUsed || p.downed || dist(p, lm) > 44) return;
    s.landmarkUsed = true;
    this.note(`${this.layerKey()}:landmark`);
    const all = [...s.players.entries()];
    const txt = (es, en) => this.fx.push({ t: "banner", text: { es, en } });
    switch (lm.kind) {
      case "shrine": // el grupo recupera toda la vida
        for (const [qid, q] of all) if (!q.downed) {
          const n = q.maxHp - q.hp;
          q.hp = q.maxHp;
          this.fx.push({ t: "heal", id: qid, n, x: q.x, y: q.y - 20 });
        }
        txt("El santuario os cura", "The shrine heals you");
        break;
      case "obelisk": // +30 % de daño durante 60 s
        for (const [, q] of all) {
          const m = this.meta.get([...s.players.entries()].find(([, x]) => x === q)[0]);
          if (m) m.obeliskT = 60;
        }
        txt("+30 % de daño durante 60 s", "+30% damage for 60 s");
        break;
      case "altar": {
        // das un 30 % de tu vida a cambio de un objeto
        p.hp = Math.max(1, Math.round(p.hp - p.maxHp * 0.3));
        this.spawnPickup("up-" + pick(this.upgradePool()), lm.x, lm.y + 18);
        txt("El altar acepta tu ofrenda", "The altar accepts your offering");
        break;
      }
      case "shipwreck": // Pokecoins y bayas
        this.dropLoot(lm.x, lm.y + 16, 6, true);
        txt("¡Un tesoro en el barco hundido!", "Treasure in the shipwreck!");
        break;
      case "frostspire": // congela a los enemigos cercanos
        this.hzHitEnemies({ x: lm.x, y: lm.y, r: 170 }, 0, ["frozen", 4]);
        this.fx.push({ t: "ring", x: lm.x, y: lm.y, r: 170, ty: "ice", color: "#9fe3ff", mv: "ice-beam" });
        txt("La aguja congela a los enemigos", "The spire freezes the enemies");
        break;
      case "totem": // revela el mapa del piso
        this.fx.push({ t: "reveal" });
        txt("El tótem revela el piso", "The totem reveals the floor");
        break;
      case "monolith": // experiencia para subir de nivel
        for (const [qid, q] of all) if (!q.downed) this.giveXp(qid, q, q.xpNext - q.xp);
        break;
      case "fairyring": // levanta a los caídos y cura
        for (const [qid, q] of all) {
          if (q.downed) {
            q.downed = false;
            q.hp = Math.round(q.maxHp * 0.5);
            this.fx.push({ t: "revived", id: qid, x: q.x, y: q.y });
          } else {
            const n = Math.round(q.maxHp * 0.5);
            q.hp = Math.min(q.maxHp, q.hp + n);
            this.fx.push({ t: "heal", id: qid, n, x: q.x, y: q.y - 20 });
          }
        }
        txt("El corro de setas os levanta", "The fairy ring restores you");
        break;
      case "coil": // recarga los especiales del grupo
        for (const [, q] of all) {
          q.cd1 = 0;
          q.cd2 = 0;
        }
        txt("La bobina recarga los especiales", "The coil recharges your specials");
        break;
    }
  },
};
