// Qulf kalitlari (spec B): turli tokenlar mustaqil, bir xil token bitta qulf.
//
// Tekshiriladi:
//  1. Ikki xil tokenli bot BIR VAQTDA polling qiladi (mustaqil qulf).
//  2. Uchinchi bot birinchi botning tokeni bilan qo'shilgan — polling qilmaydi.
//  3. Telegram'ga bir vaqtda 2 tadan ortiq long-poll ketmaydi.
//  4. Bir xil token determinist kalitga tushadi (qayta qo'shilsa ham bloklanadi).
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3956;
const MOCK = 3955;
const DB = "data/keys-test-db.json";
const STATE = "data/keys-state.json";
const INBOX = "data/keys-inbox.json";
const OUT = "data/keys-out.log";
const CALLS = "data/keys-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const events = () => {
  try {
    return fs.readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const TOK_A = "111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOK_B = "222222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const seed = {
  seq: 9800,
  users: {},
  channels: [],
  igProfiles: [],
  orders: [],
  tasks: [],
  transactions: [],
  memberships: [],
  membershipEvents: [],
  verificationJobs: [],
  verifyErrors: [],
  sponsorMemberships: [],
  notifPeriods: [],
  complaints: [],
  referrals: [],
  sponsors: [],
  ctlRequests: [],
  verifyLog: [],
  adminUsers: [],
  auditLog: [],
  appeals: [],
  moderationFlags: [],
  lastHour: 0,
  settings: {
    creditRewardTelegram: 10,
    creditRewardInstagram: 10,
    creditRewardInstagramSelfConfirmed: 0,
    creditRewardReferral: 300,
    creditRewardSignup: 0,
    creditRewardChannelLink: 0,
    creditPerSubscriber: 1,
    autoOrderCredits: false,
    isInstagramEnabled: false,
    hourlyNotificationsEnabled: false,
    bots: [
      { id: "bot-main", token: TOK_A, role: "main", enabled: true, username: "bot_a", displayName: "A", offset: 0 },
      { id: "bot-worker", token: TOK_B, role: "worker", enabled: true, username: "bot_b", displayName: "B", offset: 0 },
      // Bir xil token ikkinchi marta — polling qilmasligi shart.
      { id: "bot-copy", token: TOK_A, role: "worker", enabled: true, username: "bot_a_copy", displayName: "A copy", offset: 0 }
    ]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(STATE, JSON.stringify({ members: {}, chats: {} }));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

const mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
  env: {
    ...process.env,
    MOCK_PORT: String(MOCK),
    MOCK_STATE: STATE,
    MOCK_INBOX: INBOX,
    MOCK_OUT: OUT,
    MOCK_CALLS: CALLS,
    MOCK_POLL_DELAY_MS: "1500"
  },
  stdio: "inherit"
});

const proc = spawn("node", ["server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
    TELEGRAM_BOT_TOKEN: TOK_A,
    ADMIN_PASSWORD: "testpass",
    DATA_FILE: DB,
    KEEP_ALIVE: "0",
    BOT_START_RETRY_SEC: "1",
    MAINTENANCE_SEC: "60"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
proc.stdout.on("data", (d) => (log += d));
proc.stderr.on("data", (d) => (log += d));

async function waitHttp() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error("server ko'tarilmadi");
}
async function login() {
  const r = await fetch(`http://127.0.0.1:${PORT}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function bots() {
  const cookie = await login();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/health`, { headers: { cookie } });
  return (await r.json()).bots || [];
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function main() {
  await waitHttp();
  const twoOnline = await waitFor(async () => (await bots()).filter((b) => b.online).length === 2, 20000);
  const list = await bots();
  check("Ikki xil tokenli bot bir vaqtda polling qiladi", twoOnline, JSON.stringify(list));
  const main = list.find((b) => b.id === "bot-main");
  const worker = list.find((b) => b.id === "bot-worker");
  const copy = list.find((b) => b.id === "bot-copy");
  check("bot-main online", !!main && main.online === true, JSON.stringify(main));
  check("bot-worker online (mustaqil qulf)", !!worker && worker.online === true, JSON.stringify(worker));
  check("Bir xil tokenli bot polling qilmaydi", !!copy && copy.online === false, JSON.stringify(copy));
  check("Dublikat token sababini ko'rsatadi", !!copy && /bir xil/.test(String(copy.lastError || "")), copy && copy.lastError);
  // startAllBots botlarni ketma-ket ishga tushiradi (getMe + skip getUpdates),
  // shuning uchun log satri biroz kechikadi — kutamiz.
  check("Dublikat token logga yozildi", await waitFor(() => /token boshqa bot bilan bir xil/.test(log), 15000), log.slice(-300));

  await sleep(3000);
  const ev = events();
  const maxConcurrent = ev.reduce((m, e) => Math.max(m, Number(e.concurrent) || 0), 0);
  check("Bir vaqtda ko'pi bilan 2 ta long-poll", maxConcurrent === 2, `max=${maxConcurrent}`);
  check("Uchinchi (dublikat) poll yo'q", maxConcurrent < 3, `max=${maxConcurrent}`);

  proc.kill("SIGKILL");
  await sleep(600);
  mock.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  try {
    proc.kill("SIGKILL");
  } catch {}
  try {
    mock.kill();
  } catch {}
  process.exit(1);
});
