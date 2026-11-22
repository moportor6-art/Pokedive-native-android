// Simulador del puente wifi de Android para probar las salas en el PC (dos pestañas o dos navegadores).
// Hace lo mismo que LanManager.java + RelayServer.java: lista de salas, relay del anfitrión y conexiones de invitados.
// Uso: node tools/lan-sim.mjs [puerto=8790]   y abrir el juego con ?lansim=8790
import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] || 8790);
const hosts = new Map(); // inst → { ws, info }
const guests = new Map(); // id → { ws, inst }
let seq = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", "*");
  if (u.pathname === "/rooms") {
    const me = u.searchParams.get("inst");
    const list = [];
    for (const [inst, h] of hosts) {
      if (inst === me || !h.info) continue;
      try { list.push({ ...JSON.parse(h.info), ip: "127.0.0.1", port, inst }); } catch {}
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(list));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ctl") {
    const inst = u.searchParams.get("inst");
    hosts.set(inst, { ws, info: "" });
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      const h = hosts.get(inst);
      if (m.op === "host") h.info = m.info;
      else if (m.op === "send") guests.get(m.id)?.ws.send(Buffer.from(m.b64, "base64"));
      else if (m.op === "text") guests.get(m.id)?.ws.send(m.text);
      else if (m.op === "close") guests.get(m.id)?.ws.close(m.code >= 1000 && m.code < 5000 && ![1004, 1005, 1006, 1015].includes(m.code) ? m.code : 1000);
    });
    ws.on("close", () => hosts.delete(inst));
    return;
  }
  // Conexión de un invitado: va al anfitrión indicado (o al único que haya).
  const inst = u.searchParams.get("_host") || [...hosts.keys()].find((k) => hosts.get(k).info) || [...hosts.keys()][0];
  const h = hosts.get(inst);
  if (!h) return ws.close(1011, "sin anfitrión");
  const id = "h" + ++seq;
  guests.set(id, { ws, inst });
  h.ws.send(JSON.stringify({ kind: "open", id, data: req.url }));
  ws.on("message", (raw, isBinary) => {
    const hh = hosts.get(inst);
    if (!hh) return;
    hh.ws.send(JSON.stringify(isBinary ? { kind: "msg", id, data: Buffer.from(raw).toString("base64") } : { kind: "text", id, data: String(raw) }));
  });
  ws.on("close", () => {
    guests.delete(id);
    hosts.get(inst)?.ws.send(JSON.stringify({ kind: "close", id, data: null }));
  });
});

server.listen(port, () => console.log(`simulador wifi en ws://127.0.0.1:${port}`));
