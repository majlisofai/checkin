import { DurableObject } from "cloudflare:workers";

const SID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SID_RE = /^[a-z0-9]{8}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PEOPLE = 2000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE = "checkin_device";

function randomString(length, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const newSid = () => randomString(8, SID_ALPHABET);
const newKey = () => randomString(32, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** One Durable Object per check-in session. Holds the settings and the list of arrivals,
 *  and pushes the new state to every connected screen over WebSockets. */
export class Session extends DurableObject {
  async load() {
    const meta = await this.ctx.storage.get("meta");
    const people = (await this.ctx.storage.get("people")) || [];
    return { meta, people };
  }

  publicState(meta, people) {
    return {
      title: meta.title,
      total: meta.total,
      amberAt: meta.amberAt,
      greenAt: meta.greenAt,
      createdAt: meta.createdAt,
      endedAt: meta.endedAt || null,
      count: people.length,
    };
  }

  hostState(meta, people) {
    return {
      ...this.publicState(meta, people),
      arrivals: people.map((p) => ({ id: p.id, at: p.at, email: p.email || "", walkIn: !!p.walkIn })),
    };
  }

  broadcast(meta, people) {
    const pub = JSON.stringify({ type: "state", state: this.publicState(meta, people) });
    const host = JSON.stringify({ type: "state", state: this.hostState(meta, people) });
    for (const ws of this.ctx.getWebSockets()) {
      const { isHost } = ws.deserializeAttachment() || {};
      try { ws.send(isHost ? host : pub); } catch {}
    }
  }

  async create(settings) {
    if (await this.ctx.storage.get("meta")) return { ok: false };
    const meta = { ...settings, key: newKey(), createdAt: Date.now() };
    await this.ctx.storage.put({ meta, people: [] });
    await this.ctx.storage.setAlarm(Date.now() + SESSION_TTL_MS);
    return { ok: true, key: meta.key };
  }

  isHost(meta, key) {
    return typeof key === "string" && key.length === meta.key.length && key === meta.key;
  }

  async getState({ key, device, cookie }) {
    const { meta, people } = await this.load();
    if (!meta) return null;
    if (key !== undefined && key !== null) {
      if (!this.isHost(meta, key)) return { forbidden: true };
      return { state: this.hostState(meta, people) };
    }
    const you = people.some((p) => (device && p.device === device) || (cookie && p.cookie === cookie));
    return { state: this.publicState(meta, people), you };
  }

  async checkin({ device, cookie, email }) {
    const { meta, people } = await this.load();
    if (!meta) return { status: 404 };
    if (meta.endedAt) return { status: 410 };
    const sameDevice =people.some((p) => (device && p.device === device) || (cookie && p.cookie === cookie));
    if (sameDevice) return { status: 200, already: "device", state: this.publicState(meta, people) };
    if (people.some((p) => p.email === email)) return { status: 200, already: "email", state: this.publicState(meta, people) };
    if (people.length >= MAX_PEOPLE) return { status: 409 };
    people.push({ id: randomString(10, SID_ALPHABET), at: Date.now(), email, device, cookie });
    await this.ctx.storage.put("people", people);
    this.broadcast(meta, people);
    return { status: 200, already: false, state: this.publicState(meta, people) };
  }

  async walkin(key) {
    const { meta, people } = await this.load();
    if (!meta) return { status: 404 };
    if (!this.isHost(meta, key)) return { status: 403 };
    if (meta.endedAt) return { status: 410 };
    if (people.length >= MAX_PEOPLE) return { status: 409 };
    people.push({ id: randomString(10, SID_ALPHABET), at: Date.now(), walkIn: true });
    await this.ctx.storage.put("people", people);
    this.broadcast(meta, people);
    return { status: 200 };
  }

  async undoWalkin(key) {
    const { meta, people } = await this.load();
    if (!meta) return { status: 404 };
    if (!this.isHost(meta, key)) return { status: 403 };
    if (meta.endedAt) return { status: 410 };
    const idx = people.findLastIndex((p) => p.walkIn);
    if (idx === -1) return { status: 200 };
    people.splice(idx, 1);
    await this.ctx.storage.put("people", people);
    this.broadcast(meta, people);
    return { status: 200 };
  }

  async end(key) {
    const { meta, people } = await this.load();
    if (!meta) return { status: 404 };
    if (!this.isHost(meta, key)) return { status: 403 };
    if (!meta.endedAt) {
      meta.endedAt = Date.now();
      await this.ctx.storage.put("meta", meta);
      this.broadcast(meta, people);
    }
    return { status: 200, state: this.publicState(meta, people) };
  }

  async fetch(request) {
    // WebSocket upgrade, forwarded by the Worker
    const { meta, people } = await this.load();
    if (!meta) return new Response("Not found", { status: 404 });
    const key = new URL(request.url).searchParams.get("key");
    const isHost = key !== null && this.isHost(meta, key);
    if (key !== null && !isHost) return new Response("Forbidden", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ isHost });
    server.send(JSON.stringify({ type: "state", state: isHost ? this.hostState(meta, people) : this.publicState(meta, people) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "closing"); } catch {}
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, "Session expired"); } catch {} }
    await this.ctx.storage.deleteAll();
  }
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

async function handleApi(request, env, url) {
  // Only accept writes from this site's own pages
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "Cross-site requests are not allowed." }, 403);
  }

  if (url.pathname === "/api/sessions" && request.method === "POST") {
    const body = await readBody(request);
    const total = clampInt(body.total, 1, 1000);
    const amberAt = clampInt(body.amberAt, 1, 99);
    const greenAt = clampInt(body.greenAt, 2, 100);
    if (total === null) return json({ error: "Enter a number of participants between 1 and 1000." }, 400);
    if (amberAt === null || greenAt === null || greenAt <= amberAt) return json({ error: "Set orange below green, both between 1% and 100%." }, 400);
    const title = cleanText(body.title, 80) || "Check-in";
    for (let attempt = 0; attempt < 5; attempt++) {
      const sid = newSid();
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
      const res = await stub.create({ title, total, amberAt, greenAt });
      if (res.ok) return json({ sid, key: res.key }, 201);
    }
    return json({ error: "Couldn't create the check-in. Try again." }, 503);
  }

  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(checkin|walkin|end|ws))?$/);
  if (!m || !SID_RE.test(m[1])) return json({ error: "Not found" }, 404);
  const [, sid, action] = m;
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
  const hostKey = request.headers.get("x-host-key");

  if (!action && request.method === "GET") {
    const device = url.searchParams.get("device");
    const res = await stub.getState({
      key: hostKey,
      device: device && DEVICE_RE.test(device) ? device : null,
      cookie: readCookie(request, DEVICE_COOKIE),
    });
    if (!res) return json({ error: "This check-in doesn't exist or has expired." }, 404);
    if (res.forbidden) return json({ error: "This host link isn't valid." }, 403);
    return json(res);
  }

  if (action === "ws") {
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket." }, 426);
    return stub.fetch(request);
  }

  if (action === "checkin" && request.method === "POST") {
    const body = await readBody(request);
    const device = typeof body.device === "string" && DEVICE_RE.test(body.device) ? body.device : null;
    const email = cleanText(body.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address, like name@example.com." }, 400);
    let cookie = readCookie(request, DEVICE_COOKIE);
    if (!cookie || !DEVICE_RE.test(cookie)) cookie = newKey();
    const res = await stub.checkin({ device, cookie, email });
    const setCookie = `${DEVICE_COOKIE}=${cookie}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
    if (res.status === 404) return json({ error: "This check-in doesn't exist or has expired." }, 404);
    if (res.status === 409) return json({ error: "This check-in is full." }, 409);
    if (res.status === 410) return json({ error: "This check-in has ended." }, 410);
    return json({ already: res.already, state: res.state }, 200, { "set-cookie": setCookie });
  }

  if (action === "walkin" && (request.method === "POST" || request.method === "DELETE")) {
    const res = request.method === "POST" ? await stub.walkin(hostKey) : await stub.undoWalkin(hostKey);
    if (res.status === 403) return json({ error: "This host link isn't valid." }, 403);
    if (res.status === 404) return json({ error: "This check-in doesn't exist or has expired." }, 404);
    if (res.status === 409) return json({ error: "This check-in is full." }, 409);
    if (res.status === 410) return json({ error: "This check-in has ended." }, 410);
    return json({ ok: true });
  }

  if (action === "end" && request.method === "POST") {
    const res = await stub.end(hostKey);
    if (res.status === 403) return json({ error: "This host link isn't valid." }, 403);
    if (res.status === 404) return json({ error: "This check-in doesn't exist or has expired." }, 404);
    return json({ state: res.state });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
