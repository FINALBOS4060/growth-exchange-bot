// «BITTA BOT YETARLI» qoidasi (spec §1).
//
// 1. Kanal ulash: asosiy bot admin EMAS, ishchi bot admin — kanal baribir
//    ulanadi va `active` bo'ladi.
// 2. Buyurtma yaratish shu kanal uchun ishlaydi (ishchi bot orqali).
// 3. A'zolik tekshiruvi: xabarni admin BO'LMAGAN bot qabul qilsa, tekshiruv
//    avtomatik admin bo'lgan boshqa botga o'tadi va obuna VERIFIED bo'ladi —
//    ya'ni foydalanuvchi "tekshirib bo'lmadi" xatosini ko'rmaydi.
// 4. Hech bir bot admin bo'lmasa — buyurtma yaratilmaydi va kredit band
//    qilinmaydi (qoida bo'shashmagan).
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3987;
const MOCK = 3988;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "data/anybot-test-db.json";
const STATE = "data/anybot-state.json";
const INBOX = "data/anybot-inbox.json";
const OUT = "data/anybot-out.log";
const CALLS = "data/anybot-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const readDb = () => JSON.parse(fs.readFileSync(DB, "utf8"));
const outLines = () => {
  try {
    return fs.readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const texts = (chat) => outLines().filter((r) => String(r.chat) === String(chat)).map((r) => String(r.text || ""));
const allText = (chat) => texts(chat).join("\n");
const callLog = () => {
  try {
    return fs.readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
async function waitDb(fn, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

const UID = 9101;
const OWNER = 9102;
const user = (id, tid, credits) => ({
  id, telegramId: tid, username: "u" + tid, displayName: "U" + tid, language: "uz",
  credits: { available: credits, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(), referralCode: "REF_" + tid, isReferralVerified: false,
  completedTasksCount: 0, activeOrdersCount: 0, status: "active", chatId: tid, botId: "bot-main",
  notifications: true, notif: { subscribers: true, referrals: true, orders: true, technical: true }
});

const seed = {
  seq: 8100,
  users: { 9101: user("u-9101", UID, 500), 9102: user("u-9102", OWNER, 0) },
  channels: [{
    id: "ch-v", channelId: "-2001", title: "AdminOnlyWorker", username: "adminonlyworker",
    ownerId: "u-9102", ownerName: "U9102", botHasAdminRights: true, botAdminStatus: "ok",
    totalRequested: 10, verifiedSubscribers: 0, activeSubscribers: 0, unsubscribedCount: 0,
    pendingSubscriptions: 1, controllers: [], status: "active", createdAt: nowIso()
  }],
  igProfiles: [],
  orders: [{
    id: "ord-v", seq: 1, userId: "u-9102", userName: "U9102", destinationId: "ch-v", destinationTitle: "AdminOnlyWorker",
    platform: "telegram", requestedQuantity: 10, verifiedQuantity: 0, pendingQuantity: 10, cancelledQuantity: 0,
    unitCost: 1, totalCost: 10, freeUnits: 0, status: "active", createdAt: nowIso()
  }],
  tasks: [{
    id: "t-v", assignedTo: "u-9101", orderId: "ord-v", destinationId: "ch-v", destinationTitle: "AdminOnlyWorker",
    destinationUrl: "https://t.me/adminonlyworker", platform: "telegram", status: "PENDING", rewardCredits: 100,
    queueSequence: 1, createdAt: nowIso()
  }],
  transactions: [
    { id: "tx-1", userId: "u-9101", amount: 500, type: "admin_adjustment", idempotencyKey: "seed:9101", balanceAfter: 500 }
  ],
  memberships: [], membershipEvents: [], verificationJobs: [], verifyErrors: [],
  sponsorMemberships: [], notifPeriods: [], complaints: [], referrals: [], sponsors: [],
  ctlRequests: [], verifyLog: [], adminUsers: [], auditLog: [], appeals: [], moderationFlags: [], lastHour: 0,
  settings: {
    creditRewardTelegram: 100, creditRewardInstagram: 0, creditRewardInstagramSelfConfirmed: 0,
    creditRewardReferral: 0, creditRewardSignup: 0, creditRewardChannelLink: 0, creditPerSubscriber: 1,
    autoOrderCredits: false, isInstagramEnabled: true, hourlyNotificationsEnabled: false,
    bots: [
      { id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 },
      { id: "bot-worker", token: "WORKERTOKEN", role: "worker", enabled: true, username: "worker_bot", displayName: "Worker", offset: 0 }
    ]
  }
};
fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(OUT, "");
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(CALLS, "");
fs.writeFileSync(STATE, JSON.stringify({
  chats: {
    // -2001: asosiy bot admin emas, ishchi bot admin.
    only_worker: { id: -2002, title: "OnlyWorker" },
    // -2003: hech bir bot admin emas.
    nobody_admin: { id: -2003, title: "NobodyAdmin" }
  },
  members: {},
  botMembers: {
    // Asosiy bot (777000) kanalda admin emas → a'zolikni o'qiy olmaydi.
    "777000": {
      "-2001|777000": "no_rights", "-2001|9101": "no_rights",
      "-2002|777000": "no_rights", "-2002|9101": "no_rights",
      "-2003|777000": "no_rights", "-2003|9101": "no_rights"
    },
    // Ishchi bot (777001) admin: a'zolikni o'qiydi, kanal egasi/shikoyat huquqi bor.
    "777001": {
      "-2001|777001": "administrator", "-2001|9101": "member",
      "-2002|777001": "administrator", "-2002|9101": "creator",
      "-2003|777001": "left"
    }
  }
}));

const mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
  env: {
    ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX,
    MOCK_OUT: OUT, MOCK_CALLS: CALLS,
    MOCK_BOT_ID_MAP: JSON.stringify({ WORKERTOKEN: { id: 777001, username: "worker_bot" } })
  },
  stdio: "inherit"
});
const srv = spawn("node", ["server.js"], {
  env: {
    ...process.env, PORT: String(PORT), TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", ADMIN_PASSWORD: "testpass", DATA_FILE: DB,
    KEEP_ALIVE: "0", MAINTENANCE_SEC: "3600", VERIFY_BATCH: "25"
  },
  stdio: [process.env.SHOW_LOGS ? "inherit" : "ignore", "pipe", "pipe"]
});
srv.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv] " + d));
srv.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv:err] " + d));

async function waitHttp() {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(BASE + "/healthz")).ok) return true;
    } catch {}
    await sleep(300);
  }
  throw new Error("server ko'tarilmadi");
}
function push(update) {
  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8") || "[]");
  inbox.push(update);
  fs.writeFileSync(INBOX, JSON.stringify(inbox));
}
const msg = (text, bot) => ({
  _bot: bot,
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    from: { id: UID, is_bot: false, first_name: "U9101", username: "u9101", language_code: "uz" },
    chat: { id: UID, type: "private" }, date: Math.floor(Date.now() / 1e3), text
  }
});
const cb = (data, bot) => ({
  _bot: bot,
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: UID, is_bot: false, first_name: "U9101", username: "u9101", language_code: "uz" },
    message: { message_id: 1, chat: { id: UID, type: "private" } }, chat_instance: "1", data
  }
});

async function main() {
  await waitHttp();
  // Foydalanuvchi ADMIN BO'LMAGAN asosiy bot orqali ishlaydi.
  push(msg("/start", "TESTTOKEN"));
  await sleep(1500);

  /* ---------- 1. Faqat ishchi bot admin → obuna VERIFIED ---------- */
  push(cb("verify", "TESTTOKEN"));
  const verified = await waitDb(() => readDb().tasks.find((t) => t.id === "t-v").status === "VERIFIED");
  const db1 = readDb();
  const task = db1.tasks.find((t) => t.id === "t-v");
  check("asosiy bot admin emas, ishchi bot admin → obuna VERIFIED", verified, task && task.status);
  check("mukofot berildi (+100)", db1.users["9101"].credits.available === 600, String(db1.users["9101"].credits.available));
  check("CHECK_ERROR yozilmadi", !(db1.tasks || []).some((t) => t.status === "CHECK_ERROR"),
    JSON.stringify((db1.tasks || []).map((t) => t.status)));
  check("foydalanuvchiga xato ko'rsatilmadi", !/tekshirib bo‘lmadi|tekshirib bo'lmadi/i.test(allText(UID)), allText(UID).slice(-300));

  // Tekshiruv avval joriy (admin bo'lmagan) bot bilan urinib, keyin admin
  // bo'lgan botga o'tganini mock chaqiruvlaridan isbotlaymiz.
  const calls = callLog().filter((c) => c.key === "-2001|" + UID);
  check("joriy bot (777000) bilan urinildi", calls.some((c) => c.bot === "777000"), JSON.stringify(calls));
  check("keyin admin bot (777001) bilan tekshirildi", calls.some((c) => c.bot === "777001"), JSON.stringify(calls));
  check("tartib: avval 777000, keyin 777001",
    calls.length >= 2 && calls.findIndex((c) => c.bot === "777000") < calls.findIndex((c) => c.bot === "777001"),
    JSON.stringify(calls));

  /* ---------- 2. Kanal ulash: faqat ishchi bot admin ---------- */
  push(msg("/start", "TESTTOKEN"));
  await sleep(800);
  push(cb("chadd", "TESTTOKEN"));
  await sleep(500);
  push(msg("@only_worker", "TESTTOKEN"));
  const added = await waitDb(() => (readDb().channels || []).some((c) => c.channelId === "-2002"));
  const ch = readDb().channels.find((c) => c.channelId === "-2002") || {};
  check("ishchi bot admin bo'lsa kanal ulanadi", added, JSON.stringify(ch && ch.status));
  check("kanal active", !!ch && ch.status === "active", ch && ch.status);
  check("asosiy bot 'admin emas' deb saqlandi", !!ch && ch.botAdmins["bot-main"].ok === false, JSON.stringify(ch && ch.botAdmins));
  check("ishchi bot ok", !!ch && ch.botAdmins["bot-worker"].ok === true, JSON.stringify(ch && ch.botAdmins));
  check("kanal ishlatadigan bot — ishchi bot", !!ch && ch.botAdminBotId === "bot-worker", ch && ch.botAdminBotId);
  check("ogohlantirish ma'lumot sifatida berildi", /test_bot/i.test(allText(UID)), allText(UID).slice(-200));

  /* ---------- 3. Shu kanalga buyurtma yaratiladi ---------- */
  const before = readDb().users["9101"].credits.available;
  push(cb("ord:" + ch.id, "TESTTOKEN"));
  await sleep(800);
  push(msg("50", "TESTTOKEN"));
  await sleep(900);
  const token = (readDb().users["9101"].state || {}).token;
  push(cb("ordok:" + token, "TESTTOKEN"));
  const ordered = await waitDb(() => readdbOrder(ch.id));
  const db3 = readDb();
  function readdbOrder(destId) {
    return (readDb().orders || []).some((o) => o.destinationId === destId);
  }
  check("bitta (ishchi) bot yetarli — buyurtma yaratildi", ordered,
    JSON.stringify((db3.orders || []).map((o) => o.destinationId)));
  check("kredit band qilindi (50)", db3.users["9101"].credits.reserved === 50 && db3.users["9101"].credits.available === before - 50,
    `available ${before} → ${db3.users["9101"].credits.available}, reserved ${db3.users["9101"].credits.reserved}`);

  /* ---------- 4. Hech bir bot admin emas → bloklanadi ---------- */
  push(msg("/start", "TESTTOKEN"));
  await sleep(800);
  push(cb("chadd", "TESTTOKEN"));
  await sleep(500);
  push(msg("@nobody_admin", "TESTTOKEN"));
  await sleep(2500);
  const none = readDb().channels.find((c) => c.channelId === "-2003");
  check("hech bir bot admin emas → kanal ulanmadi", !none, JSON.stringify(none && none.status));
  check("foydalanuvchiga aniq sabab ko'rsatildi", /admin/i.test(allText(UID).slice(-400)), allText(UID).slice(-200));

  srv.kill();
  mock.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test halokati:", e);
  try { srv.kill(); } catch {}
  try { mock.kill(); } catch {}
  process.exit(1);
});
