/**
 * Rex Connect server.
 *
 * Serves the site and keeps submitted phone numbers until they join a GroupMe.
 * When 4 to 6 people have chosen the same group, it asks Make.com to
 * create a unique GroupMe for them.
 *
 * Copy .env.example to .env and set:
 *
 *   MAKE_WEBHOOK_URL            the Make.com custom webhook for the GroupMe scenario
 *   SUPABASE_URL                the Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   the Supabase secret key, kept on the server
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(ROOT, ".env");

const INTERESTS = new Set([
  "School Activities",
  "Game Nights",
  "Events",
  "Fitness Programs",
  "Sports",
]);
const GROUP_MIN = 4;
const GROUP_MAX = 6;
const GROUP_SECONDS = 7 * 24 * 60 * 60;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

let lock = Promise.resolve();

function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => {},
    () => {},
  );
  return run;
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const splitAt = line.indexOf("=");
    const key = line.slice(0, splitAt).trim();
    let value = line.slice(splitAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function emptyStore() {
  return { waiting: {}, groups: [], created: {} };
}

function normalizeStore(data) {
  const store = data && typeof data === "object" ? data : emptyStore();
  if (!store.waiting || typeof store.waiting !== "object" || Array.isArray(store.waiting)) store.waiting = {};
  if (!Array.isArray(store.groups)) store.groups = [];
  ensureCreated(store);
  return store;
}

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, key };
}

function supabaseHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function loadStore() {
  const config = supabaseConfig();
  if (!config) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.");

  const response = await fetch(`${config.url}/rest/v1/rex_store?id=eq.1&select=data`, {
    headers: supabaseHeaders(config.key),
  });
  if (response.status === 404) {
    throw new Error("Supabase is missing the rex_store table. Run supabase/schema.sql in the Supabase SQL editor.");
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 180);
    throw new Error(`Could not load signups from Supabase (${response.status}). ${detail}`);
  }
  const rows = await response.json();
  if (!rows.length) return emptyStore();
  return normalizeStore(rows[0].data);
}

async function saveStore(store) {
  const config = supabaseConfig();
  if (!config) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.");

  const response = await fetch(`${config.url}/rest/v1/rex_store?on_conflict=id`, {
    method: "POST",
    headers: supabaseHeaders(config.key, {
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({
      id: 1,
      data: store,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 180);
    throw new Error(`Could not save signups to Supabase (${response.status}). ${detail}`);
  }
}

function ensureCreated(store) {
  if (!store.created || typeof store.created !== "object" || Array.isArray(store.created)) {
    store.created = {};
    for (const group of store.groups) {
      if (!INTERESTS.has(group.interest)) continue;
      store.created[group.interest] = (store.created[group.interest] || 0) + 1;
    }
  }
  for (const interest of INTERESTS) {
    const count = Number(store.created[interest]);
    store.created[interest] = Number.isInteger(count) && count > 0 ? count : 0;
  }
}

function createdCounts(store) {
  ensureCreated(store);
  let total = 0;
  for (const interest of INTERESTS) total += store.created[interest];
  return { total };
}

function prune(store, now) {
  store.groups = store.groups.filter((group) => now - group.createdAt < GROUP_SECONDS);
}

function compactWaiting(store) {
  store.waiting = Object.fromEntries(
    Object.entries(store.waiting).filter(([, people]) => people.length),
  );
}

function waitingResult(interest, count) {
  return {
    status: "waiting",
    interest,
    waitingCount: count,
    groupMin: GROUP_MIN,
    groupMax: GROUP_MAX,
  };
}

function sameContact(person, contact) {
  if (contact.phone && person.phone === contact.phone) return true;
  return Boolean(contact.email && person.email && person.email.toLowerCase() === contact.email);
}

function recordSubmission(store, contact, interest, now) {
  prune(store, now);
  compactWaiting(store);
  ensureCreated(store);

  if (!store.waiting[interest]) store.waiting[interest] = [];
  const pool = store.waiting[interest];
    if (pool.some((person) => sameContact(person, contact))) {
    const result = waitingResult(interest, pool.length);
    result.alreadyWaiting = true;
    return [result, []];
  }

  for (const [other, people] of Object.entries(store.waiting)) {
    if (other === interest) continue;
    store.waiting[other] = people.filter((person) => !sameContact(person, contact));
  }

  pool.push({
    phone: contact.phone || null,
    email: contact.email || null,
    at: now,
  });
  const formed = [];
  while (pool.length >= GROUP_MIN) {
    const size = Math.min(GROUP_MAX, pool.length);
    const members = pool.splice(0, size);
    const group = {
      id: crypto.randomBytes(16).toString("hex"),
      interest,
      members: members.map((person) => ({
        phone: person.phone || null,
        email: person.email || null,
      })),
      createdAt: now,
      textStatus: "pending",
      groupmeId: null,
      groupmeUrl: null,
      textError: null,
    };
    store.groups.push(group);
    formed.push(group);
    store.created[interest] += 1;
  }

  compactWaiting(store);

  for (const group of formed) {
    if (group.members.some((person) => sameContact(person, contact))) {
      return [
        {
          status: "grouped",
          interest,
          size: group.members.length,
          textStatus: group.textStatus,
          groupId: group.id,
        },
        formed,
      ];
    }
  }

  return [waitingResult(interest, pool.length), formed];
}

function makeWebhookUrl() {
  const raw = process.env.MAKE_WEBHOOK_URL;
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === "make.com" || host.endsWith(".make.com") || host.endsWith(".integromat.com");
  if (url.protocol !== "https:" || !allowed) return null;
  return url.toString();
}

const GROUP_PURPOSE = {
  "School Activities": "school activities",
  "Game Nights": "game nights",
  Events: "events",
  "Fitness Programs": "fitness",
  Sports: "sports",
};

function welcomeMessage(interest, size) {
  const purpose = GROUP_PURPOSE[interest] || String(interest).toLowerCase();
  const joined = size === 1 ? "1 person joined" : `${size} people joined`;
  return `Welcome to Rex Connect. ${joined} this chat for ${purpose}. Talk about what you want to try doing and hang out with each other.`;
}

function groupMePayload(group) {
  const people = group.members || [];
  const size = people.length;
  return {
    groupId: group.id,
    name: `Rex Connect: ${group.interest} ${group.id.slice(0, 6)}`,
    interest: group.interest,
    size,
    phones: people.filter((person) => person.phone).map((person) => `+1${person.phone}`),
    emails: people.filter((person) => person.email).map((person) => person.email),
    members: people.map((person) => ({
      nickname: "Rex Connect",
      phone: person.phone ? `+1${person.phone}` : "",
      email: person.email || "",
    })),
    description:
      `Thank you for using Rex Connect. Here is your group of ${size} people. ` +
      "Try talking about what you want to try doing and hang out with each other.",
    message: welcomeMessage(group.interest, size),
  };
}

function readGroupMeLink(body) {
  if (!body || typeof body !== "object") return {};
  const rawUrl = body.groupmeUrl || body.shareUrl || body.share_url || body.groupme_url;
  const rawId = body.groupmeId || body.group_id || body.id;
  let groupmeUrl = null;
  if (typeof rawUrl === "string") {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:") groupmeUrl = parsed.toString();
    } catch {
      groupmeUrl = null;
    }
  }
  return { groupmeUrl, groupmeId: rawId ? String(rawId) : null };
}

async function createGroupMe(group) {
  const webhook = makeWebhookUrl();
  if (!webhook) {
    group.textStatus = "unconfigured";
    group.textError = "Make.com webhook is not set.";
    return;
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.MAKE_WEBHOOK_SECRET) headers["x-rex-secret"] = process.env.MAKE_WEBHOOK_SECRET;
    const response = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify(groupMePayload(group)),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Make.com returned ${response.status}`);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const link = readGroupMeLink(body);
    group.groupmeId = link.groupmeId;
    group.groupmeUrl = link.groupmeUrl;
    group.textStatus = "sent";
    group.textError = null;
  } catch (error) {
    group.textStatus = "failed";
    group.textError = String(error.message || error);
    console.log(`GroupMe creation failed for ${group.interest}: ${group.textError}`);
  }
}

function publicResult(result) {
  const payload = {
    status: result.status,
    interest: result.interest,
  };
  if (result.status === "waiting") {
    payload.waitingCount = result.waitingCount;
    payload.groupMin = result.groupMin;
    payload.groupMax = result.groupMax;
    payload.alreadyWaiting = Boolean(result.alreadyWaiting);
  } else {
    payload.size = result.size;
    payload.textStatus = result.textStatus;
    if (result.groupmeUrl) payload.groupmeUrl = result.groupmeUrl;
  }
  return payload;
}

async function retryUnsent(store) {
  if (!makeWebhookUrl()) return;
  const pending = store.groups.filter((group) =>
    group.textStatus === "pending" || group.textStatus === "unconfigured",
  );
  for (const group of pending) {
    await createGroupMe(group);
  }
}

function requestPath(url) {
  return new URL(url, "http://127.0.0.1").pathname;
}

function staticFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestPath(urlPath));
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".env" || part === "data" || part === "node_modules")) {
    return null;
  }
  const resolved = path.resolve(ROOT, parts.length ? parts.join(path.sep) : ".");
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!parts.length) return path.join(ROOT, "index.html");
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, "index.html");
  }
  return resolved;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  const body = fs.readFileSync(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (!Number.isInteger(length) || length <= 0 || length > 2000) {
    return { error: "Choose a group and enter a phone number or email." };
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > 2000) return { error: "Choose a group and enter a phone number or email." };
    chunks.push(chunk);
  }
  try {
    return { payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: "Choose a group and enter a phone number or email." };
  }
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

async function submit(req, res) {
  const body = await readBody(req);
  if (body.error) {
    sendJson(res, 400, { error: body.error });
    return;
  }

  let phone = String(body.payload.phone ?? "").replace(/\D/g, "");
  if (phone.length === 11 && phone.startsWith("1")) phone = phone.slice(1);
  if (phone.length !== 10) phone = "";
  const email = normalizeEmail(body.payload.email);
  const interest = String(body.payload.interest ?? "");
  if ((!phone && !email) || (phone && email) || !INTERESTS.has(interest)) {
    sendJson(res, 400, { error: "Choose a group and enter a phone number or email." });
    return;
  }

  const contact = { phone: phone || null, email };
  const { result, formed } = await withLock(async () => {
    const store = await loadStore();
    const [nextResult, nextFormed] = recordSubmission(store, contact, interest, Date.now() / 1000);
    await saveStore(store);
    return { result: nextResult, formed: nextFormed };
  });

  for (const group of formed) {
    await createGroupMe(group);
  }

  if (formed.length) {
    await withLock(async () => {
      const store = await loadStore();
      const byId = new Map(formed.map((group) => [group.id, group]));
      for (const group of store.groups) {
        const update = byId.get(group.id);
        if (!update) continue;
        group.textStatus = update.textStatus;
        group.textError = update.textError;
        group.groupmeId = update.groupmeId;
        group.groupmeUrl = update.groupmeUrl;
      }
      await saveStore(store);
    });
    if (result.status === "grouped") {
      const match = formed.find((group) => group.id === result.groupId);
      if (match) {
        result.textStatus = match.textStatus;
        result.groupmeUrl = match.groupmeUrl;
      }
    }
  }

  sendJson(res, 200, publicResult(result));
}

async function handle(req, res) {
  try {
    const pathname = requestPath(req.url || "/");
    if (req.method === "POST" && pathname === "/api/submit") {
      await submit(req, res);
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/counts") {
      const counts = await withLock(async () => createdCounts(await loadStore()));
      if (req.method === "HEAD") {
        res.writeHead(200, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      sendJson(res, 200, counts);
      return;
    }
    if (req.method === "POST") {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Not found." });
      return;
    }
    const filePath = staticFile(req.url || "/");
    if (req.method === "HEAD") {
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": fs.statSync(filePath).size,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    sendFile(res, filePath);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: "We couldn't save your number." });
    console.log(error);
  }
}

async function main() {
  loadEnv(ENV_PATH);
  await withLock(async () => {
    const store = await loadStore();
    prune(store, Date.now() / 1000);
    await saveStore(store);
    await retryUnsent(store);
    await saveStore(store);
  });

  const server = http.createServer(handle);
  server.listen(8765, "127.0.0.1", () => {
    console.log("Rex Connect is running at http://127.0.0.1:8765/");
  });
}

const launchedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (launchedDirectly) main();

export { createGroupMe, emptyStore, groupMePayload, recordSubmission };