// `migrateSettings()` ro'yxatdan o'tish bonusini bir marta 0 ga tushiradi
// (biznes qoidasi: `bonusRuleVersion: 2`). Bu mavjud foydalanuvchilarning
// balansi yoki jurnalini O'ZGARTIRMASLIGI va qayta ishga tushirishda qayta
// qo'llanilmasligi tekshiriladi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 5621;
const MOCK = 5622;
const DB = "data/migrate-signup-db.json";
const STATE = "data/migrate-signup-mtg.json";
const INBOX = "data/migrate-signup-inbox.json";
const OUT = "data/migrate-signup-out.log";
const CALLS = "data/migrate-signup-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const user = (tid, available, over = {}) => ({
  id: "u-" + tid,
  telegramId: tid,
  username: "u" + tid,
  displayName: "U" + tid,
  language: "uz",
  credits: { available, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(),
  referralCode: "REF_" + tid,
  isReferralVerified: false,
  completedTasksCount: 0,
  activeOrdersCount: 0,
  status: "active",
  chatId: tid,
  botId: "bot-main",
  notifications: false,
  notif: { subscribers: false, referrals: false, orders: false, technical: false },
  ...over
});

function seedState(settingsOver) {
  return {
    seq: 500,
    // Eski foydalanuvchi: sovg'a allaqachon berilgan (balans + jurnal).
    users: {
      9801: user(9801, 100, {
        credits: { available: 100, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 100 }
      })
    },
    channels: [],
    igProfiles: [],
    orders: [],
    tasks: [],
    transactions: [
      { id: "tx-signup-9801", userId: "u-9801", amount: 100, type: "signup_bonus", idempotencyKey: "signup:u-9801", balanceAfter: 100, createdAt: nowIso() }
    ],
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
      creditPerSubscriber: 1,
      autoOrderCredits: false,
      isInstagramEnabled: false,
      hourlyNotificationsEnabled: false,
      rulesVersion: 3,
      bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }],
      ...settingsOver
    }
  };
}

let mock = null;
let srv = null;
const readDb = () => JSON.parse(fs.readFileSync(DB, "utf8"));

async function waitHttp() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error("server ko'tarilmadi");
}
function startServer() {
  srv = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
      TELEGRAM_BOT_TOKEN: "TESTTOKEN",
      ADMIN_PASSWORD: "testpass",
      DATA_FILE: DB,
      KEEP_ALIVE: "0",
      MAINTENANCE_SEC: "3600",
      BOT_START_RETRY_SEC: "600"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  srv.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv] " + d));
  srv.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv:err] " + d));
}
async function stopServer() {
  if (!srv) return;
  srv.kill("SIGTERM");
  await sleep(900);
  srv = null;
}
const msg = (id, text) => ({
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    from: { id, is_bot: false, first_name: "U" + id, username: "u" + id, language_code: "uz" },
    chat: { id, type: "private" },
    date: Math.floor(Date.now() / 1e3),
    text
  }
});
function push(u) {
  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8") || "[]");
  inbox.push(u);
  fs.writeFileSync(INBOX, JSON.stringify(inbox));
}
async function waitDb(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn(readDb())) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function main() {
  fs.writeFileSync(DB, JSON.stringify(seedState({ creditRewardSignup: 100, creditRewardChannelLink: 10 })));
  fs.writeFileSync(STATE, JSON.stringify({ members: {}, chats: {} }));
  fs.writeFileSync(INBOX, "[]");
  fs.writeFileSync(OUT, "");
  fs.writeFileSync(CALLS, "");
  mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
    env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
    stdio: "ignore"
  });

  startServer();
  await waitHttp();
  await sleep(1200);

  let db = readDb();
  check("MIGRATSIYA: signup bonus 0 ga tushdi", db.settings.creditRewardSignup === 0, String(db.settings.creditRewardSignup));
  check("MIGRATSIYA: bonusRuleVersion = 2", db.settings.bonusRuleVersion === 2, String(db.settings.bonusRuleVersion));
  check("MIGRATSIYA: eski foydalanuvchi balansi O'ZGARMADI", db.users["9801"].credits.available === 100, String(db.users["9801"].credits.available));
  check("MIGRATSIYA: eski sovg'a jurnali saqlanib qoldi", db.transactions.some((t) => t.idempotencyKey === "signup:u-9801" && t.amount === 100));
  check("MIGRATSIYA: boshqa sozlamalar tegilmadi (creditRewardTelegram=10)", db.settings.creditRewardTelegram === 10);
  check("MIGRATSIYA: kanal bonusi saqlanib qoldi (10)", db.settings.creditRewardChannelLink === 10, String(db.settings.creditRewardChannelLink));

  // Eski foydalanuvchi qayta /start qiladi — balans o'zgarmaydi.
  push(msg(9801, "/start"));
  await sleep(1500);
  db = readDb();
  check("MIGRATSIYA: eski foydalanuvchida yangi sovg'a yo'q", db.users["9801"].credits.available === 100, String(db.users["9801"].credits.available));
  check("MIGRATSIYA: takroriy signup yozuvi yo'q", db.transactions.filter((t) => t.type === "signup_bonus").length === 1);

  // Yangi foydalanuvchi — sovg'a berilmaydi (qoida o'chirilgan).
  push(msg(9802, "/start"));
  check("MIGRATSIYA: yangi foydalanuvchi 0 kredit", await waitDb((d) => d.users["9802"] && d.users["9802"].credits.available === 0));
  await sleep(800);
  db = readDb();
  check("MIGRATSIYA: yangi foydalanuvchida signup yozuvi yo'q",
    !db.transactions.some((t) => t.type === "signup_bonus" && t.userId === "u-9802"));

  // Restart — migratsiya qayta qo'llanmaydi va hech narsa o'zgarmaydi.
  await stopServer();
  startServer();
  await waitHttp();
  await sleep(1200);
  db = readDb();
  check("RESTART: sozlama 0 bo'lib qoldi", db.settings.creditRewardSignup === 0);
  check("RESTART: bonusRuleVersion saqlanib qoldi", db.settings.bonusRuleVersion === 2);
  check("RESTART: balanslar saqlanib qoldi", db.users["9801"].credits.available === 100);
  await stopServer();

  // Ikkinchi ssenariy: admin keyinchalik bonusni yoqdi (bonusRuleVersion = 2).
  fs.writeFileSync(DB, JSON.stringify(seedState({ creditRewardSignup: 50, bonusRuleVersion: 2, creditRewardChannelLink: 10 })));
  fs.writeFileSync(INBOX, "[]");
  startServer();
  await waitHttp();
  await sleep(1200);
  db = readDb();
  check("IDEMPOTENT: qayta migratsiya adminga tegilmagan qiymatni saqlaydi (50)", db.settings.creditRewardSignup === 50, String(db.settings.creditRewardSignup));

  await stopServer();
  try {
    mock.kill();
  } catch {}
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  try {
    srv && srv.kill("SIGTERM");
  } catch {}
  try {
    mock && mock.kill();
  } catch {}
  process.exit(1);
});
