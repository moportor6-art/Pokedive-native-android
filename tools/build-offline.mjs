// Compila src/offline/ (servidor local + API) en web/offline/boot.js, que index.html carga antes que el juego.
import * as esbuild from "esbuild";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const shim = path.join(root, "tools/shims/node.js");

// Colyseus está hecho para Node: lo que pide de Node se sustituye por piezas vacías.
const nodeShim = {
  name: "node-shim",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const id = a.path.replace(/^node:/, "");
      const base = id.split("/")[0];
      if (base === "events") return { path: require.resolve("events/events.js") };
      if (base === "buffer") return { path: require.resolve("buffer/index.js") };
      if (builtinModules.includes(base) || a.path.startsWith("node:")) return { path: shim };
      if (["ws", "express", "@colyseus/redis-presence", "@colyseus/redis-driver"].includes(a.path)) return { path: shim };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(root, "src/offline/index.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: path.join(root, "web/offline/boot.js"),
  plugins: [nodeShim],
  external: ["/assets/*"],
  define: { "process.env.NODE_ENV": '"production"' },
  inject: [path.join(root, "tools/shims/process.js")],
  minify: process.argv.includes("--min"),
  legalComments: "none",
  logLevel: "warning",
});
console.log("web/offline/boot.js listo");
