// Bitta token → bitta polling jarayoni (distributed lock) uchun acceptance testlar.
//
// Tekshiriladi (spec §1, §3):
//  1. Bir xil bazada ikki instans ishga tushsa — faqat bittasi getUpdates qiladi.
//  2. Ikkinchi instans qulfni olmasligini ochiq aytadi (health: online=false + sabab).
//  3. Mock bir vaqtda ikkita long-poll ko'rmaydi (concurrent yozuvi yo'q).
//  4. Bir instans to'g'ri to'xtasa (SIGTERM) — ikkinchisi qulfni oladi.
//  5. Instans crash bo'lsa (SIGKILL, qulf bo'shatilmaydi) — yangisi o'zlashtiradi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const MOCK = 3991;
const DB = "data/lock-test-db.json";
const STATE = "data/lock-state.json";
const INBOX = "data/lock-inbox.json";
const OUT = "data/lock-out.log";
const CALLS = "data/lock-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const seed = {
  seq: 9100,
  users: {
    9301: {
      id: "u-9301",
      telegramId: 9301,
      username: "owner",
      displayName: "Owner",
      language: "uz",
      credits: { available: 0, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
      registeredAt: nowIso(),
      referralCode: "REF_9301",
      isReferralVerified: false,
      completedTasksCount: 0,
      activeOrdersCount: 0,
      status: "active",
      chatId: 9301,
      botId: "bot-main",
      notifications: true,
      notif: { subscribers: true, referrals: true, orders: true, technical: true }
    }
  },
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
  env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
  stdio: "inherit"
});

const servers = [];
function startServer(port, label) {
  const proc = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
      TELEGRAM_BOT_TOKEN: "TESTTOKEN",
      ADMIN_PASSWORD: "testpass",
      DATA_FILE: DB,
      KEEP_ALIVE: "0",
      BOT_START_RETRY_SEC: "2",
      MAINTENANCE_SEC: "60"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  proc.getLog = () => log;
  proc.label = label;
  servers.push(proc);
  return proc;
}
async function waitHttp(port) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
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
  const j = await r.json();
  return j.bots || [];
}
async function waitOnline(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const bots = await botsOf(port).catch(() => []);
    if (bots.some((b) => b.online)) return true;
    await sleep(400);
  }
  return false;
}
async function waitOffline(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const bots = await botsOf(port).catch(() => []);
    if (bots.length && bots.every((b) => !b.online)) return bots;
    await sleep(400);
  }
  return null;
}
const concurrencyEvents = () => {
  try {
    return fs.readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).filter((x) => x.concurrent);
  } catch {
    return [];
  }
};

async function main() {
  const A = 3980;
  const B = 3981;
  const C = 3982;

  // 1. Birinchi instans qulfni oladi va polling qiladi.
  const a = startServer(A, "A");
  await waitHttp(A);
  check("A instans boshqaruvchi sifatida polling qildi", await waitOnline(A));

  // 2. Ikkinchi instans qulfni olmasligi kerak.
  const b = startServer(B, "B");
  await waitHttp(B);
  const bBots = await waitOffline(B, 12000);
  check("B instans polling qilmaydi (online=false)", !!bBots, JSON.stringify(await botsOf(B).catch(() => [])));
  check("B instans sababni aytadi", !!bBots && /boshqa instans/.test(String(bBots[0].lastError || "")), bBots && bBots[0].lastError);
  check("B instans buni logga yozdi", /qulf boshqa instansda/.test(b.getLog()));

  // 3. Mock parallellikni ko'rmaydi.
  await sleep(3000);
  const conc = concurrencyEvents();
  check("Telegram'ga parallel getUpdates ketmadi", conc.length === 0, JSON.stringify(conc.slice(0, 3)));
  check("A hali ham polling qilmoqda", (await botsOf(A).catch(() => [])).some((x) => x.online));

  // 4. A to'g'ri to'xtaydi (SIGTERM) — qulf bo'shaydi, B o'zlashtiradi.
  a.kill("SIGTERM");
  await sleep(1500);
  check("Gap to'xtagandan keyin B qulfni o'zlashtirdi", await waitOnline(B, 15000));
  check("B polling boshladi (log)", /ishga tushdi/.test(b.getLog()));

  // 5. Crash (SIGKILL): B qulfni bo'shatmaydi, C o'zlashtirishi shart.
  b.kill("SIGKILL");
  await sleep(800);
  const c = startServer(C, "C");
  await waitHttp(C);
  check("Crashdan keyin C qulfni o'zlashtirdi (o'lik pid aniqlash)", await waitOnline(C, 20000));
  check("Crashdan keyin ham parallel getUpdates yo'q", concurrencyEvents().length === 0, JSON.stringify(concurrencyEvents().slice(0, 3)));

  for (const p of servers) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
  await sleep(800);
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
