// Raid de Arceus en la Sala del Origen (evento, aquí siempre activo).
// Del juego: la sala (generador "raid"), el estado de la raid (fase|tabla|tiempo|sentencia), los nombres y la forma de
// cada ataque (efectos raid-fx que dibuja el cliente), sus constantes (tabla pr: onda, meteoros, rayos, tiempo, orbes de
// tabla, grieta, juicio en bandas, Unown, sentencia final), la intro (7,5 s) y el final (9,5 s), quién puede entrar
// (Flauta Azur o tener ya a Arceus), la probabilidad de que se una (+5 % por victoria) y las recompensas.
// Reconstruido (lo decide el servidor en el original): la vida de Arceus, el orden de los ataques, el daño exacto y
// la duración total.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.random() * (b - a);
export const ARCEUS = "0493";
const UNOWN = "0201";
const RAID_SECS = 8 * 60;
const RAID_LEVEL = 40; // todos suben a la sala con el mismo nivel

export const raidMethods = {
  onRaid(client, m) {
    const s = this.state;
    if (client.sessionId !== s.host || s.phase !== "lobby") return;
    if (!m?.on) {
      s.raid = "";
      return;
    }
    // Hace falta la Flauta Azur (o tener ya a Arceus para ayudar a otros)
    const missing = [];
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      if (!pm?.raidOk) missing.push(p.name);
    }
    if (missing.length) {
      client.send(this.M._r || "raidLocked", { names: missing });
      return;
    }
    this.rd = { phase: 0, plate: "", t: RAID_SECS, finalT: 0, intro: this.M.gr ?? 7.5, next: 3, plates: [], stun: 0, orbs: [], waves: [], zones: [], unownT: 20, plateT: 0, over: false };
    s.raid = "0||" + RAID_SECS + "|0";
    this.startFloor = 1;
    this.beginRun();
  },

  /** La sala: Arceus en el centro, nada más. */
  setupRaid() {
    const s = this.state;
    const L = this.layout;
    s.legend = "";
    s.event = "";
    s.ropeX = -1;
    s.ropeY = -1;
    s.stairsX = -9999;
    s.stairsY = -9999;
    s.rescueSpecies = "";
    s.rescueX = -9999;
    s.rescueY = -9999;
    const n = Math.max(1, s.players.size);
    this.bossId = this.spawnEnemy(ARCEUS, L.boss.x, L.boss.y - 20, { boss: true });
    const e = s.enemies.get(this.bossId);
    const ai = this.enemyAI.get(this.bossId);
    e.maxHp = Math.round(2600 * (0.6 + 0.4 * n));
    e.hp = e.maxHp;
    ai.deep = "raid";
    // Todos al mismo nivel
    for (const [id, p] of s.players) {
      const pm = this.meta.get(id);
      if (pm) pm.origLevel ??= p.level;
      p.level = RAID_LEVEL;
      if (pm) {
        pm.level = RAID_LEVEL;
        this.applyStats(p, pm);
        p.hp = p.maxHp;
      }
    }
  },

  raidSync() {
    const r = this.rd;
    this.state.raid = `${r.phase}|${r.plate}|${Math.max(0, Math.ceil(r.t))}|${Math.max(0, Math.ceil(r.finalT))}`;
  },

  rfx(mv, o) {
    this.fx.push({ t: "raid-fx", mv, ...o });
  },

  raidHurt(c, power, ty, statusK) {
    const C = this.M.pr || {};
    for (const [id, p] of this.state.players) {
      if (p.downed || (p.dodgeT || 0) > 0) continue;
      if (c.r !== undefined && dist(p, c) > c.r + 4) continue;
      this.hurtPlayer(id, p, 34 * power, ty || this.rd.plate || "normal", null);
      if (statusK) this.hzStatusPlayer(id, p, statusK[0], statusK[1]);
    }
  },

  tickRaid(dt) {
    const s = this.state;
    const r = this.rd;
    if (!s.raid || !r || s.phase !== "exploring" || r.over) return;
    const C = this.M.pr || {};
    const boss = s.enemies.get(this.bossId);
    const ai = this.enemyAI.get(this.bossId);
    if (!boss) return;
    // Intro: Arceus no recibe daño
    if (r.phase === 0) {
      r.intro -= dt;
      boss.hp = boss.maxHp;
      if (r.intro <= 0) {
        r.phase = 1;
        this.raidNewPlate();
      }
      this.raidSync();
      return;
    }
    r.t -= dt;
    r.syncT = (r.syncT || 0) - dt;
    if (r.syncT <= 0) {
      r.syncT = 0.5;
      this.raidSync();
    }
    // Fases por vida
    const frac = boss.hp / boss.maxHp;
    const ph = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
    if (ph > r.phase) {
      r.phase = ph;
      this.rfx("warp", { x: boss.x, y: boss.y, life: 1.2 });
      this.raidNewPlate();
    }
    // Cambia de tabla cada poco
    r.plateT -= dt;
    if (r.plateT <= 0) this.raidNewPlate();
    // Aturdido por los orbes de tabla
    if (r.stun > 0) r.stun -= dt;
    // Se acaba el tiempo: Sentencia final
    if (r.t <= 0 && !r.finalT) {
      r.finalT = C.final?.min ?? 34;
      this.rfx("final", { x: boss.x, y: boss.y, life: r.finalT });
      this.fx.push({ t: "banner", text: { es: "¡Sentencia final!", en: "Final judgment!" } });
    }
    if (r.finalT > 0) {
      r.finalT -= dt;
      r.finalAcc = (r.finalAcc || 0) + dt;
      if (r.finalAcc >= 2) {
        r.finalAcc = 0;
        this.rfx("nova", { x: boss.x, y: boss.y, r: 400, life: 0.8 });
        this.raidHurt({ x: boss.x, y: boss.y }, C.final?.power ?? 0.5);
      }
      if (r.finalT <= 0) {
        // Nadie lo venció a tiempo: todos caen
        for (const [id, p] of s.players) if (!p.downed) this.hurtPlayer(id, p, 99999, "normal", null);
      }
    }
    this.tickRaidShapes(dt, boss);
    // Unown que acompañan
    r.unownT -= dt;
    if (r.unownT <= 0) {
      r.unownT = 25;
      const alive = [...s.enemies.values()].filter((e) => !e.dead && e.species === UNOWN).length;
      const n = Math.min((C.unown?.max ?? 12) - alive, (C.unown?.base ?? 2) + (r.phase >= 3 ? C.unown?.late ?? 2 : 0));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const x = boss.x + Math.cos(a) * 120;
        const y = boss.y + Math.sin(a) * 90;
        this.spawnEnemy(UNOWN, x, y);
        this.rfx("summon", { x, y, life: 0.8 });
      }
    }
    // Siguiente ataque
    if (r.stun > 0) return;
    r.next -= dt;
    if (r.next > 0) return;
    const pool = r.phase === 1 ? ["wave", "meteor", "beams", "orbs"] : r.phase === 2 ? ["wave", "meteor", "beams", "time", "rift", "orbs", "judgment"] : ["meteor", "beams", "time", "rift", "orbs", "judgment", "arms", "dark"];
    const atk = pick(pool);
    r.next = (r.phase === 3 ? 3.2 : 4.2) + Math.random();
    this[`raid_${atk}`]?.(boss, C);
  },

  raidNewPlate() {
    const r = this.rd;
    const types = (this.M.U || []).map((route) => this.M.zr?.[route]).filter(Boolean);
    const all = types.length ? types : ["fire", "water", "electric", "grass", "ice", "poison", "ground", "rock", "bug"];
    let next = pick(all);
    if (next === r.plate) next = pick(all);
    r.plate = next;
    if (!r.plates.includes(next)) r.plates.push(next);
    r.plateT = 30;
    const boss = this.state.enemies.get(this.bossId);
    if (boss) this.rfx("cast", { x: boss.x, y: boss.y, ty: next, life: 1 });
    this.raidSync();
  },

  /** Formas que duran (onda, zonas de tiempo, orbes). */
  tickRaidShapes(dt, boss) {
    const r = this.rd;
    const C = this.M.pr || {};
    for (const w of r.waves) {
      w.t += dt;
      if (w.t < 0) continue;
      const rad = w.r0 + w.speed * w.t;
      for (const [id, p] of this.state.players) {
        if (p.downed || w.hit.has(id) || (p.dodgeT || 0) > 0) continue;
        if (Math.abs(dist(p, w) - rad) < w.band) {
          w.hit.add(id);
          this.hurtPlayer(id, p, 34 * w.power, r.plate || "normal", null);
        }
      }
    }
    r.waves = r.waves.filter((w) => w.t < w.life);
    for (const z of r.zones) z.left -= dt;
    r.zones = r.zones.filter((z) => z.left > 0);
    // Orbes de tabla: quedarse encima los carga; cargados, aturden a Arceus
    for (const o of r.orbs) {
      o.left -= dt;
      const on = [...this.state.players.values()].some((p) => !p.downed && dist(p, o) < o.r + 4);
      o.prog = Math.max(0, o.prog + (on ? dt : -dt * (C.orbs?.decay ?? 0.5)));
      o.fxT = (o.fxT || 0) - dt;
      if (o.fxT <= 0) {
        o.fxT = 0.5;
        this.rfx("plate", { id: o.id, x: o.x, y: o.y, r: o.r, ty: o.ty, on: o.prog, w: Math.max(0, o.left / o.secs), life: 0.6 });
      }
      if (o.prog >= (C.orbs?.need ?? 1.5)) {
        o.left = 0;
        o.done = true;
        this.rfx("plate-break", { x: o.x, y: o.y, ty: o.ty, life: 0.8 });
        r.stun = C.orbs?.stun ?? 6;
        this.rfx("stun", { x: boss.x, y: boss.y, life: r.stun });
        this.fx.push({ t: "banner", text: { es: "¡Arceus está aturdido!", en: "Arceus is stunned!" } });
      }
    }
    for (const o of r.orbs.filter((o) => o.left <= 0 && !o.done)) {
      // No se cargó a tiempo: estalla y Arceus se cura
      this.rfx("arena-blast", { x: boss.x, y: boss.y, r: 400, ty: o.ty, life: 0.8 });
      this.raidHurt({ x: boss.x, y: boss.y }, C.orbs?.power ?? 1.6, o.ty);
      boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp * (C.orbs?.heal ?? 0.06));
      this.rfx("heal", { x: boss.x, y: boss.y, life: 0.8 });
    }
    r.orbs = r.orbs.filter((o) => o.left > 0);
  },

  /** Daño que recibe Arceus: más mientras está aturdido; nada durante la intro. */
  raidTaken() {
    const r = this.rd;
    if (!r) return 1;
    if (r.phase === 0) return 0;
    return r.stun > 0 ? this.M.pr?.orbs?.taken ?? 1.5 : 1;
  },

  raid_wave(boss, C) {
    const W = C.wave || { charge: 2, speed: 110, band: 9, power: 1.1 };
    this.rfx("wave-charge", { x: boss.x, y: boss.y, r: 20, ty: this.rd.plate, life: W.charge });
    this.rd.waves.push({ x: boss.x, y: boss.y, r0: 20, speed: W.speed, band: W.band + 6, power: W.power, t: -W.charge, life: 4, hit: new Set() });
    this.clock.setTimeout(() => this.rfx("wave", { x: boss.x, y: boss.y, r: 20, x2: W.speed, ty: this.rd?.plate, life: 4 }), W.charge * 1000);
  },

  raid_meteor(boss, C) {
    const M = C.meteor || { tele: 1.4, r: 26, power: 1 };
    const players = [...this.state.players.values()].filter((p) => !p.downed);
    for (const p of players) {
      for (let i = 0; i < 2; i++) {
        const c = { x: p.x + rnd(-30, 30), y: p.y + rnd(-24, 24), r: M.r };
        this.rfx("meteor", { ...c, ty: this.rd.plate, life: M.tele });
        this.clock.setTimeout(() => this.raidHurt(c, M.power), M.tele * 1000);
      }
    }
  },

  raid_beams(boss, C) {
    const B = C.beams || { tele: 3, warn: 0.35, spread: 32, stack: 36, power: 0.9, stackPower: 2.6 };
    for (const [, p] of this.state.players) {
      if (p.downed) continue;
      const tgt = { x: p.x, y: p.y };
      this.rfx("beam-warn", { x: boss.x, y: boss.y, x2: tgt.x, y2: tgt.y, r: B.spread, ty: this.rd.plate, life: B.tele });
      this.clock.setTimeout(() => {
        this.rfx("beam", { x: boss.x, y: boss.y, x2: tgt.x, y2: tgt.y, r: B.spread, ty: this.rd?.plate, life: 0.5 });
        this.raidHurt({ x: tgt.x, y: tgt.y, r: B.spread }, B.power);
      }, B.tele * 1000);
    }
  },

  raid_time(boss, C) {
    const T = C.time || { tele: 1, r: 44, secs: 7, slow: 0.25, move: 0.5 };
    const p = pick([...this.state.players.values()].filter((q) => !q.downed));
    if (!p) return;
    const z = { x: p.x, y: p.y, r: T.r };
    this.rfx("time-zone", { ...z, ty: "psychic", life: T.tele + T.secs });
    this.clock.setTimeout(() => this.rd?.zones.push({ ...z, left: T.secs, slow: T.move }), T.tele * 1000);
  },

  raidSlow(p) {
    return this.rd?.zones.some((z) => dist(p, z) < z.r) ? this.M.pr?.time?.move ?? 0.5 : 1;
  },

  raid_rift(boss, C) {
    const R = C.rift || { tele: 2, r: 18 };
    for (const [, p] of this.state.players) {
      if (p.downed) continue;
      const c = { x: p.x, y: p.y, r: R.r };
      this.rfx("rift", { ...c, ty: "dragon", life: R.tele });
      this.clock.setTimeout(() => this.raidHurt(c, 1.2, "dragon"), R.tele * 1000);
    }
  },

  raid_orbs(boss, C) {
    const O = C.orbs || { secs: 12, r: 16 };
    const n = Math.max(1, Math.min(3, this.state.players.size));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const o = { id: "orb" + Math.random().toString(36).slice(2, 7), x: boss.x + Math.cos(a) * rnd(70, 150), y: boss.y + Math.sin(a) * rnd(55, 110), r: O.r, ty: this.rd.plate, secs: O.secs, left: O.secs, prog: 0 };
      this.rd.orbs.push(o);
      this.rfx("orb-charge", { x: o.x, y: o.y, r: o.r, ty: o.ty, life: 1 });
    }
    this.fx.push({ t: "banner", text: { es: "¡Cargad las tablas!", en: "Charge the plates!" } });
  },

  raid_judgment(boss, C) {
    const J = C.judgment || { tele: 1.5, bands: [90, 185, 330], order: [2, 0, 1, 2], step: 0.85, power: 1.2 };
    this.rfx("judgment-charge", { x: boss.x, y: boss.y, ty: this.rd.plate, life: J.tele });
    J.order.forEach((bi, k) => {
      const outer = J.bands[bi];
      const inner = bi > 0 ? J.bands[bi - 1] : 0;
      const at = (J.tele + k * J.step) * 1000;
      this.clock.setTimeout(() => {
        this.rfx("band", { x: boss.x, y: boss.y, r: inner, x2: outer, w: J.step, ty: this.rd?.plate, life: J.step + 0.3 });
        for (const [id, p] of this.state.players) {
          const d = dist(p, boss);
          if (!p.downed && !(p.dodgeT > 0) && d >= inner && d <= outer) this.hurtPlayer(id, p, 34 * J.power, this.rd?.plate || "normal", null);
        }
      }, at);
    });
  },

  raid_arms(boss, C) {
    const A = C.arms || { tele: 3.5, safe: 36, power: 2 };
    // Hay que pegarse a Arceus: fuera del círculo seguro, golpe fuerte
    this.rfx("safe", { x: boss.x, y: boss.y, r: A.safe, life: A.tele });
    this.clock.setTimeout(() => {
      this.rfx("stomp", { x: boss.x, y: boss.y, r: 400, life: 0.8 });
      for (const [id, p] of this.state.players) if (!p.downed && dist(p, boss) > A.safe && !(p.dodgeT > 0)) this.hurtPlayer(id, p, 34 * A.power, "normal", null);
    }, A.tele * 1000);
  },

  raid_dark(boss, C) {
    const D = C.dark || { tele: 2, secs: 5, power: 0.35 };
    this.rfx("floor-danger", { x: boss.x, y: boss.y, r: 400, ty: "dark", life: D.tele });
    let n = 0;
    const tick = () => {
      if (!this.rd || n++ > D.secs) return;
      this.raidHurt({ x: boss.x, y: boss.y }, D.power, "dark");
      this.clock.setTimeout(tick, 1000);
    };
    this.clock.setTimeout(tick, D.tele * 1000);
  },

  /** Arceus vencido: final de la raid; quien llevaba la Flauta tira para que se una. */
  raidWin(boss) {
    const r = this.rd;
    r.over = true;
    const caught = [];
    for (const [id] of this.state.players) {
      const pm = this.meta.get(id);
      if (!pm?.raidFlute || pm.raidHasArceus) continue;
      if (Math.random() < this.M.ws((pm.raidWins || 0) + 1)) caught.push(id);
    }
    this.raidWon = true;
    this.raidCaught = caught;
    this.fx.push({ t: "raid-end", id: this.bossId, x: boss.x, y: boss.y, plates: r.plates, caught });
    this.clock.setTimeout(() => this.endRun(true), (this.M.vr ?? 9.5) * 1000);
  },
};
