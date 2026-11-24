// Salas por wifi (solo en el APK; en el navegador del PC no hay puente nativo) y por internet con el código del grupo.
//
// Internet: el anfitrión también abre un punto de PeerJS con el código de 4 letras de su grupo (el mismo de la
// wifi); el invitado que escribe ese código y no lo encuentra en la wifi lo busca por internet. Cada conexión
// (emparejamiento o socket de la sala) es un canal de PeerJS con su ruta en los metadatos; el anfitrión las atiende
// igual que las del relay de Android. Funciona también en el PC (Port Launcher), sin puente nativo.
//
// Anfitrión: su propio servidor local (server.js) recibe, a través del relay de Android, las conexiones de
// los demás teléfonos. Anuncia la sala en la wifi (UDP) mientras está en el vestíbulo.
// Invitado: "Buscar grupo" enseña las salas anunciadas; al unirse, el emparejamiento y el socket de la sala
// van por el puente nativo hasta el anfitrión.
import { EventEmitter } from "events";
import { unpack } from "msgpackr";
import { getServer } from "./server.js";

const A = () => window.PdAndroid;
export const lanAvailable = () => !!(A() && A().lanRooms);

const b64 = {
  enc(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};

// ------------------------------------------------------------------ anfitrión

class RemotePeer extends EventEmitter {
  constructor(id, tx) {
    super();
    this.id = id;
    this.tx = tx;
    this.readyState = 1;
  }
  send(data, _o, cb) {
    if (this.readyState !== 1) return cb && cb();
    this.tx.send(data instanceof Uint8Array ? data : new Uint8Array(data));
    cb && cb();
  }
  close(code = 1000) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.tx.close(code);
    this.emit("close", code, "");
  }
  terminate() { this.close(1006); }
  ping() {}
}

const hostConns = new Map(); // id → RemotePeer | "mm"
const nativeTx = (id) => ({
  send: (u8) => A().lanHostSend(id, b64.enc(u8)),
  text: (t) => A().lanHostText(id, t),
  close: (code) => A().lanHostClose(id, code),
});

/** Eventos del relay del anfitrión (los llama Android): los datos binarios llegan en base64. */
window.__pdLanHost = (kind, id, data) => hostEvent(kind, id, kind === "msg" ? b64.dec(data) : data, nativeTx(id));

/** Una conexión de un invitado (wifi o internet): open (con la ruta) → msg (bytes) / text → close. */
async function hostEvent(kind, id, data, tx) {
  try {
    if (kind === "open") {
      const path = String(data || "/");
      if (path.startsWith("/mm")) {
        hostConns.set(id, "mm");
        hostTx.set(id, tx);
        return;
      }
      const gi = path.indexOf("/game");
      const rest = gi >= 0 ? path.slice(gi + 5) : path;
      const peer = new RemotePeer(id, tx);
      hostConns.set(id, peer);
      const srv = await getServer();
      srv.connect(peer, rest);
    } else if (kind === "msg") {
      const c = hostConns.get(id);
      if (c && c !== "mm") c.emit("message", data);
    } else if (kind === "text") {
      const c = hostConns.get(id);
      if (c !== "mm") return;
      const q = JSON.parse(data);
      const srv = await getServer();
      let reply;
      try {
        reply = { q: q.q, ok: true, res: await srv.matchmake(q.method, q.room, q.opts || {}) };
      } catch (e) {
        reply = { q: q.q, ok: false, code: e.code || 500, error: String(e.message || e) };
      }
      (hostTx.get(id) || tx).text(JSON.stringify(reply));
    } else if (kind === "close") {
      const c = hostConns.get(id);
      hostConns.delete(id);
      hostTx.delete(id);
      if (c && c !== "mm" && c.readyState === 1) {
        c.readyState = 3;
        c.emit("close", 1000, "");
      }
    }
  } catch (e) {
    console.error("[lan host]", kind, e);
  }
}
const hostTx = new Map(); // id → tx de las conexiones de emparejamiento

/** La sala del anfitrión cambia: se anuncia (o se deja de anunciar) en la wifi y por internet. */
export function announce(info) {
  internetHost(info);
  if (!lanAvailable()) return;
  try {
    A().lanHost(info ? JSON.stringify(info) : "");
  } catch (e) {
    console.warn("[lan] anuncio", e);
  }
}

// ------------------------------------------------------------------ internet (PeerJS)

const PREFIX = "pokedive-sala-v1-";
const peerOk = () => typeof window.Peer === "function";
const peerOpts = () => ({
  debug: 0,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" },
    ],
  },
});
const toU8 = (d) => (d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null);
let hostPeer = null;
let hostInfo = null;
let hostSeq = 0;

function internetHost(info) {
  hostInfo = info;
  if (!peerOk()) return;
  const code = info && String(info.code || "").toUpperCase();
  if (hostPeer && (!code || hostPeer.__code !== code)) {
    try { hostPeer.destroy(); } catch {}
    hostPeer = null;
  }
  if (!code || hostPeer) return;
  const p = (hostPeer = new window.Peer(PREFIX + code, peerOpts()));
  p.__code = code;
  p.on("error", (e) => console.warn("[sala internet]", e && e.type));
  p.on("disconnected", () => { try { if (hostPeer === p && !p.destroyed) p.reconnect(); } catch {} });
  p.on("connection", (cx) => {
    const path = String((cx.metadata && cx.metadata.path) || "/");
    if (path === "/info") {   // el invitado pregunta qué sala es antes de unirse
      cx.on("open", () => { cx.send({ t: "info", info: hostInfo }); setTimeout(() => cx.close(), 1500); });
      return;
    }
    const id = "i" + ++hostSeq;
    const tx = {
      send: (u8) => { if (cx.open) cx.send(u8); },
      text: (t) => { if (cx.open) cx.send({ t: "text", d: t }); },
      close: () => { try { cx.close(); } catch {} },
    };
    cx.on("open", () => hostEvent("open", id, path, tx));
    cx.on("data", (d) => {
      if (d && d.t === "text") return hostEvent("text", id, String(d.d), tx);
      const u8 = toU8(d);
      if (u8) hostEvent("msg", id, u8, tx);
    });
    cx.on("close", () => hostEvent("close", id, null, tx));
  });
}

let guestPeer = null;
function guest() {
  if (guestPeer && !guestPeer.destroyed) return Promise.resolve(guestPeer);
  return new Promise((ok, bad) => {
    // con id propio: sin él PeerJS lo pide por fetch, y aquí las peticiones de fuera están cortadas
    const p = new window.Peer(PREFIX + "c-" + Math.random().toString(36).slice(2, 12), peerOpts());
    const t = setTimeout(() => bad(Object.assign(new Error("Sin conexión a internet"), { code: 503 })), 12000);
    p.on("open", () => { clearTimeout(t); guestPeer = p; ok(p); });
    p.on("error", (e) => { if (!guestPeer) { clearTimeout(t); bad(Object.assign(new Error("Sin conexión a internet"), { code: 503 })); } });
    p.on("disconnected", () => { try { if (!p.destroyed) p.reconnect(); } catch {} });
  });
}

/** ¿Hay un grupo con ese código en internet? → su info (con roomId) o null. */
export async function findInternetRoom(code) {
  code = String(code || "").trim().toUpperCase();
  if (!peerOk() || !/^[A-Z0-9]{3,8}$/.test(code)) return null;
  const p = await guest();
  return new Promise((ok) => {
    const cx = p.connect(PREFIX + code, { reliable: true, metadata: { path: "/info" } });
    const done = (v) => { clearTimeout(t); p.off("error", onErr); ok(v); };
    const onErr = (e) => { if (e && e.type === "peer-unavailable") done(null); };
    const t = setTimeout(() => done(null), 10000);
    p.on("error", onErr);
    cx.on("data", (d) => {
      if (!d || d.t !== "info" || !d.info || !d.info.roomId) return done(null);
      const room = { ...d.info, peer: code };
      lanRooms.set(room.roomId, room);
      done(room);
    });
  });
}

/** Una conexión del invitado hacia el anfitrión: por el puente de Android (wifi) o por PeerJS (internet). */
function connectRoom(room, path, h) {
  if (!room.peer) {
    const id = A().lanConnect(`ws://${room.ip}:${room.port}${path}`);
    clientHandlers.set(id, h);
    return { send: (u8) => A().lanSend(id, b64.enc(u8)), text: (t) => A().lanText(id, t), close: () => A().lanClose(id) };
  }
  let cx = null, closed = false;
  const fin = (code, why) => { if (closed) return; closed = true; h.close?.(code, why || ""); };
  guest().then((p) => {
    if (closed) return;
    cx = p.connect(PREFIX + room.peer, { reliable: true, metadata: { path } });
    cx.on("open", () => h.open?.());
    cx.on("data", (d) => {
      if (d && d.t === "text") return h.text?.(String(d.d));
      const u8 = toU8(d);
      if (u8) h.msg?.(u8);
    });
    cx.on("close", () => fin(1000));
    cx.on("error", () => fin(1006));
  }, (e) => fin(1006, e.message));
  return {
    send: (u8) => { if (cx && cx.open) cx.send(u8); },
    text: (t) => { if (cx && cx.open) cx.send({ t: "text", d: t }); },
    // cerrar desde aquí no avisa (como el puente nativo): quien cierra ya sabe que cerró
    close: () => { closed = true; try { cx && cx.close(); } catch {} },
  };
}

// ------------------------------------------------------------------ invitado

/** Salas de la wifi conocidas: roomId → {ip, port, ...}. */
export const lanRooms = new Map();

export function listLanRooms() {
  if (!lanAvailable()) return [];
  let list = [];
  try {
    list = JSON.parse(A().lanRooms() || "[]");
    if (!Array.isArray(list)) list = [];
  } catch {}
  for (const r of list) lanRooms.set(r.roomId, r);
  return list;
}

const clientHandlers = new Map(); // id → {open, msg, text, close}
window.__pdLanClient = (kind, id, data) => {
  const h = clientHandlers.get(id);
  if (!h) return;
  try {
    if (kind === "open") h.open?.();
    else if (kind === "msg") h.msg?.(b64.dec(data));
    else if (kind === "text") h.text?.(data);
    else if (kind === "close" || kind === "error") {
      clientHandlers.delete(id);
      h.close?.(kind === "error" ? 1006 : 1000, String(data || ""));
    }
  } catch (e) {
    console.error("[lan client]", e);
  }
};

/** Emparejamiento (joinById, reconnect…) contra el anfitrión de la wifi. */
export function remoteMatchmake(room, method, roomId, opts) {
  return new Promise((resolve, reject) => {
    const q = Math.random().toString(36).slice(2);
    let c;
    const t = setTimeout(() => {
      try { c.close(); } catch {}
      reject(Object.assign(new Error("El anfitrión no contesta"), { code: 504 }));
    }, room.peer ? 15000 : 8000);
    c = connectRoom(room, "/mm", {
      open: () => c.text(JSON.stringify({ q, method, room: roomId, opts })),
      text: (txt) => {
        const r = JSON.parse(txt);
        if (r.q !== q) return;
        clearTimeout(t);
        try { c.close(); } catch {}
        r.ok ? resolve(r.res) : reject(Object.assign(new Error(r.error), { code: r.code }));
      },
      close: () => {
        clearTimeout(t);
        reject(Object.assign(new Error("Sin conexión con el anfitrión"), { code: 503 }));
      },
    });
  });
}

/** Socket de juego hacia la sala del anfitrión, con la cara de un WebSocket del navegador. */
export class LanSocket extends EventTarget {
  constructor(u, room, onData) {
    super();
    this.url = u.href;
    this.readyState = 0;
    this.binaryType = "blob";
    this.protocol = "";
    this.extensions = "";
    this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.onData = onData;
    const target = `/game${u.pathname.slice(u.pathname.indexOf("/game") + 5)}${u.search}`;
    this.conn = connectRoom(room, target, {
      open: () => {
        this.readyState = 1;
        this._emit(new Event("open"));
      },
      msg: (u8) => {
        if (this.readyState !== 1) return;
        try { this.onData?.(u8); } catch (e) { console.warn(e); }
        const data = this.binaryType === "arraybuffer" ? u8.buffer : new Blob([u8]);
        this._emit(new MessageEvent("message", { data }));
      },
      close: (code, reason) => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this._emit(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
      },
    });
  }
  _emit(ev) {
    this.dispatchEvent(ev);
    const h = this["on" + ev.type];
    if (typeof h === "function") h.call(this, ev);
  }
  send(data) {
    if (this.readyState !== 1) return;
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new TextEncoder().encode(String(data));
    this.conn.send(u8);
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    try { this.conn.close(); } catch {}
    queueMicrotask(() => {
      this.readyState = 3;
      this._emit(new CloseEvent("close", { code: 1000, reason: "", wasClean: true }));
    });
  }
}

/**
 * Lee los mensajes de la sala remota para quedarse con lo que toca guardar aquí (el botín de fin de expedición).
 * Formato Colyseus: [13 ROOM_DATA][tipo (cadena msgpack)][datos msgpack].
 */
export function watchRoomData(sessionId, onEnd) {
  return (u8) => {
    if ((u8[0] & 31) !== 13) return;
    // tipo: cadena msgpack (fixstr 0xa0-0xbf o str8 0xd9)
    let off = 1;
    let len;
    if ((u8[off] & 0xe0) === 0xa0) {
      len = u8[off] & 0x1f;
      off += 1;
    } else if (u8[off] === 0xd9) {
      len = u8[off + 1];
      off += 2;
    } else return;
    const type = new TextDecoder().decode(u8.subarray(off, off + len));
    if (type !== "fxs") return;
    const list = unpack(u8.subarray(off + len));
    if (!Array.isArray(list)) return;
    for (const fx of list) if (fx && fx.t === "end" && fx.to === sessionId) onEnd(fx);
  };
}
