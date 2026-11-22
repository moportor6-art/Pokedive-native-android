const noop = () => {};
const base = {
  resolve: (...a) => a.join("/"), join: (...a) => a.join("/"), dirname: (p) => p, basename: (p) => p,
  hostname: () => "local", cpus: () => [], networkInterfaces: () => ({}),
  randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  randomUUID: () => globalThis.crypto.randomUUID(),
  createHash: () => ({ update() { return this; }, digest() { return ""; } }),
  timingSafeEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  inspect: (x) => { try { return JSON.stringify(x); } catch { return String(x); } },
  promisify: (f) => f, format: (...a) => a.join(" "), debuglog: () => noop,
  existsSync: () => false, readFileSync: () => "", writeFileSync: noop, unlinkSync: noop,
  createServer: () => ({ on: noop, listen: noop, close: noop }), STATUS_CODES: {},
  URL: globalThis.URL, fileURLToPath: (u) => String(u), pathToFileURL: (p) => new URL("file://" + p),
  isMainThread: true, EOL: "\n", sep: "/",
};
export default new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });
export const { resolve, join, dirname, basename, hostname, cpus, networkInterfaces, randomBytes, randomUUID, createHash,
  timingSafeEqual, inspect, promisify, format, debuglog, existsSync, readFileSync, writeFileSync, unlinkSync,
  createServer, STATUS_CODES, URL, fileURLToPath, pathToFileURL, isMainThread, EOL, sep } = base;
