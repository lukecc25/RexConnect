/**
 * Rex Connect server.
 *
 * Serves the site and temporarily stores submitted phone numbers.
 * When 4 to 6 people have chosen the same group, it opens a group text
 * so they can talk to each other.
 *
 * Texting uses Twilio Conversations. Copy .env.example to .env and set:
 *
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER   a +1 long code, for example +15015550100
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(ROOT, "data", "submissions.json");
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
const WAITING_SECONDS = 48 * 60 * 60;
const GROUP_SECONDS = 7 * 24 * 60 * 60;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
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
  return { waiting: {}, groups: [] };
}

function loadStore() {
  if (!fs.existsSync(DATA_PATH)) return emptyStore();
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    if (!data.waiting) data.waiting = {};
    if (!data.groups) data.groups = [];
    return data;
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  const temporary = DATA_PATH.replace(/\.json$/, ".tmp");
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
  fs.rmSync(DATA_PATH, { force: true });
  fs.renameSync(temporary, DATA_PATH);
}

function prune(store, now) {
  for (const [interest, people] of Object.entries(store.waiting)) {
    const kept = people.filter((person) => now - person.at < WAITING_SECONDS);
    if (kept.length) store.waiting[interest] = kept;
    else delete store.waiting[interest];
  }
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

function recordSubmission(store, phone, interest, now) {
  prune(store, now);
  compactWaiting(store);

  if (!store.waiting[interest]) store.waiting[interest] = [];
  const pool = store.waiting[interest];
  if (pool.some((person) => person.phone === phone)) {
    const result = waitingResult(interest, pool.length);
    result.alreadyWaiting = true;
    return [result, []];
  }

  for (const [other, people] of Object.entries(store.waiting)) {
    if (other === interest) continue;
    store.waiting[other] = people.filter((person) => person.phone !== phone);
  }

  pool.push({ phone, at: now });
  const formed = [];
  while (pool.length >= GROUP_MIN) {
    const size = Math.min(GROUP_MAX, pool.length);
    const members = pool.splice(0, size);
    const group = {
      id: crypto.randomBytes(16).toString("hex"),
      interest,
      phones: members.map((person) => person.phone),
      createdAt: now,
      textStatus: "pending",
      conversationSid: null,
      textError: null,
    };
    store.groups.push(group);
    formed.push(group);
  }

  compactWaiting(store);

  for (const group of formed) {
    if (group.phones.includes(phone)) {
      return [
        {
          status: "grouped",
          interest,
          size: group.phones.length,
          textStatus: group.textStatus,
          groupId: group.id,
        },
        formed,
      ];
    }
  }

  return [waitingResult(interest, pool.length), formed];
}

function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER,
  );
}

function quotePlus(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

function formEncode(fields) {
  return fields.map(([key, value]) => `${quotePlus(key)}=${quotePlus(String(value))}`).join("&");
}

async function twilioRequest(method, url, fields) {
  const headers = {
    Authorization: `Basic ${Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`,
    ).toString("base64")}`,
  };
  const init = { method, headers, signal: AbortSignal.timeout(20000) };
  if (fields) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = formEncode(fields);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Twilio returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendGroupText(group) {
  if (!twilioConfigured()) {
    group.textStatus = "unconfigured";
    group.textError = "Twilio credentials are not set.";
    return;
  }

  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const fields = [["FriendlyName", `Rex Connect: ${group.interest}`]];
  fields.push([
    "Participant",
    JSON.stringify({
      identity: "rex-connect",
      messaging_binding: { projected_address: fromNumber },
    }),
  ]);
  for (const phone of group.phones) {
    fields.push([
      "Participant",
      JSON.stringify({ messaging_binding: { address: `+1${phone}` } }),
    ]);
  }

  try {
    const created = await twilioRequest(
      "POST",
      "https://conversations.twilio.com/v1/ConversationWithParticipants",
      fields,
    );
    const sid = created.sid;
    group.conversationSid = sid;
    const deadline = Date.now() + 15000;
    let state = created.state;
    while (state === "initializing" && Date.now() < deadline) {
      await sleep(1000);
      const current = await twilioRequest(
        "GET",
        `https://conversations.twilio.com/v1/Conversations/${sid}`,
      );
      state = current.state;
    }
    if (state === "closed") {
      throw new Error("Twilio closed the group before it became active.");
    }

    const size = group.phones.length;
    const others = size - 1;
    const noun = others === 1 ? "person" : "people";
    await twilioRequest(
      "POST",
      `https://conversations.twilio.com/v1/Conversations/${sid}/Messages`,
      [
        [
          "Body",
          `Rex Connect: your ${group.interest} group is ready. You're here with ${others} other ${noun} who chose the same group. Reply in this text to introduce yourself and make plans. Thank you for using Rex Connect. Here is your group of ${size} people. Try talking about what you want to try doing and hang out with each other.`,
        ],
        ["Author", "rex-connect"],
      ],
    );
    group.textStatus = "sent";
    group.textError = null;
  } catch (error) {
    group.textStatus = "failed";
    group.textError = String(error.message || error);
    console.log(`Group text failed for ${group.interest}: ${group.textError}`);
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
  }
  return payload;
}

async function retryUnsent(store) {
  if (!twilioConfigured()) return;
  const pending = store.groups.filter((group) =>
    group.textStatus === "pending" || group.textStatus === "unconfigured",
  );
  for (const group of pending) {
    await sendGroupText(group);
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
    return { error: "Enter a 10-digit phone number." };
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > 2000) return { error: "Enter a 10-digit phone number." };
    chunks.push(chunk);
  }
  try {
    return { payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: "Enter a 10-digit phone number." };
  }
}

async function submit(req, res) {
  const body = await readBody(req);
  if (body.error) {
    sendJson(res, 400, { error: body.error });
    return;
  }

  let phone = String(body.payload.phone ?? "").replace(/\D/g, "");
  if (phone.length === 11 && phone.startsWith("1")) phone = phone.slice(1);
  const interest = String(body.payload.interest ?? "");
  if (phone.length !== 10 || !INTERESTS.has(interest)) {
    sendJson(res, 400, { error: "Choose a group and enter a 10-digit phone number." });
    return;
  }

  const { result, formed } = await withLock(async () => {
    const store = loadStore();
    const [nextResult, nextFormed] = recordSubmission(store, phone, interest, Date.now() / 1000);
    saveStore(store);
    return { result: nextResult, formed: nextFormed };
  });

  for (const group of formed) {
    await sendGroupText(group);
  }

  if (formed.length) {
    await withLock(async () => {
      const store = loadStore();
      const byId = new Map(formed.map((group) => [group.id, group]));
      for (const group of store.groups) {
        const update = byId.get(group.id);
        if (!update) continue;
        group.textStatus = update.textStatus;
        group.textError = update.textError;
        group.conversationSid = update.conversationSid;
      }
      saveStore(store);
    });
    if (result.status === "grouped") {
      const match = formed.find((group) => group.id === result.groupId);
      if (match) result.textStatus = match.textStatus;
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
    const store = loadStore();
    prune(store, Date.now() / 1000);
    saveStore(store);
    await retryUnsent(store);
    saveStore(store);
  });

  const server = http.createServer(handle);
  server.listen(8765, "127.0.0.1", () => {
    console.log("Rex Connect is running at http://127.0.0.1:8765/");
  });
}

const launchedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (launchedDirectly) main();

export { emptyStore, recordSubmission };
