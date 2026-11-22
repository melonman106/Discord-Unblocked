// Copies the proxy runtime out of node_modules into ./public so Cloudflare
// serves it as static assets. Run with `npm run build` (also runs before dev
// and deploy). Output is committed, so a deploy works without a build step.

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pub = join(root, "public");

const files = [
  // Ultraviolet runtime + rewriter
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.bundle.js", "uv/uv.bundle.js"],
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.sw.js", "uv/uv.sw.js"],
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.handler.js", "uv/uv.handler.js"],
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.client.js", "uv/uv.client.js"],
  // bare-mux: page <-> service worker transport plumbing
  ["@mercuryworkshop/bare-mux/dist/index.mjs", "baremux/index.mjs"],
  ["@mercuryworkshop/bare-mux/dist/worker.js", "baremux/worker.js"],
  // Bare v3 transport: talks to this Worker's /bare/v3/ endpoint
  ["@mercuryworkshop/bare-as-module3/dist/index.mjs", "baremod/index.mjs"],
];

const config = `/*global Ultraviolet*/
self.__uv$config = {
  prefix: "/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/uv.handler.js",
  client: "/uv/uv.client.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv/uv.config.js",
  sw: "/uv/uv.sw.js",
};
`;

// Served from the root so its scope is "/": bare-mux hands its transport port
// from the shell page to the service worker over navigator.serviceWorker
// messages, which only reach pages the worker controls.
const serviceWorker = `/* Ultraviolet service worker (scope: /). */
importScripts("/uv/uv.bundle.js", "/uv/uv.config.js", "/uv/uv.sw.js");

const uv = new UVServiceWorker();

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (uv.route(event)) event.respondWith(uv.fetch(event));
});
`;

for (const [from, to] of files) {
  const source = join(root, "node_modules", from);
  const destination = join(pub, to);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  console.log(`copied ${to}`);
}

await mkdir(join(pub, "uv"), { recursive: true });
await writeFile(join(pub, "uv/uv.config.js"), config);
console.log("wrote uv/uv.config.js");

await rm(join(pub, "service"), { recursive: true, force: true });
await writeFile(join(pub, "sw.js"), serviceWorker);
console.log("wrote sw.js");

await rm(join(pub, ".DS_Store"), { force: true });
