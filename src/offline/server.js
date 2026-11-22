// El "servidor" del juego dentro del teléfono: Colyseus (matchmaker + salas) sin red.
import * as matchMaker from "@colyseus/core/MatchMaker";
import { connectClientToRoom, createAuthContext, ClientState, enqueueClientRaw, setTransport, Transport } from "@colyseus/core/Transport";
import { getMessageBytes } from "@colyseus/core/Protocol";
import { LocalPresence } from "@colyseus/core/presence/LocalPresence";
import { LocalDriver } from "@colyseus/core/matchmaker/LocalDriver/LocalDriver";
import { Protocol, CloseCode } from "@colyseus/shared-types";
import { loadShared } from "./shared.js";

/** Cliente del lado servidor (igual que WebSocketClient de @colyseus/ws-transport). */
class LocalClient {
  constructor(id, ref) {
    this.state = ClientState.JOINING;
    this._enqueuedMessages = [];
    this._numMessagesLastSecond = 0;
    this._messageCountResetsAt = 0;
    this._lastMessageTime = 0;
    this.sessionId = this.id = id;
    this.ref = ref;
  }
  sendBytes(type, bytes, options) {
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA_BYTES, type, undefined, bytes), options);
  }
  send(type, message, options) {
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA, type, message), options);
  }
  enqueueRaw(data, options) { enqueueClientRaw(this, data, options); }
  raw(data, _options, cb) { this.ref.send(data, undefined, cb); }
  cork() {}
  uncork() {}
  error(code, message = "", cb) { this.raw(getMessageBytes[Protocol.ERROR](code, message), undefined, cb); }
  get readyState() { return this.ref.readyState; }
  leave(code, data) { this.ref.close(code, data); }
  close(code, data) { this.leave(code, data); }
  toJSON() { return { sessionId: this.sessionId, readyState: this.readyState }; }
}

class LocalTransport extends Transport {
  listen() { return this; }
  shutdown() {}
  simulateLatency() {}
}

let serverPromise;
export function getServer() {
  return (serverPromise ??= start());
}

async function start() {
  const shared = await loadShared();
  const { ExpeditionRoom } = await import("./expedition.js");
  setTransport(new LocalTransport());
  await matchMaker.setup(new LocalPresence(), new LocalDriver());
  await matchMaker.accept(true);
  matchMaker.defineRoomType("expedition", ExpeditionRoom);
  matchMaker.defineRoomType("clan-plaza", ExpeditionRoom);
  ExpeditionRoom.shared = shared;
  return {
    async matchmake(method, roomName, options) {
      const res = await matchMaker.controller.invokeMethod(method, roomName, options, createAuthContext({ headers: new Headers() }));
      return res;
    },
    async connect(peer, pathAndQuery) {
      const u = new URL("ws://server" + pathAndQuery);
      const sessionId = u.searchParams.get("sessionId");
      const m = u.pathname.match(/\/[a-zA-Z0-9_\-]+\/([a-zA-Z0-9_\-]+)$/);
      const roomId = m && m[1];
      if (!sessionId && !roomId) {
        peer.on("message", () => peer.send(new Uint8Array([Protocol.PING])));
        setTimeout(() => peer.close(CloseCode.NORMAL_CLOSURE), 1000);
        return;
      }
      const room = matchMaker.getLocalRoomById(roomId);
      const client = new LocalClient(sessionId, peer);
      const reconnectionToken = u.searchParams.get("reconnectionToken");
      try {
        await connectClientToRoom(room, client, createAuthContext({ headers: new Headers(), token: u.searchParams.get("_authToken") }), {
          reconnectionToken,
          skipHandshake: u.searchParams.has("skipHandshake"),
        });
      } catch (e) {
        console.warn("[offline] no se pudo entrar en la sala:", e.message);
        client.error(e.code, e.message, () => peer.close(reconnectionToken ? CloseCode.FAILED_TO_RECONNECT : CloseCode.WITH_ERROR));
      }
    },
  };
}
