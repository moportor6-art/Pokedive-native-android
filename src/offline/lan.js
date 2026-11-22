// Salas por wifi (solo en el APK; en el navegador del PC no hay puente nativo).
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
  constructor(id) {
    super();
    this.id = id;
    this.readyState = 1;
  }
  send(data, _o, cb) {
    if (this.readyState !== 1) return cb && cb();
    A().lanHostSend(this.id, b64.enc(data instanceof Uint8Array ? data : new Uint8Array(data)));
    cb && cb();
  }
  close(code = 1000) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    A().lanHostClose(this.id, code);
    this.emit("close", code, "");
  }
  terminate() { this.close(1006); }
  ping() {}
}

const hostConns = new Map(); // id → RemotePeer | "mm"

/** Eventos del relay del anfitrión (los llama Android). */
window.__pdLanHost = async (kind, id, data) => {
  try {
    if (kind === "open") {
      const path = String(data || "/");
      if (path.startsWith("/mm")) {
        hostConns.set(id, "mm");
        return;
      }
      const gi = path.indexOf("/game");
      const rest = gi >= 0 ? path.slice(gi + 5) : path;
      const peer = new RemotePeer(id);
      hostConns.set(id, peer);
      const srv = await getServer();
      srv.connect(peer, rest);
    } else if (kind === "msg") {
      const c = hostConns.get(id);
      if (c && c !== "mm") c.emit("message", b64.dec(data));
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
      A().lanHostText(id, JSON.stringify(reply));
    } else if (kind === "close") {
      const c = hostConns.get(id);
      hostConns.delete(id);
      if (c && c !== "mm" && c.readyState === 1) {
        c.readyState = 3;
        c.emit("close", 1000, "");
      }
    }
  } catch (e) {
    console.error("[lan host]", kind, e);
  }
};

/** La sala del anfitrión cambia: se anuncia (o se deja de anunciar) en la wifi. */
export function announce(info) {
  if (!lanAvailable()) return;
  try {
    A().lanHost(info ? JSON.stringify(info) : "");
  } catch (e) {
    console.warn("[lan] anuncio", e);
  }
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

function connectNative(url, handlers) {
  const id = A().lanConnect(url);
  clientHandlers.set(id, handlers);
  return id;
}

/** Emparejamiento (joinById, reconnect…) contra el anfitrión de la wifi. */
export function remoteMatchmake(room, method, roomId, opts) {
  return new Promise((resolve, reject) => {
    const q = Math.random().toString(36).slice(2);
    let id;
    const t = setTimeout(() => {
      try { A().lanClose(id); } catch {}
      reject(Object.assign(new Error("El anfitrión no contesta"), { code: 504 }));
    }, 8000);
    id = connectNative(`ws://${room.ip}:${room.port}/mm`, {
      open: () => A().lanText(id, JSON.stringify({ q, method, room: roomId, opts })),
      text: (txt) => {
        const r = JSON.parse(txt);
        if (r.q !== q) return;
        clearTimeout(t);
        try { A().lanClose(id); } catch {}
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
    const target = `ws://${room.ip}:${room.port}/game${u.pathname.slice(u.pathname.indexOf("/game") + 5)}${u.search}`;
    this.id = connectNative(target, {
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
    A().lanSend(this.id, b64.enc(u8));
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    try { A().lanClose(this.id); } catch {}
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
