// P1.4 — `channelHealthSweep` ikki instansda PARALLEL ishlamaydi.
//
// Ikki mustaqil `server.js` jarayoni bitta fayl bazasini va bitta mock
// Telegram'ni ishlatadi. Bitta kanal "due" (6 soatdan eski). Asosiy botning
// javobi 4 soniya kechikadi — sweep oynasi ikki instansning tikini ustma-ust
// qoplaydi.
//
// Natija: `gxb:sweep` advisory qulfi tufayli kanal uchun `getChatMember`
// so'rovlari FAQAT BIR MARTA yuboriladi (har bot uchun bittadan).
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT_A = 3997;
const PORT_B = 3998;
const MOCK = 3999;
const DB = "data/swl-test-db.json";
const STATE = "data/swl-state.json";
const INBOX = "data/swl-inbox.json";
const OUT = "data/swl-out.log";
const CALLS = "data/swl-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const readDb = () => JSON.parse(fs.readFileSync(DB, "utf8"));
const calls = () => {
  try {
    return fs.readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
async function waitFor(fn, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

const OLD = "2026-01-01T00:00:00.000Z";
const seed = {
  seq: 9500,
  users: {},
  channels: [{
    id: "ch-lock", channelId: "-3501", title: "LockChan", username: "lockchan",
    ownerId: "u-none", ownerName: "—", botHasAdminRights: true, botAdminStatus: "ok",
    totalRequested: 0, verifiedSubscribers: 0, activeSubscribers: 0, unsubscribedCount: 0,
    pendingSubscriptions: 0, controllers: [], status: "active", createdAt: nowIso(),
    lastAdminCheckAt: OLD
  }],
  igProfiles: [], orders: [], tasks: [], transactions: [], memberships: [], membershipEvents: [],
  verificationJobs: [], sponsorMemberships: [], notifPeriods: [], complaints: [], referrals: [],
  sponsors: [], ctlRequests: [], verifyLog: [], adminUsers: [], auditLog: [], appeals: [],
  moderationFlags: [], lastHour: 0,
  settings: {
    creditRewardTelegram: 10, creditRewardInstagram: 0, creditRewardInstagramSelfConfirmed: 0,
    creditRewardReferral: 0, creditRewardSignup: 0, creditRewardChannelLink: 0, creditPerSubscriber: 1,
    autoOrderCredits: false, isInstagramEnabled: true, hourlyNotificationsEnabled: false,
    bots: [
      { id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 },
      { id: "bot-worker1", token: "WORKERTOKEN1", role: "worker", enabled: true, username: "worker_one", displayName: "W1", offset: 0 }
    ]
  }
};
fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(OUT, "");
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(CALLS, "");
fs.writeFileSync(STATE, JSON.stringify({
  chats: { lockchan: { id: -3501, title: "LockChan" } },
  members: {},
  botMembers: {
    // Asosiy bot 4 s kutadi — sweep oynasi keng (timeout/kechikish = API xatosi).
    // Ishchi bot 5xx — ikkalasi ham xulosa bermaydi, kanal active qoladi.
    "777000": { "-3501|777000": "slow" },
    "777001": { "-3501|777001": "server" }
  }
}));

const mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
  env: {
    ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX,
    MOCK_OUT: OUT, MOCK_CALLS: CALLS,
    MOCK_BOT_ID_MAP: JSON.stringify({ WORKERTOKEN1: { id: 777001, username: "worker_one" } })
  },
  stdio: "ignore"
});
const baseEnv = {
  ...process.env, TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
  TELEGRAM_BOT_TOKEN: "TESTTOKEN", ADMIN_PASSWORD: "testpass", DATA_FILE: DB,
  KEEP_ALIVE: "0", MAINTENANCE_SEC: "2", VERIFY_BATCH: "25"
};
const servers = [];
function start(port) {
  const p = spawn("node", ["server.js"], {
    env: { ...baseEnv, PORT: String(port) },
    stdio: [process.env.SHOW_LOGS ? "inherit" : "ignore", "pipe", "pipe"]
  });
  p.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${port}] ` + d));
  p.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${port}:err] ` + d));
  servers.push(p);
  return p;
}
async function waitHttp(port) {
  return waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 30000);
}

async function main() {
  check("mock ishga tushdi", await waitFor(() => fs.existsSync(CALLS), 10000));
  start(PORT_A);
  check("instans A ko'tarildi", await waitHttp(PORT_A));
  // A sweep boshlagan paytda B ishga tushadi — qulf band bo'lishi kerak.
  start(PORT_B);
  check("instans B ko'tarildi", await waitHttp(PORT_B));

  const checked = await waitFor(() => {
    const ch = readDb().channels.find((c) => c.id === "ch-lock");
    return ch && ch.lastAdminCheckAt && ch.lastAdminCheckAt !== OLD;
  }, 25000);
  check("sweep kanalni tekshirdi", checked, JSON.stringify(readDb().channels.map((c) => c.lastAdminCheckAt)));

  // B ning keyingi tiklari uchun oyna (2 s interval), so'ng sanaymiz.
  await sleep(4000);
  const log = calls().filter((c) => c && typeof c.key === "string" && c.key.startsWith("-3501|"));
  const main = log.filter((c) => c.key === "-3501|777000").length;
  const worker = log.filter((c) => c.key === "-3501|777001").length;
  check("asosiy bot uchun so'rov aynan 1 marta", main === 1, `main=${main}, barcha=${log.length}`);
  check("ishchi bot uchun so'rov aynan 1 marta", worker === 1, `worker=${worker}`);
  check("parallel sweep bo'lmadi (jami 2 so'rov)", log.length === 2, JSON.stringify(log.map((c) => c.key)));

  // Qulf bo'shatilgani: fayl qulfi o'chirilgan.
  const ch2 = readDb().channels.find((c) => c.id === "ch-lock");
  check("sweep natijasi saqlandi (API xatosi holatni o'zgartirmadi)", !!ch2 && ch2.botAdminStatus === "ok",
    JSON.stringify({ s: ch2.botAdminStatus, ok: ch2.botHasAdminRights, status: ch2.status }));
  check("kanal active qoldi (API xatosi xulosa emas)", ch2.status === "active" && ch2.botHasAdminRights === true,
    JSON.stringify({ s: ch2.status, ok: ch2.botHasAdminRights }));

  for (const s of servers) {
    s.stdout.removeAllListeners();
    s.stderr.removeAllListeners();
    s.kill();
  }
  mock.kill();
  await sleep(600);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test halokati:", e);
  for (const s of servers) { try { s.kill(); } catch {} }
  try { mock.kill(); } catch {}
  process.exit(1);
});
