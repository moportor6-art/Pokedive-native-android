// Servidor de pruebas en PC: sirve web/ como lo haría el APK.
// Uso: node tools/dev-server.mjs [puerto] [carpeta_web] [más carpetas...]
// Si un archivo falta en web/ y se pasa carpeta_extra, se busca ahí (útil mientras se baja el juego).
// Las rutas que no existen se anotan en la consola: así se ve qué recursos faltan.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] || 8080);
const roots = (process.argv.length > 3 ? process.argv.slice(3) : ["web"]).map((p) => path.resolve(p));
const MIME = {
  html: "text/html; charset=utf-8", js: "application/javascript", mjs: "application/javascript", css: "text/css",
  json: "application/json", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", mp3: "audio/mpeg",
  woff2: "font/woff2", webmanifest: "application/manifest+json", ico: "image/x-icon", txt: "text/plain",
};

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  if (p.includes("..")) { res.writeHead(400).end(); return; }
  for (const root of roots) {
    const f = path.join(root, p);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = f.slice(f.lastIndexOf(".") + 1);
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
      fs.createReadStream(f).pipe(res);
      return;
    }
  }
  console.log("FALTA", req.method, p);
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}).listen(port, () => console.log(`http://pd.local:${port}/`));
