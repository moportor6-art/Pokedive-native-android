import { Buffer as B } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = B;
export const Buffer = globalThis.Buffer;
export const process = globalThis.process || {
  env: { NODE_ENV: "production" }, pid: 1, platform: "browser", versions: {}, argv: [],
  on() {}, once() {}, off() {}, removeListener() {}, exit() {},
  nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
  hrtime: Object.assign((p) => { const t = performance.now(); const s = Math.floor(t / 1000), n = Math.round((t % 1000) * 1e6); return p ? [s - p[0], n - p[1]] : [s, n]; }, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ heapUsed: 0, rss: 0 }), cpuUsage: () => ({ user: 0, system: 0 }), uptime: () => performance.now() / 1000,
};
