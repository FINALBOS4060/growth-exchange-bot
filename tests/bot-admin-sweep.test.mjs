// Kanal huquqi bo'yicha REGRESSION (spec §4 + §10–§11):
//  1. Bitta bot API_ERROR, qolganlari NOT_ADMIN → kanal ACTIVE bo'lib qolmaydi.
//  2. Barcha botlar API_ERROR → xulosa chiqarilmaydi, kanal yopilmaydi.
//  3. Kamida bitta VERIFIED_ADMIN → kanal active va buyurtma yaratiladi.
//  4. Huquq yo'qolgan kanalga buyurtma yaratilmaydi, kredit band qilinmaydi.
//  5. Huquq tiklansa — keyingi sweep kanalni qayta `active` qiladi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3993;
const MOCK = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "data/bsw-test-db.json";
const STATE = "data/bsw-state.json";
const INBOX = "data/bsw-inbox.json";
const OUT = "data/bsw-out.log";
const CALLS = "data/bsw-calls.log";

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
const allText = (chat) => outLines().filter((r) => String(r.chat) === String(chat)).map((r) => String(r.text || "")).join("\n");
const lastText = (chat) => outLines().filter((r) => String(r.chat) === String(chat)).slice(-1)[0]?.text || "";
async function waitDb(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

const UID = 9301;
const user = (id, tid, credits) => ({
  id, telegramId: tid, username: "u" + tid, displayName: "U" + tid, language: "uz",
  credits: { available: credits, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(), referralCode: "REF_" + tid, isReferralVerified: false,
  completedTasksCount: 0, activeOrdersCount: 0, status: "active", chatId: tid, botId: "bot-main",
  notifications: true, notif: { subscribers: true, referrals: true, orders: true, technical: true }
});
const OLD = "2026-01-01T00:00:00.000Z";
const chan = (id, cid, title, username) => ({
  id, channelId: cid, title, username, ownerId: "u-9301", ownerName: "U9301",
  botHasAdminRights: true, botAdminStatus: "ok", totalRequested: 0, verifiedSubscribers: 0,
  activeSubscribers: 0, unsubscribedCount: 0, pendingSubscriptions: 0, controllers: [],
  status: "active", createdAt: nowIso(), lastAdminCheckAt: OLD
});
const seed = {
  seq: 9300,
  users: { 9301: user("u-9301", UID, 500) },
  channels: [
    chan("ch-sweep1", "-3201", "Mixed", "mixed_chan"),
    chan("ch-sweep2", "-3202", "AllErrors", "allerr_chan"),
    chan("ch-sweep3", "-3203", "Healthy", "healthy_chan")
  ],
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
      { id: "bot-worker1", token: "WORKERTOKEN1", role: "worker", enabled: true, username: "worker_one", displayName: "W1", offset: 0 },
      { id: "bot-worker2", token: "WORKERTOKEN2", role: "worker", enabled: true, username: "worker_two", displayName: "W2", offset: 0 }
    ]
  }
};
fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(OUT, "");
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(CALLS, "");
fs.writeFileSync(STATE, JSON.stringify({
  chats: {
    mixed_chan: { id: -3201, title: "Mixed" },
    allerr_chan: { id: -3202, title: "AllErrors" },
    healthy_chan: { id: -3203, title: "Healthy" }
  },
  members: {},
  botMembers: {
    // -3201: 1 bot API_ERROR + 2 bot NOT_ADMIN → xulosa: huquq yo'q.
    // -3202: barcha botlar API xatosida → xulosa yo'q.
    // -3203: asosiy bot admin → sog'lom kanal.
    "777000": {
      "-3201|777000": "server",
      "-3202|777000": "server",
      "-3203|777000": "administrator"
    },
    "777001": { "-3201|777001": "left", "-3202|777001": "timeout" },
    "777002": { "-3201|777002": "left", "-3202|777002": "server" }
  }
}));

const mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
  env: {
    ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX,
    MOCK_OUT: OUT, MOCK_CALLS: CALLS,
    MOCK_BOT_ID_MAP: JSON.stringify({
      WORKERTOKEN1: { id: 777001, username: "worker_one" },
      WORKERTOKEN2: { id: 777002, username: "worker_two" }
    })
  },
  stdio: "ignore"
});
const srv = spawn("node", ["server.js"], {
  env: {
    ...process.env, PORT: String(PORT), TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", ADMIN_PASSWORD: "testpass", DATA_FILE: DB,
    KEEP_ALIVE: "0", MAINTENANCE_SEC: "2", VERIFY_BATCH: "25"
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
const msg = (text) => ({
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    from: { id: UID, is_bot: false, first_name: "U9301", username: "u9301", language_code: "uz" },
    chat: { id: UID, type: "private" }, date: Math.floor(Date.now() / 1e3), text
  }
});
const cb = (data) => ({
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: UID, is_bot: false, first_name: "U9301", username: "u9301", language_code: "uz" },
    message: { message_id: 1, chat: { id: UID } }, chat_instance: "1", data
  }
});
const say = async (t, w = 1200) => { push(msg(t)); await sleep(w); };
const click = async (d, w = 1000) => { push(cb(d)); await sleep(w); };
const chById = (id) => readDb().channels.find((c) => c.id === id);

async function main() {
  await waitHttp();
  await say("/start", 1800);

  /* ---------- 1. Sweep: 1 API_ERROR + 2 NOT_ADMIN → permission_lost ---------- */
  const lost = await waitDb(() => {
    const c = chById("ch-sweep1");
    return c && c.status === "permission_lost";
  });
  const c1 = chById("ch-sweep1");
  check("API_ERROR boshqa botlarning natijasini yashirmadi (sweep → permission_lost)", lost,
    JSON.stringify({ status: c1.status, bots: c1.botAdmins }));
  check("kanal botHasAdminRights=false", c1.botHasAdminRights === false);
  check("kanal holati bot_not_admin", c1.botAdminStatus === "bot_not_admin", c1.botAdminStatus);
  check("API xatoli bot snapshot'da api_error", c1.botAdmins["bot-main"].status === "api_error",
    JSON.stringify(c1.botAdmins["bot-main"]));
  check("NOT_ADMIN botlar snapshot'da bot_not_admin", c1.botAdmins["bot-worker1"].status === "bot_not_admin",
    JSON.stringify(c1.botAdmins["bot-worker1"]));

  /* ---------- 2. Hammasi API_ERROR → xulosa yo'q ---------- */
  await sleep(1200);
  const c2 = chById("ch-sweep2");
  check("barcha bot API xatosida → kanal active qoladi", c2.status === "active" && c2.botHasAdminRights === true,
    JSON.stringify({ status: c2.status, ok: c2.botHasAdminRights }));
  check("barcha bot API xatosida → botAdminStatus o'zgarmadi", c2.botAdminStatus === "ok", c2.botAdminStatus);

  /* ---------- 3. Sog'lom kanal active ---------- */
  const c3 = chById("ch-sweep3");
  check("kamida bitta VERIFIED_ADMIN → kanal active", c3.status === "active" && c3.botHasAdminRights === true);

  /* ---------- 4. Huquq yo'q kanalga buyurtma yaratilmaydi ---------- */
  const before = readDb().users["9301"].credits.available;
  await click("ord:ch-sweep1", 800);
  await say("10", 900);
  const tok1 = (readDb().users["9301"].state || {}).token;
  if (tok1) await click("ordok:" + tok1, 2300);
  const db4 = readDb();
  check("permission_lost kanalga buyurtma yaratilmadi",
    db4.orders.filter((o) => o.destinationId === "ch-sweep1").length === 0,
    JSON.stringify(db4.orders.map((o) => o.destinationId)));
  check("kredit band qilinmadi", db4.users["9301"].credits.available === before && db4.users["9301"].credits.reserved === 0,
    `available=${db4.users["9301"].credits.available}, reserved=${db4.users["9301"].credits.reserved}`);
  check("sabab tushuntirildi", /administrator|huquq/i.test(lastText(UID)), lastText(UID));

  /* ---------- 5. VERIFIED_ADMIN kanalga buyurtma yaratiladi ---------- */
  await click("ord:ch-sweep3", 900);
  await say("10", 900);
  const tok3 = (readDb().users["9301"].state || {}).token;
  await click("ordok:" + tok3, 2500);
  const db5 = readDb();
  const ord = db5.orders.find((o) => o.destinationId === "ch-sweep3");
  check("VERIFIED_ADMIN kanalga buyurtma yaratildi", !!ord && ord.status === "active",
    JSON.stringify(db5.orders.map((o) => o.status)));
  check("kredit bir marta band qilindi", db5.users["9301"].credits.reserved === 10 &&
    db5.users["9301"].credits.available === before - 10,
    `available=${db5.users["9301"].credits.available}, reserved=${db5.users["9301"].credits.reserved}`);

  /* ---------- 6. Huquq tiklandi → keyingi tekshiruv kanalni active qiladi ---------- */
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  st.botMembers["777001"]["-3201|777001"] = "administrator";
  fs.writeFileSync(STATE, JSON.stringify(st));
  await sleep(400);
  await click("ord:ch-sweep1", 900);
  await say("10", 900);
  const tokR = (readDb().users["9301"].state || {}).token;
  if (tokR) await click("ordok:" + tokR, 2500);
  const c6 = chById("ch-sweep1");
  check("huquq tiklansa kanal qayta active bo'ldi", c6.status === "active" && c6.botHasAdminRights === true,
    JSON.stringify({ s: c6.status, ok: c6.botHasAdminRights }));
  check("tiklangan kanalda botAdminBotId ishchi bot", c6.botAdminBotId === "bot-worker1", c6.botAdminBotId);
  check("tiklangan kanalga buyurtma qabul qilindi",
    readDb().orders.some((o) => o.destinationId === "ch-sweep1"),
    JSON.stringify(readDb().orders.map((o) => o.destinationId)));

  srv.stdout.removeAllListeners();
  srv.stderr.removeAllListeners();
  srv.kill();
  mock.kill();
  await sleep(600);
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
