"use strict";

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "message", "create", "host", "guest"];
const show = (name) => VIEWS.forEach((v) => { $("view-" + v).hidden = v !== name; });

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let sid = null;
let hostKey = null;
let state = null;
let lastCount = null;
let wakeLock = null;

/* ---------- Helpers ---------- */
function message(title, body) {
  $("m-title").textContent = title;
  $("m-body").textContent = body;
  show("message");
  document.title = "Check-in · The Majlis of AI";
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

function deviceId() {
  let id = store.get("checkin-device", null);
  if (!id) { id = "d" + randomId(); store.set("checkin-device", id); }
  return id;
}

function defaultTitle() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  const day = d.toLocaleDateString("en-US", { weekday: "long" });
  return day + " - " + d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate());
}

const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const checkinLink = () => location.origin + "/c/" + sid;
const hostLink = () => location.origin + "/h/" + sid + "#" + hostKey;

function stateFor(pct, s) {
  if (pct >= 100) return "full";
  if (pct >= s.greenAt) return "green";
  if (pct >= s.amberAt) return "amber";
  return "red";
}

function stats(s) {
  const n = s.count;
  const total = Math.max(1, s.total);
  const pct = Math.round((n / total) * 100);
  return { n, total, pct, level: stateFor(pct, s), remaining: Math.max(0, total - n) };
}

async function api(path, { method = "GET", body, key } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (key) headers["x-host-key"] = key;
  const res = await fetch("/api/sessions" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const err = new Error(data.error || "Something went wrong. Try again."); err.status = res.status; throw err; }
  return data;
}

/* ---------- Live updates: WebSocket with reconnect, polling as a fallback ---------- */
function connectLive(onState, key) {
  let ws = null, retry = 0, pollTimer = null, pingTimer = null, closed = false;
  const setLive = (on) => { const el = $("live"); if (el) { el.classList.toggle("off", !on); el.textContent = on ? "Live" : "Reconnecting…"; } };

  const poll = async () => {
    try { onState((await api("/" + sid, { key })).state); } catch {}
  };
  const startPolling = () => { if (!pollTimer) pollTimer = setInterval(poll, 5000); };
  const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/api/sessions/" + sid + "/ws" + (key ? "?key=" + encodeURIComponent(key) : ""));
    ws.onopen = () => {
      retry = 0; stopPolling(); setLive(true);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch {} }, 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try { const msg = JSON.parse(e.data); if (msg.type === "state") onState(msg.state); } catch {}
    };
    ws.onclose = () => {
      clearInterval(pingTimer); setLive(false); startPolling();
      retry = Math.min(retry + 1, 6);
      setTimeout(open, Math.min(30000, 1000 * 2 ** retry) * (0.5 + Math.random() / 2));
    };
  };
  open();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
  return () => { closed = true; stopPolling(); try { ws && ws.close(); } catch {} };
}

/* ---------- Create ---------- */
function openCreate() {
  show("create");
  $("f-title").value = defaultTitle();
  $("f-title").placeholder = defaultTitle();
  const recent = store.get("checkin-hosted", []);
  $("recent").hidden = recent.length === 0;
  const list = $("recent-list");
  list.textContent = "";
  for (const r of recent.slice(0, 8)) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "/h/" + r.sid + "#" + r.key;
    a.textContent = r.title;
    if (r.ended) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = " · ended"; a.appendChild(tag); }
    const t = document.createElement("time");
    t.textContent = new Date(r.createdAt).toLocaleDateString([], { month: "short", day: "numeric" }) + " · " + timeOf(r.createdAt);
    li.append(a, t);
    list.appendChild(li);
  }
  $("f-title").focus();
  let endedMsg = null;
  try { endedMsg = sessionStorage.getItem("checkin-ended-msg"); sessionStorage.removeItem("checkin-ended-msg"); } catch {}
  if (endedMsg) toast(endedMsg);
}

function markHostedEnded(id) {
  const hosted = store.get("checkin-hosted", []);
  const rec = hosted.find((r) => r.sid === id);
  if (rec && !rec.ended) { rec.ended = true; store.set("checkin-hosted", hosted); }
}

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("f-error");
  const title = $("f-title").value.trim() || defaultTitle();
  const total = parseInt($("f-total").value, 10);
  const amberAt = parseInt($("f-amber").value, 10);
  const greenAt = parseInt($("f-green").value, 10);
  if (!(total >= 1 && total <= 1000)) { err.textContent = "Enter a number of participants between 1 and 1000."; err.hidden = false; return; }
  if (!(amberAt >= 1 && greenAt > amberAt && greenAt <= 100)) { err.textContent = "Set orange below green, both between 1% and 100%."; err.hidden = false; return; }
  err.hidden = true;
  const btn = $("f-submit"); btn.disabled = true;
  try {
    const res = await api("", { method: "POST", body: { title, total, amberAt, greenAt } });
    const hosted = store.get("checkin-hosted", []);
    hosted.unshift({ sid: res.sid, key: res.key, title, createdAt: Date.now() });
    store.set("checkin-hosted", hosted.slice(0, 20));
    location.href = "/h/" + res.sid + "#" + res.key;
  } catch (x) {
    err.textContent = x.message; err.hidden = false;
  } finally { btn.disabled = false; }
});

/* ---------- Host ---------- */
async function openHost() {
  hostKey = location.hash.slice(1) || (store.get("checkin-hosted", []).find((r) => r.sid === sid) || {}).key || null;
  if (!hostKey) {
    message("This host link is missing its key", "Open the full host link you got when you created the check-in. To check in as a participant, use the QR code instead.");
    return;
  }
  try {
    state = (await api("/" + sid, { key: hostKey })).state;
  } catch (x) {
    if (x.status === 403) message("This host link isn't valid", "The key in the link doesn't match this check-in. Open the host link you got when you created it.");
    else if (x.status === 404) message("This check-in doesn't exist", "It may have expired. Check-ins are kept for 30 days.");
    else message("Can't reach the check-in", "Check your connection and reload the page.");
    return;
  }
  if (!location.hash) history.replaceState(null, "", "/h/" + sid + "#" + hostKey);
  const hosted = store.get("checkin-hosted", []);
  if (!hosted.some((r) => r.sid === sid)) {
    hosted.unshift({ sid, key: hostKey, title: state.title, createdAt: state.createdAt });
    store.set("checkin-hosted", hosted.slice(0, 20));
  }
  show("host");
  drawQR(checkinLink());
  $("link-text").textContent = checkinLink().replace(/^https?:\/\//, "");
  renderHost();
  keepAwake();
  connectLive((s) => { state = s; renderHost(); }, hostKey);
}

function drawQR(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 3;
  const size = count + quiet * 2;
  let d = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) d += "M" + (c + quiet) + " " + (r + quiet) + "h1v1h-1z";
    }
  }
  $("qr").innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size + '" shape-rendering="crispEdges">' +
    '<rect width="' + size + '" height="' + size + '" fill="#ffffff"/>' +
    '<path d="' + d + '" fill="#14181d"/></svg>';
}

function renderHost() {
  const s = state;
  const { n, total, pct, level, remaining } = stats(s);
  document.title = s.title + " · Check-in";
  $("h-title").textContent = s.title;
  $("h-meta").textContent = "Check-in · opened " + timeOf(s.createdAt);
  $("board").dataset.state = level;

  const nEl = $("n");
  nEl.textContent = n;
  if (lastCount !== null && n > lastCount) { nEl.classList.remove("bump"); void nEl.offsetWidth; nEl.classList.add("bump"); }
  lastCount = n;
  $("total").textContent = total;
  $("fill").style.width = Math.min(100, pct) + "%";
  $("tick-amber").style.left = s.amberAt + "%";
  $("tick-green").style.left = s.greenAt + "%";
  $("lbl-amber").style.left = s.amberAt + "%"; $("lbl-amber").textContent = s.amberAt + "%";
  $("lbl-green").style.left = s.greenAt + "%"; $("lbl-green").textContent = s.greenAt + "%";

  const ended = !!s.endedAt;
  $("board").classList.toggle("ended", ended);
  ["btn-walkin", "btn-undo", "btn-end"].forEach((id) => { $(id).hidden = ended; });
  if (ended) {
    markHostedEnded(sid);
    $("h-meta").textContent += " · ended " + timeOf(s.endedAt);
  }
  $("chip").textContent = ended ? "Check-in ended" : {
    red: n === 0 ? "Waiting for people" : "Just getting started",
    amber: "Filling up",
    green: "Almost everyone is here",
    full: "Everyone is here",
  }[level];
  const sum = $("summary");
  sum.textContent = pct + "% checked in";
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = ended
    ? "No more check-ins are accepted."
    : level === "full" ? "The class can start." : remaining + (remaining === 1 ? " person" : " people") + " still to check in";
  sum.appendChild(sub);

  const arrivals = s.arrivals || [];
  $("btn-undo").disabled = !arrivals.some((p) => p.walkIn);
  const list = $("arrivals");
  list.textContent = "";
  let walkNo = arrivals.filter((p) => p.walkIn).length;
  for (const p of arrivals.slice().reverse()) {
    const li = document.createElement("li");
    const av = document.createElement("span"); av.className = "av";
    const nm = document.createElement("span"); nm.className = "nm";
    if (p.walkIn) { av.textContent = "+1"; nm.textContent = "Walk-in " + walkNo--; }
    else { av.textContent = (p.email || "?").slice(0, 1).toUpperCase(); nm.textContent = p.email || "Participant"; }
    const t = document.createElement("time"); t.textContent = timeOf(p.at);
    li.append(av, nm, t);
    list.appendChild(li);
  }
  $("arr-empty").hidden = arrivals.length > 0;
  $("arr-count").textContent = arrivals.length ? arrivals.length + " in" : "";
}

async function keepAwake() {
  try { if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("view-host").hidden) { wakeLock = null; keepAwake(); }
});

$("btn-walkin").addEventListener("click", async () => {
  try { await api("/" + sid + "/walkin", { method: "POST", key: hostKey }); toast("Walk-in added"); }
  catch (x) { toast(x.message); }
});

$("btn-undo").addEventListener("click", async () => {
  try { await api("/" + sid + "/walkin", { method: "DELETE", key: hostKey }); toast("Last walk-in removed"); }
  catch (x) { toast(x.message); }
});

// Ending takes two taps so a stray click can't close the session
let endArmed = null;
function resetEnd() {
  clearTimeout(endArmed); endArmed = null;
  const btn = $("btn-end");
  btn.textContent = "End check-in"; btn.classList.remove("danger"); btn.disabled = false;
}
$("btn-end").addEventListener("click", async () => {
  const btn = $("btn-end");
  if (!endArmed) {
    btn.textContent = "Tap again to end";
    btn.classList.add("danger");
    endArmed = setTimeout(resetEnd, 4000);
    return;
  }
  clearTimeout(endArmed);
  btn.disabled = true;
  try {
    const res = await api("/" + sid + "/end", { method: "POST", key: hostKey });
    markHostedEnded(sid);
    const s = res.state;
    try { sessionStorage.setItem("checkin-ended-msg", "Ended “" + s.title + "” with " + s.count + " of " + s.total + " checked in"); } catch {}
    location.href = "/";
  } catch (x) {
    resetEnd();
    toast(x.message);
  }
});

function copy(text, label) {
  navigator.clipboard.writeText(text).then(() => toast(label + " copied"), () => toast("Couldn't copy. The link is " + text));
}
$("btn-copy").addEventListener("click", () => copy(checkinLink(), "Check-in link"));
$("btn-copy-host").addEventListener("click", () => copy(hostLink(), "Host link"));

/* ---------- Participant ---------- */
let checkedIn = false;

function deviceUsed() {
  return checkedIn || store.get("checkin-done-" + sid, false);
}

async function openGuest() {
  try {
    const res = await api("/" + sid + "?device=" + encodeURIComponent(deviceId()));
    state = res.state;
    if (res.you) { checkedIn = true; store.set("checkin-done-" + sid, true); }
  } catch (x) {
    if (x.status === 404) message("This check-in isn't open", "The QR code may be from an older session. Scan the code on screen again.");
    else message("Can't reach the check-in", "Check your connection and reload the page.");
    return;
  }
  $("g-email").value = store.get("checkin-email", "");
  renderGuest();
  connectLive((s) => { state = s; renderGuest(); }, null);
}

function renderGuest() {
  const s = state;
  const { n, total, pct, level } = stats(s);
  show("guest");
  document.title = s.title + " · Check-in";
  $("g-title").textContent = s.title;
  $("guest-card").dataset.state = level;
  $("g-fill").style.width = Math.min(100, pct) + "%";
  const cnt = $("g-count");
  cnt.textContent = "";
  const b = document.createElement("b"); b.textContent = n;
  cnt.append(b, " of " + total + " checked in");

  const done = deviceUsed();
  const closed = !done && !!s.endedAt;
  $("g-mark").hidden = !done;
  $("btn-checkin").hidden = done || closed;
  $("g-email-field").hidden = done || closed;
  if (closed) {
    $("g-head").textContent = "This check-in has ended";
    $("g-note").textContent = "The host closed check-in for this session. Ask them if you still need to be counted.";
  } else if (done) {
    $("g-head").textContent = "You’re checked in";
    $("g-note").textContent = level === "full"
      ? "Everyone is here. The class can start."
      : "Each device can check in once. If someone else needs to check in, ask the host to add them as a walk-in.";
  } else {
    $("g-head").textContent = "Check in to this session";
    $("g-note").textContent = "Tap once when you’re in the room.";
  }
}

$("btn-checkin").addEventListener("click", async () => {
  if (deviceUsed()) { renderGuest(); return; }
  const btn = $("btn-checkin");
  const email = $("g-email").value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    $("g-note").textContent = "Enter a valid email address, like name@example.com.";
    $("g-email").focus();
    return;
  }
  btn.disabled = true;
  store.set("checkin-email", email);
  try {
    const res = await api("/" + sid + "/checkin", { method: "POST", body: { device: deviceId(), email } });
    state = res.state;
    if (res.already === "email") {
      renderGuest();
      $("g-note").textContent = "That email address has already checked in to this session.";
      return;
    }
    checkedIn = true;
    store.set("checkin-done-" + sid, true);
    renderGuest();
    if (res.already === "device") toast("This device already checked in");
  } catch (x) {
    if (x.status === 410) { state = { ...state, endedAt: Date.now() }; renderGuest(); }
    else $("g-note").textContent = x.message;
  } finally { btn.disabled = false; }
});

/* ---------- Routing ---------- */
function route() {
  const m = location.pathname.match(/^\/(h|c)\/([a-z0-9]{8})\/?$/);
  if (!m) {
    if (location.pathname !== "/") history.replaceState(null, "", "/");
    openCreate();
    return;
  }
  sid = m[2];
  if (m[1] === "h") openHost(); else openGuest();
}
route();
