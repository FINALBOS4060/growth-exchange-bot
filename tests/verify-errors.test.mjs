// A'zolik tekshiruvi nosozliklari uchun acceptance testlar (mock Telegram).
//
// Tekshiriladi (spec §7):
//  1. 429 + retry_after  — retry_after hurmat qilinadi, navbatga yoziladi.
//  2. 403                — bot huquqi yo'qolgani, obunadan chiqish emas.
//  3. 400                — noto'g'ri kanal, obunadan chiqish emas.
//  4. 500                — Telegram server xatosi, vaqtinchalik.
//  5. Tarmoq uzilishi / timeout — vaqtinchalik.
//  6. Bitta kanal yiqiladi, qolgan 9 tasi tekshiriladi va mukofot oladi.
//  7. Restartdan keyin CHECK_ERROR joblari yo'qolmaydi.
//  8. Qayta urinishlar mukofotni takrorlamaydi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3994;
const MOCK = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "data/verr-test-db.json";
const STATE = "data/verr-state.json";
const INBOX = "data/verr-inbox.json";
const OUT = "data/verr-out.log";
const CALLS = "data/verr-calls.log";

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
const lastText = (chat) => texts(chat).slice(-1)[0] || "";
const allText = (chat) => texts(chat).join("\n");

let seq = 8100;
const user = (telegramId, credits = 0) => ({
  id: "u-" + telegramId,
  telegramId,
  username: "u" + telegramId,
  displayName: "U" + telegramId,
  language: "uz",
  credits: { available: credits, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(),
  referralCode: "REF_" + telegramId,
  isReferralVerified: false,
  completedTasksCount: 0,
  activeOrdersCount: 0,
  status: "active",
  chatId: telegramId,
  botId: "bot-main",
  notifications: true,
  notif: { subscribers: true, referrals: true, orders: true, technical: true }
});

const channels = [];
const orders = [];
const tasks = [];
// member holatlari: "<chatId>|<telegramId>" → mock rejimi
const members = {};

function addTask(userTelegramId, channelTelegramId, mode, title) {
  const chId = "ch-" + channelTelegramId;
  if (!channels.some((c) => c.id === chId)) {
    channels.push({
      id: chId,
      channelId: String(channelTelegramId),
      title,
      username: "chan" + channelTelegramId,
      ownerId: "u-9900",
      ownerName: "Owner",
      botHasAdminRights: true,
      status: "active",
      verifiedSubscribers: 0,
      activeSubscribers: 0,
      pendingSubscriptions: 1,
      unsubscribedCount: 0,
      totalRequested: 1,
      totalRequestedCount: 1,
      controllers: [],
      createdAt: nowIso()
    });
  }
  const ordId = "ord-" + channelTelegramId;
  if (!orders.some((o) => o.id === ordId)) {
    orders.push({
      id: ordId,
      seq: orders.length + 1,
      userId: "u-9900",
      userName: "Owner",
      destinationId: chId,
      destinationTitle: title,
      platform: "telegram",
      requestedQuantity: 1,
      verifiedQuantity: 0,
      pendingQuantity: 1,
      cancelledQuantity: 0,
      unitCost: 1,
      totalCost: 1,
      freeUnits: 0,
      status: "active",
      createdAt: nowIso()
    });
  }
  const t = {
    id: "t-" + channelTelegramId + "-" + userTelegramId,
    assignedTo: "u-" + userTelegramId,
    orderId: ordId,
    destinationId: chId,
    destinationTitle: title,
    destinationUrl: "https://t.me/chan" + channelTelegramId,
    platform: "telegram",
    status: "PENDING",
    rewardCredits: 10,
    queueSequence: ++seq,
    createdAt: nowIso()
  };
  tasks.push(t);
  members[String(channelTelegramId) + "|" + String(userTelegramId)] = mode;
  // Bot har bir kanalda administrator bo'lishi shart — aks holda kanal
  // sog'liq tekshiruvi (channelHealthSweep) vazifalarni bekor qiladi.
  members[String(channelTelegramId) + "|777000"] = "administrator";
  return t;
}

// A. 429: 9 tasi member, 1 tasi rate:4
for (let i = 1; i <= 9; i++) addTask(9010, -2010 - i, "member", "Ch" + i);
addTask(9010, -2010, "rate:4", "RateLimit");
// B. doimiy xatolar
addTask(9011, -2021, "forbidden", "Forbidden");
addTask(9011, -2022, "badid", "BadId");
addTask(9011, -2023, "server", "ServerErr");
// C. tarmoq sathidagi xatolar
addTask(9012, -2031, "netfail", "NetFail");
addTask(9012, -2032, "html502", "Html502");
// D. timeout
addTask(9013, -2041, "slow", "Slow");
// E. spec §4: 9 ta member + 1 ta vaqtinchalik TARMOQ xatosi
for (let i = 1; i <= 9; i++) addTask(9014, -2050 - i, "member", "Ok" + i);
addTask(9014, -2050, "netfail", "NetDown");

const seed = {
  seq,
  users: { 9010: user(9010), 9011: user(9011), 9012: user(9012), 9013: user(9013), 9014: user(9014), 9900: user(9900, 0) },
  channels,
  igProfiles: [],
  orders,
  tasks,
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
    isInstagramEnabled: true,
    hourlyNotificationsEnabled: true,
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(STATE, JSON.stringify({ members, chats: {} }));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

const mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
  env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
  stdio: "inherit"
});

let srv;
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
      VERIFY_BATCH: "25",
      VERIFY_CONCURRENCY: "4",
      TG_CHECK_TIMEOUT_MS: "1200",
      MAINTENANCE_SEC: "2"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  srv.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv] " + d));
  srv.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv:err] " + d));
}
async function waitHttp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + "/healthz");
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  throw new Error("server ko'tarilmadi");
}
async function stopServer() {
  if (!srv) return;
  srv.kill();
  await sleep(700);
  srv = null;
}
function push(update) {
  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8") || "[]");
  inbox.push(update);
  fs.writeFileSync(INBOX, JSON.stringify(inbox));
}
const cb = (uid, data) => ({
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: uid, is_bot: false, first_name: "U" + uid, username: "u" + uid, language_code: "uz" },
    message: { message_id: 1, chat: { id: uid, type: "private" } },
    chat_instance: "1",
    data
  }
});
async function pressVerify(uid, wait = 2500) {
  push(cb(uid, "verify:tg"));
  await sleep(wait);
}
async function pressBtn(uid, data, wait = 1500) {
  push(cb(uid, data));
  await sleep(wait);
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function main() {
  startServer();
  await waitHttp();
  await sleep(600);

  /* ---------- 6. Bitta kanal yiqildi, qolgan 9 tasi tekshirildi ---------- */
  await pressVerify(9010, 3000);
  let db = readDb();
  const u1 = db.users["9010"];
  const batch = db.tasks.filter((t) => t.assignedTo === "u-9010");
  const verified = batch.filter((t) => t.status === "VERIFIED");
  const failed = db.tasks.find((t) => t.id === "t--2010-9010");
  check("Partiyada 9 ta vazifa tasdiqlandi", verified.length === 9, `verified=${verified.length}`);
  check("Muvaffaqiyatli vazifalar uchun mukofot berildi (9×10=90)", u1.credits.available === 90, `available=${u1.credits.available}`);
  check("Bitta kanal CHECK_ERROR holatida qoldi", !!failed && failed.lastCheckResult === "error", JSON.stringify(failed));
  check("Yiqilgan vazifa CHECK_ERROR sababi bilan saqlandi", failed && failed.lastCheckReason === "rate_limit", failed && failed.lastCheckReason);
  check("Xato obunadan chiqish deb belgilanmadi", !!failed && failed.status !== "CANCELLED", failed && failed.status);

  /* ---------- 1. 429 + retry_after ---------- */
  check("429: haqiqiy Telegram tavsifi saqlandi", failed && failed.lastCheckError && failed.lastCheckError.errorCode === 429, JSON.stringify(failed && failed.lastCheckError));
  check("429: retry_after saqlandi", failed && failed.lastCheckError && failed.lastCheckError.retryAfter === 4, JSON.stringify(failed && failed.lastCheckError));
  const job = db.verificationJobs.find((j) => j.jobType === "TASK_CHECK" && j.taskId === (failed && failed.id));
  check("429: doimiy qayta urinish jobi yaratildi", !!job, JSON.stringify(db.verificationJobs.filter((j) => j.jobType === "TASK_CHECK")));
  const delayMs = job && failed && failed.checkedAt ? Date.parse(job.scheduledAt) - Date.parse(failed.checkedAt) : 0;
  check("429: retry_after hurmat qilindi (≈4–6 s)", !!job && delayMs > 3000 && delayMs <= 7000, `delay=${delayMs}`);
  check("Foydalanuvchiga 'qayta tekshiruv saqlandi' deyildi", /qayta tekshiruv saqlandi/.test(allText(9010)), lastText(9010));
  check("Xabar sababni ko'rsatadi, umumiy matn emas", /Telegram vaqtincha javob bermadi/.test(allText(9010)), lastText(9010));

  /* ---------- 1b. Diagnostika jurnali ---------- */
  const errs = db.verifyErrors || [];
  const e429 = errs.find((e) => e.errorCode === 429);
  check("Diagnostika: method saqlandi", !!e429 && e429.method === "getChatMember", JSON.stringify(e429));
  check("Diagnostika: chat_id saqlandi", !!e429 && e429.chatId === "-2010", e429 && e429.chatId);
  check("Diagnostika: user_id saqlandi", !!e429 && e429.userId === "9010", e429 && e429.userId);
  check("Diagnostika: task_id saqlandi", !!e429 && !!e429.taskId, e429 && e429.taskId);
  check("Diagnostika: description umumiy matn bilan almashtirilmadi", !!e429 && /retry after/i.test(e429.description), e429 && e429.description);

  /* ---------- 7. Restartdan keyin job yo'qolmaydi ---------- */
  const jobIdBefore = job && job.id;
  await stopServer();
  db = readDb();
  const afterRestart = db.verificationJobs.find((j) => j.id === jobIdBefore);
  check("Restartdan keyin qayta urinish jobi bazada qoldi", !!afterRestart && afterRestart.status === "PENDING", JSON.stringify(afterRestart));
  startServer();
  await waitHttp();
  await sleep(700);

  /* ---------- 8. Retry muvaffaqiyatli tugadi, mukofot ikki marta emas ---------- */
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  st.members["-2010|9010"] = "member";
  fs.writeFileSync(STATE, JSON.stringify(st));
  const okRetry = await waitFor(() => {
    const d = readDb();
    const t = d.tasks.find((x) => x.id === (failed && failed.id));
    return t && t.status === "VERIFIED";
  }, 20000);
  db = readDb();
  check("Qayta urinish o'zi bajarildi (foydalanuvchi bosishisiz)", okRetry);
  check("Qayta urinishdan keyin balans 100 bo'ldi", db.users["9010"].credits.available === 100, `available=${db.users["9010"].credits.available}`);
  const rewardTx = db.transactions.filter((t) => t.idempotencyKey === "reward:" + (failed && failed.id));
  check("Mukofot takrorlanmadi (bitta tranzaksiya)", rewardTx.length === 1, `count=${rewardTx.length}`);
  await pressVerify(9010, 2000);
  db = readDb();
  check("Qo'shimcha bosishdan keyin ham balans 100", db.users["9010"].credits.available === 100, `available=${db.users["9010"].credits.available}`);

  /* ---------- 2/3/4. 403, 400, 500 ---------- */
  await pressVerify(9011, 3000);
  db = readDb();
  const t403 = db.tasks.find((t) => t.id === "t--2021-9011");
  const t400 = db.tasks.find((t) => t.id === "t--2022-9011");
  const t500 = db.tasks.find((t) => t.id === "t--2023-9011");
  check("403: errKind=blocked saqlandi", !!t403 && t403.lastCheckReason === "blocked", t403 && t403.lastCheckReason);
  check("403: xato kodi 403 saqlandi", !!t403 && t403.lastCheckError && t403.lastCheckError.errorCode === 403, JSON.stringify(t403 && t403.lastCheckError));
  check("400: errKind=bad_request saqlandi", !!t400 && t400.lastCheckReason === "bad_request", t400 && t400.lastCheckReason);
  check("500: errKind=server saqlandi", !!t500 && t500.lastCheckReason === "server", t500 && t500.lastCheckReason);
  check("500: HTTP holati saqlandi", !!t500 && t500.lastCheckError && t500.lastCheckError.httpStatus === 500, JSON.stringify(t500 && t500.lastCheckError));
  check("403/400/500 vazifalari obunadan chiqish deb belgilanmadi", [t403, t400, t500].every((t) => t && t.status !== "CANCELLED"));
  check("Doimiy xatolar uchun sabab aniq ko'rsatildi", /bot kanaldan chiqarilgan yoki bloklangan/.test(allText(9011)), lastText(9011));
  check("Vaqtinchalik xato uchun 'Telegram vaqtincha' deyildi", /Telegram vaqtincha javob bermadi/.test(allText(9011)), lastText(9011));
  const u2 = db.users["9011"];
  check("403/400/500 uchun kredit berilmadi", u2.credits.available === 0, `available=${u2.credits.available}`);

  /* ---------- 5. Tarmoq uzilishi va 502 HTML ---------- */
  await pressVerify(9012, 4000);
  db = readDb();
  const tNet = db.tasks.find((t) => t.id === "t--2031-9012");
  const tHtml = db.tasks.find((t) => t.id === "t--2032-9012");
  check("Tarmoq uzilishi vaqtinchalik deb tasniflandi", !!tNet && ["network", "network_timeout"].includes(tNet.lastCheckReason), tNet && tNet.lastCheckReason);
  check("502 HTML javobi HTTP holati bilan saqlandi", !!tHtml && tHtml.lastCheckError && tHtml.lastCheckError.httpStatus === 502, JSON.stringify(tHtml && tHtml.lastCheckError));
  check("502 HTML javobi 'server' xatosi deb tasniflandi", !!tHtml && tHtml.lastCheckReason === "server", tHtml && tHtml.lastCheckReason);
  check("Tarmoq xatosi ham navbatga yozildi", db.verificationJobs.filter((j) => j.jobType === "TASK_CHECK" && j.status === "PENDING").length >= 2, "job yo'q");

  /* ---------- 5b. Timeout ---------- */
  await pressVerify(9013, 5000);
  db = readDb();
  const tSlow = db.tasks.find((t) => t.id === "t--2041-9013");
  check("Timeout vaqtinchalik deb tasniflandi", !!tSlow && tSlow.lastCheckReason === "network_timeout", tSlow && tSlow.lastCheckReason);
  check("Timeout obunadan chiqish emas", !!tSlow && tSlow.status !== "CANCELLED", tSlow && tSlow.status);

  /* ---------- 4. 9 member + 1 vaqtinchalik tarmoq xatosi (spec §4) ---------- */
  await pressVerify(9014, 3500);
  db = readDb();
  const b14 = db.tasks.filter((t) => t.assignedTo === "u-9014");
  const ok14 = b14.filter((t) => t.status === "VERIFIED");
  const bad14 = db.tasks.find((t) => t.id === "t--2050-9014");
  check("[§4] 9 ta vazifa tasdiqlandi", ok14.length === 9, `verified=${ok14.length}`);
  check("[§4] 9 ta mukofot bir martadan berildi", ok14.every((t) => db.transactions.filter((x) => x.idempotencyKey === "reward:" + t.id).length === 1));
  check("[§4] Balans 90 kredit", db.users["9014"].credits.available === 90, `available=${db.users["9014"].credits.available}`);
  check("[§4] Bitta vazifa CHECK_ERROR", !!bad14 && bad14.status === "CHECK_ERROR", bad14 && bad14.status);
  check("[§4] Aynan bitta doimiy qayta urinish jobi", db.verificationJobs.filter((j) => j.jobType === "TASK_CHECK" && j.taskId === "t--2050-9014").length === 1, JSON.stringify(db.verificationJobs.filter((j) => j.jobType === "TASK_CHECK" && j.taskId === "t--2050-9014")));
  check("[§4] Xato obunadan chiqish deb belgilanmadi", !!bad14 && bad14.status !== "CANCELLED");
  check("[§4] Shu kanal uchun ikkinchi vazifa yaratilmadi", db.tasks.filter((t) => t.assignedTo === "u-9014" && t.destinationId === "ch--2050").length === 1);
  await pressBtn(9014, "tasks:tg", 1800);
  check("[§4] Xato olgan kanal FIFO ro'yxatida qayta ko'rsatilmadi", !/NetDown/.test(lastText(9014)), lastText(9014));

  await stopServer();
  mock.kill();
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failedCount}/${results.length} PASS ===`);
  process.exit(failedCount ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  try {
    srv && srv.kill();
  } catch {}
  try {
    mock.kill();
  } catch {}
  process.exit(1);
});
