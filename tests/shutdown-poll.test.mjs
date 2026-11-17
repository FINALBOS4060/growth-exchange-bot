// SIGTERM paytida polling xavfsiz to'xtatilishi (spec A).
//
// Tartib isbotlanadi:
//   1) yangi getUpdates rejalashtirilmaydi,
//   2) faol long-poll ABORT qilinadi (mock "poll-aborted" yozadi),
//   3) tsikl tugashi kutiladi,
//   4) SHUNDAN KEYIN qulf bo'shaydi — yangi instans shundan keyingina polling
//      boshlaydi (uning "poll-start" yozuvi abortdan KEYIN keladi).
// Butun jarayon davomida Telegram'ga parallel long-poll ketmaydi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const A = 3966;
const B = 3967;
const MOCK = 3965;
const DB = "data/shut-test-db.json";
const STATE = "data/shut-state.json";
const INBOX = "data/shut-inbox.json";
const OUT = "data/shut-out.log";
const CALLS = "data/shut-calls.log";

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

const user = (tid) => ({
  id: "u-" + tid,
  telegramId: tid,
  username: "u" + tid,
  displayName: "U" + tid,
  language: "uz",
  credits: { available: 0, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(),
  referralCode: "REF" + tid,
  isReferralVerified: false,
  completedTasksCount: 0,
  activeOrdersCount: 0,
  status: "active",
  chatId: tid,
  botId: "bot-main",
  notifications: false,
  notif: { subscribers: false, referrals: false, orders: false, technical: false }
});

const seed = {
  seq: 9700,
  users: { 9601: user(9601) },
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
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }]
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
    // Uzoq long-poll: abort qilinmasa, u 4 soniya ochiq qoladi.
    MOCK_POLL_DELAY_MS: "4000"
  },
  stdio: "inherit"
});

const servers = [];
function startServer(port) {
  const p = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
      TELEGRAM_BOT_TOKEN: "TESTTOKEN",
      ADMIN_PASSWORD: "testpass",
      DATA_FILE: DB,
      KEEP_ALIVE: "0",
      BOT_START_RETRY_SEC: "1",
      MAINTENANCE_SEC: "60",
      // Windows'da OS signalini ushlab bo'lmaydi — test xuddi shu
      // `shutdown("SIGTERM")` yo'lini stdin orqali chaqiradi.
      SHUTDOWN_ON_STDIN: "1"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  p.getLog = () => log;
  p.exited = new Promise((r) => p.on("exit", (code, sig) => r({ code, sig })));
  servers.push(p);
  return p;
}
async function waitHttp(port) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error("server ko'tarilmadi: " + port);
}
async function login(port) {
  const r = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function botsOf(port) {
  const cookie = await login(port);
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/health`, { headers: { cookie } });
  return (await r.json()).bots || [];
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      // Async predikat ham bo'lishi mumkin — await qilamiz (aks holda Promise
      // har doim truthy bo'lib, keyin ushlanmagan rejection paydo bo'lardi).
      if (await fn()) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}
const count = (ev) => events().filter((e) => e.ev === ev).length;

async function main() {
  // --- A instans polling boshlaydi va long-poll ochiq qoladi.
  const a = startServer(A);
  await waitHttp(A);
  check("A instans pollingni boshladi", await waitFor(() => count("poll-start") >= 1, 12000));
  check("Long-poll ochiq (hali tugamagan)", count("poll-end") === 0 && count("poll-aborted") === 0, JSON.stringify(events()));

  // --- B instans kutadi (qulf band).
  const b = startServer(B);
  await waitHttp(B);
  await sleep(2500);
  const bBots = await botsOf(B);
  check("B instans hali polling qilmadi", bBots.every((x) => !x.online), JSON.stringify(bBots));
  check("B sababni ko'rsatdi", /boshqa instans/.test(String((bBots[0] || {}).lastError || "")), JSON.stringify(bBots));
  check("Parallel long-poll yo'q", events().filter((e) => e.concurrent).length === 0, JSON.stringify(events().filter((e) => e.concurrent)));

  // --- SIGTERM: faol so'rov abort qilinishi kerak.
  const startsBefore = count("poll-start");
  a.stdin.write("SIGTERM\n");
  const exited = await Promise.race([a.exited, sleep(12000).then(() => null)]);
  check("A SIGTERM dan keyin tugadi", !!exited, "tugamadi");
  check("A toza chiqdi (code 0)", !!exited && exited.code === 0, JSON.stringify(exited));
  check("A faol long-pollni abort qildi", count("poll-aborted") >= 1, JSON.stringify(events()));
  check("A tartibni logga yozdi", /Polling to'xtadi, qulf bo'shatilmoqda/.test(a.getLog()), a.getLog().slice(-300));

  // --- B qulfni olib polling boshlaydi.
  check("B qulfni olib polling boshladi", await waitFor(() => events().some((e) => e.ev === "poll-start") && count("poll-start") > startsBefore, 15000));
  check("B health: online", await waitFor(async () => (await botsOf(B)).some((x) => x.online), 12000));

  // --- Tartib: abort → keyin yangi start.
  const seq = events();
  const abortedIdx = seq.findIndex((e) => e.ev === "poll-aborted");
  const nextStartIdx = seq.findIndex((e, i) => i > abortedIdx && e.ev === "poll-start");
  check("Yangi polling faqat abortdan KEYIN boshlandi", abortedIdx >= 0 && nextStartIdx > abortedIdx, JSON.stringify(seq));
  check("Butun jarayonda parallel long-poll bo'lmadi", seq.filter((e) => e.concurrent).length === 0, JSON.stringify(seq.filter((e) => e.concurrent)));

  for (const p of servers) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
  await sleep(1000);
  mock.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  for (const p of servers) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
  try {
    mock.kill();
  } catch {}
  process.exit(1);
});
