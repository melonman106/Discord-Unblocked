import { BareMuxConnection } from "/baremux/index.mjs";

const PREFIX = "/service/";
const input = document.getElementById("url");
const form = document.getElementById("go");
const frame = document.getElementById("frame");
const start = document.getElementById("start");
const state = document.getElementById("state");
const stateText = document.getElementById("state-text");

function setState(name, text) {
  state.dataset.state = name;
  stateText.textContent = text;
}

async function boot() {
  setState("starting", "Starting");

  // bare-mux keeps one SharedWorker on this page. The Ultraviolet service
  // worker borrows a port from it, which is why this tab needs to stay open.
  const connection = new BareMuxConnection("/baremux/worker.js");
  await connection.setTransport("/baremod/index.mjs", [new URL("/bare/", location.origin).href]);

  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await whenActive(registration);
  await whenControlled();

  setState("ready", "Ready");
}

function whenActive(registration) {
  if (registration.active) return Promise.resolve();
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return Promise.resolve();
  return new Promise((resolve) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
    });
  });
}

/** This page must be controlled before the service worker can borrow the transport. */
function whenControlled() {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
  });
}

function encode(url) {
  return Ultraviolet.codec.xor.encode(url);
}

function decode(value) {
  return Ultraviolet.codec.xor.decode(value);
}

function proxied(url) {
  return PREFIX + encode(url);
}

/** Turn what the user typed into an absolute URL (or a web search). */
function resolveInput(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(?:[/:?#].*)?$/.test(value)) return `https://${value}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

/** Nothing may be proxied before the worker is registered and active. */
let bootPromise = Promise.resolve();

function show(url) {
  start.hidden = true;
  frame.hidden = false;
  input.value = url;
  frame.src = proxied(url);
}

function visit(url) {
  if (!url) return;
  bootPromise.then(() => show(url)).catch(() => show(url));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  visit(resolveInput(input.value));
});

input.addEventListener("focus", () => input.select());

document.getElementById("discord").addEventListener("click", () => {
  visit("https://discord.com/app");
});

for (const chip of document.querySelectorAll("[data-url]")) {
  chip.addEventListener("click", () => visit(chip.dataset.url));
}

document.getElementById("home").addEventListener("click", () => {
  frame.hidden = true;
  start.hidden = false;
  frame.src = "about:blank";
  input.value = "";
  document.title = "Discord Unblocked";
});

document.getElementById("back").addEventListener("click", () => {
  try {
    frame.contentWindow.history.back();
  } catch {
    // nothing to go back to
  }
});

document.getElementById("reload").addEventListener("click", () => {
  try {
    frame.contentWindow.location.reload();
  } catch {
    // frame not showing anything yet
  }
});

// The proxied page lives on this origin, so the address bar can follow it.
frame.addEventListener("load", () => {
  try {
    const { pathname } = frame.contentWindow.location;
    if (!pathname.startsWith(PREFIX)) return;
    const current = decode(pathname.slice(PREFIX.length));
    input.value = current;
    document.title = current.replace(/^https?:\/\//, "");
  } catch {
    // cross-origin or nothing loaded
  }
});

bootPromise = boot().catch((error) => {
  console.error(error);
  setState("error", "Proxy unavailable");
});
