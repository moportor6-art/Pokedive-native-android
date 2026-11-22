// Red falsa: el juego cree que habla con pokedive.com, pero todo se queda en el teléfono.
// - fetch a /api/... → api.js
// - fetch a .../game/matchmake/... → el matchmaker de Colyseus que corre aquí
// - new WebSocket(".../game/<proceso>/<sala>?sessionId=...") → un socket en memoria conectado a la sala
// Las salas por wifi usan el mismo camino: el anfitrión recibe por el puente de Android los mensajes de los demás.
import { EventEmitter } from "events";
import { getServer } from "./server.js";
import { rememberPlayers, handleApi, lanUserOf, grantRun, userByToken } from "./api.js";
import { lanRooms, remoteMatchmake, LanSocket, watchRoomData } from "./lan.js";

const realFetch = window.fetch.bind(window);
const lanSessions = new Map(); // sessionId (en sala de otro teléfono) → cuenta local
const RealWS = window.WebSocket;

const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** ¿Es una URL del servidor del juego? (http(s) o ws(s), /game/...) */
function gamePath(u) {
  const i = u.pathname.indexOf("/game");
  if (i < 0) return null;
  const rest = u.pathname.slice(i + 5);
  if (rest === "" || rest.startsWith("/")) return rest || "/";
  return null;
}

export function installNet() {
  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const u = new URL(url, location.href);
    const local = u.origin === location.origin || /(^|\.)pokedive\.com$/.test(u.hostname);
    if (local && u.pathname.startsWith("/api/")) {
      try {
        const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
        let body;
        const raw = init.body ?? (input instanceof Request ? await input.text() : undefined);
        if (typeof raw === "string" && raw) {
          try { body = JSON.parse(raw); } catch { body = raw; }
        }
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
        const r = await handleApi(method, u.pathname.slice(4), u.searchParams, body, headers);
        return json(r.status ?? 200, r.body);
      } catch (e) {
        console.error("[offline api]", u.pathname, e);
        return json(500, { message: String(e && e.message || e) });
      }
    }
    const gp = local ? gamePath(u) : null;
    if (gp !== null) {
      const m = gp.match(/^\/matchmake\/(\w+)\/(.+)$/);
      if (m) {
        const raw = init.body ?? (input instanceof Request ? await input.text() : "{}");
        let opts = {};
        try { opts = JSON.parse(raw || "{}"); } catch {}
        const lan = lanRooms.get(decodeURIComponent(m[2]));
        try {
          if (lan) {
            // Sala de otro teléfono de la wifi: el emparejamiento lo hace su anfitrión.
            const lanUser = lanUserOf(opts.token, opts.pokemon);
            const res = await remoteMatchmake(lan, m[1], decodeURIComponent(m[2]), { ...opts, token: undefined, lanUser });
            if (res?.sessionId) lanSessions.set(res.sessionId, { token: opts.token, resident: opts.pokemon });
            return json(200, res);
          }
          const srv = await getServer();
          return json(200, await srv.matchmake(m[1], m[2], opts));
        } catch (e) {
          return json(e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { code: e.code, error: e.message });
        }
      }
      return json(200, {});
    }
    // Sentry, captcha, fuentes de Google… sin internet: fuera.
    if (!local && u.protocol.startsWith("http")) return json(503, {});
    return realFetch(input, init);
  };

  function PatchedWS(url, protocols) {
    const u = new URL(String(url), location.href);
    const local = u.host === location.host || /(^|\.)pokedive\.com$/.test(u.hostname) || u.hostname === "localhost";
    const gp = local ? gamePath(u) : null;
    if (gp !== null) {
      const roomId = (gp.match(/\/[a-zA-Z0-9_\-]+\/([a-zA-Z0-9_\-]+)$/) || [])[1];
      const lan = roomId && lanRooms.get(roomId);
      if (lan) {
        const sid = u.searchParams.get("sessionId");
        const who = lanSessions.get(sid);
        // Al terminar, el botín de este jugador se guarda en ESTE teléfono.
        const onData = watchRoomData(sid, (fx) => {
          const usr = who && userByToken(who.token);
          if (usr && !who.granted) {
            who.granted = true;
            grantRun(usr, { ...fx, residentId: who.resident });
            // Clasificación local: apunta a los compañeros de esta partida por wifi
            if (Array.isArray(fx.party)) rememberPlayers(fx.party);
          }
        });
        return new LanSocket(u, lan, onData);
      }
      return new LocalSocket(u, gp);
    }
    return new RealWS(url, protocols);
  }
  PatchedWS.prototype = RealWS.prototype;
  Object.assign(PatchedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = PatchedWS;

  // El service worker del juego guardaría copias viejas: en el APK no hace falta.
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => new Promise(() => {});
      navigator.serviceWorker.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()));
    }
  } catch {}
}

/**
 * Socket del lado del juego, con la misma cara que un WebSocket del navegador.
 * Por dentro, un "peer" (lado servidor) que el transporte de Colyseus usa como si fuera un socket de `ws`.
 */
export class LocalSocket extends EventTarget {
  constructor(u, path) {
    super();
    this.url = u.href;
    this.readyState = 0;
    this.binaryType = "blob";
    this.protocol = "";
    this.extensions = "";
    this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.peer = new ServerPeer(this);
    queueMicrotask(async () => {
      try {
        const srv = await getServer();
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this._emit(new Event("open"));
        srv.connect(this.peer, path + u.search);
      } catch (e) {
        console.error("[offline ws]", e);
        this._close(1011, "server error");
      }
    });
  }
  _emit(ev) {
    this.dispatchEvent(ev);
    const h = this["on" + ev.type];
    if (typeof h === "function") h.call(this, ev);
  }
  send(data) {
    if (this.readyState !== 1) return;
    let bytes;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data.slice(0));
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    else bytes = new TextEncoder().encode(String(data));
    queueMicrotask(() => this.peer.emit("message", bytes));
  }
  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    queueMicrotask(() => {
      this.peer._closed(code, reason);
      this._close(code, reason);
    });
  }
  _deliver(bytes) {
    if (this.readyState !== 1) return;
    const data = this.binaryType === "arraybuffer" ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new Blob([bytes]);
    this._emit(new MessageEvent("message", { data }));
  }
  _close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const ev = new CloseEvent("close", { code, reason, wasClean: true });
    this._emit(ev);
  }
}

/** Lado servidor de un LocalSocket (imita a un socket de la librería `ws`). */
export class ServerPeer extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.readyState = 1;
  }
  send(data, _opts, cb) {
    if (this.readyState !== 1) return cb && cb();
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
    queueMicrotask(() => {
      this.sock._deliver(bytes);
      cb && cb();
    });
  }
  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    queueMicrotask(() => {
      this.sock._close(code, reason);
      this.emit("close", code, reason);
    });
  }
  terminate() { this.close(1006, ""); }
  ping() {}
  _closed(code, reason) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close", code, reason);
  }
}
