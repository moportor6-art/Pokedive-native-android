// Solo para pruebas en el PC (?lansim=PUERTO): imita window.PdAndroid del APK contra tools/lan-sim.mjs.
(function () {
  "use strict";
  const port = new URLSearchParams(location.search).get("lansim");
  if (!port || window.PdAndroid) return;
  const NativeWS = window.WebSocket;
  const nativeFetch = window.fetch.bind(window);
  const base = `127.0.0.1:${port}`;
  const inst = Math.random().toString(36).slice(2, 10);
  const enc = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const dec = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

  let rooms = [];
  setInterval(() => nativeFetch(`http://${base}/rooms?inst=${inst}`).then((r) => r.json()).then((l) => (rooms = Array.isArray(l) ? l : [])).catch(() => {}), 800);

  let ctl = null;
  const ctlQueue = [];
  function ctlSend(o) {
    if (!ctl) {
      ctl = new NativeWS(`ws://${base}/ctl?inst=${inst}`);
      ctl.onopen = () => { while (ctlQueue.length) ctl.send(ctlQueue.shift()); };
      ctl.onmessage = (ev) => { const m = JSON.parse(ev.data); window.__pdLanHost && window.__pdLanHost(m.kind, m.id, m.data); };
    }
    const s = JSON.stringify(o);
    ctl.readyState === 1 ? ctl.send(s) : ctlQueue.push(s);
  }

  const conns = new Map();
  let seq = 0;
  window.PdAndroid = {
    lanHost: (json) => ctlSend({ op: "host", info: json }),
    lanHostSend: (id, b64) => ctlSend({ op: "send", id, b64 }),
    lanHostText: (id, text) => ctlSend({ op: "text", id, text }),
    lanHostClose: (id, code) => ctlSend({ op: "close", id, code }),
    lanRooms: () => JSON.stringify(rooms),
    lanInfo: () => JSON.stringify({ ips: ["127.0.0.1"], port: Number(port) }),
    lanConnect(url) {
      const id = "c" + ++seq;
      const u = new URL(url);
      u.searchParams.set("_host", (rooms.find((r) => String(r.port) === u.port) || {}).inst || "");
      const ws = new NativeWS(u.href);
      ws.binaryType = "arraybuffer";
      conns.set(id, ws);
      const ev = (k, d) => window.__pdLanClient && window.__pdLanClient(k, id, d);
      ws.onopen = () => ev("open", null);
      ws.onmessage = (e) => (typeof e.data === "string" ? ev("text", e.data) : ev("msg", enc(new Uint8Array(e.data))));
      ws.onclose = (e) => { if (conns.delete(id)) ev("close", String(e.code)); };
      return id;
    },
    lanSend: (id, b64) => conns.get(id)?.readyState === 1 && conns.get(id).send(dec(b64)),
    lanText: (id, text) => conns.get(id)?.readyState === 1 && conns.get(id).send(text),
    lanClose(id) { const ws = conns.get(id); conns.delete(id); ws && ws.close(); },
  };
})();
