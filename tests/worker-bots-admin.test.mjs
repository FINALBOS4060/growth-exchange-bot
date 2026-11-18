// Ishchi botlar ham asosiy bot kabi adminlik tekshiruvini bajarishi (spec §1).
//
// Tekshiriladi:
//  1. Kanal qo'shilganda BARCHA yoqilgan botlar (asosiy + ishchi) o'z tokeni va
//     o'z `botId` si bilan tekshiriladi; natija `channel.botAdmins` ga yoziladi.
//  2. Ishchi bot admin bo'lmasa — egasiga MA'LUMOT sifatida ogohlantiriladi
//     («kamida bitta bot yetarli» qoidasi), kanal ishlayveradi.
//  3. Kamida bitta bot (bu yerda asosiy) admin bo'lsa — buyurtma yaratiladi va
//     kredit bir marta band qilinadi.
//  4. 6 soatlik sweep har bir botni alohida tekshiradi va faqat HECH BIR bot
//     admin bo'lmaganda kanalni yopadi (tarix o'chmaydi).
//  5. Ishchi bot admin bo'lgach keyingi tekshiruv uni "ok" deb belgilaydi,
//     ro'yxat tozalanadi va buyurtma yana qabul qilinadi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3985;
const MOCK = 3986;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "data/wb-test-db.json";
const STATE = "data/wb-state.json";
const INBOX = "data/wb-inbox.json";
const OUT = "data/wb-out.log";
const CALLS = "data/wb-calls.log";

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
const lastText = (chat) => texts(chat).slice(-1)[0] || "";
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
function setMember(key, value) {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  st.members[key] = value;
  fs.writeFileSync(STATE, JSON.stringify(st));
}

const UID = 9001;
const OWNER = 9002;
const user = (id, tid, credits) => ({
  id, telegramId: tid, username: "u" + tid, displayName: "U" + tid, language: "uz",
  credits: { available: credits, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(), referralCode: "REF_" + tid, isReferralVerified: false,
  completedTasksCount: 0, activeOrdersCount: 0, status: "active", chatId: tid, botId: "bot-main",
  notifications: true, notif: { subscribers: true, referrals: true, orders: true, technical: true }
});

// Sweep sinovi uchun eski (6 soatdan ko'p) tekshirilgan kanal.
const OLD_AT = "2026-01-01T00:00:00.000Z";
const seed = {
  seq: 7000,
  users: { 9001: user("u-9001", UID, 500), 9002: user("u-9002", OWNER, 0) },
  channels: [{
    id: "ch-old", channelId: "-1099", title: "OldChannel", username: "oldchan",
    ownerId: "u-9001", ownerName: "U9001", botHasAdminRights: true, botAdminStatus: "ok",
    totalRequested: 0, verifiedSubscribers: 0, activeSubscribers: 0, unsubscribedCount: 0,
    pendingSubscriptions: 0, controllers: [], status: "active", createdAt: nowIso(),
    lastAdminCheckAt: OLD_AT
  }],
  igProfiles: [], orders: [], tasks: [], transactions: [], memberships: [], membershipEvents: [],
  verificationJobs: [], sponsorMemberships: [], notifPeriods: [], complaints: [], referrals: [],
  sponsors: [], ctlRequests: [], verifyLog: [], adminUsers: [], auditLog: [], appeals: [],
  moderationFlags: [], lastHour: 0,
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
  chats: { chan_ok: { id: -1006, title: "WorkerTest" } },
  members: {
    // Yangi kanal: asosiy bot admin, ishchi bot kanalda yo'q.
    "-1006|777000": "administrator",
    "-1006|777001": "left",
    "-1006|9001": "creator",
    // Eski kanal: asosiy bot admin, ishchi bot admin emas.
    "-1099|777000": "administrator",
    "-1099|777001": "left",
    "-1099|9001": "creator"
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
    from: { id: UID, is_bot: false, first_name: "U9001", username: "u9001", language_code: "uz" },
    chat: { id: UID, type: "private" }, date: Math.floor(Date.now() / 1e3), text
  }
});
const cb = (data) => ({
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: UID, is_bot: false, first_name: "U9001", username: "u9001", language_code: "uz" },
    message: { message_id: 1, chat: { id: UID, type: "private" } }, chat_instance: "1", data
  }
});
const say = async (t, w = 1200) => { push(msg(t)); await sleep(w); };
const click = async (d, w = 1000) => { push(cb(d)); await sleep(w); };

async function main() {
  await waitHttp();
  await say("/start", 1500);

  /* ---------- 1. Kanal qo'shish: ikkala bot tekshiriladi ---------- */
  await click("chadd", 500);
  await say("@chan_ok", 2500);
  const db1 = readDb();
  const ch = db1.channels.find((c) => c.channelId === "-1006");
  check("kanal qo'shildi (asosiy bot admin)", !!ch && ch.status === "active", JSON.stringify(ch && ch.status));
  check("asosiy bot natijasi saqlandi", !!ch && ch.botAdmins && ch.botAdmins["bot-main"] && ch.botAdmins["bot-main"].ok === true,
    JSON.stringify(ch && ch.botAdmins));
  check("ishchi bot ham tekshirildi", !!ch && ch.botAdmins && !!ch.botAdmins["bot-worker"], JSON.stringify(ch && ch.botAdmins));
  check("ishchi bot 'admin emas' deb belgilandi", !!ch && ch.botAdmins["bot-worker"].ok === false && ch.botAdmins["bot-worker"].botId === 777001,
    JSON.stringify(ch && ch.botAdmins["bot-worker"]));
  check("ro'yxatda ishchi bot ko'rsatildi", !!ch && (ch.botsMissingAdmin || []).some((l) => /worker_bot/.test(l)),
    JSON.stringify(ch && ch.botsMissingAdmin));
  check("kanal ishlatadigan bot — asosiy bot", !!ch && ch.botAdminBotId === "bot-main", ch && ch.botAdminBotId);
  check("egasiga ogohlantirish berildi", /bo‘lmagan botlar|blogan botlar/i.test(allText(UID)) || /worker_bot/.test(allText(UID)),
    lastText(UID));

  /* ---------- 2. «Bitta bot yetarli»: asosiy bot admin → buyurtma yaratiladi ---------- */
  const cid = ch.id;
  const before = readDb().users["9001"].credits.available;
  await click("ord:" + cid, 800);
  await say("50", 900);
  await click("ordok:" + (readDb().users["9001"].state || {}).token, 2200);
  const db2 = readDb();
  const ord1 = db2.orders.find((o) => o.destinationId === cid);
  check("bitta (asosiy) bot yetarli — buyurtma yaratildi", !!ord1 && ord1.status === "active",
    JSON.stringify(db2.orders.map((o) => o.status)));
  check("kredit bir marta band qilindi",
    db2.users["9001"].credits.available === before - 50 && db2.users["9001"].credits.reserved === 50,
    `available ${before} → ${db2.users["9001"].credits.available}, reserved ${db2.users["9001"].credits.reserved}`);
  check("buyurtma rad etilmadi (ishchi botning admin emasligi bloklamaydi)",
    !/Buyurtma yaratilmadi/.test(allText(UID)), lastText(UID));

  /* ---------- 3. 6 soatlik sweep: har bir bot alohida ---------- */
  const swept = await waitDb(() => {
    const c = readDb().channels.find((x) => x.id === "ch-old");
    return c && c.lastAdminCheckAt && c.lastAdminCheckAt !== OLD_AT && c.botAdmins && c.botAdmins["bot-worker"];
  });
  const oldCh = readDb().channels.find((c) => c.id === "ch-old");
  check("sweep har bir botni tekshirdi", swept, JSON.stringify(oldCh && oldCh.botAdmins));
  check("sweep: asosiy bot ok", !!oldCh && oldCh.botAdmins["bot-main"].ok === true, JSON.stringify(oldCh && oldCh.botAdmins));
  check("sweep: ishchi bot admin emas", !!oldCh && oldCh.botAdmins["bot-worker"].ok === false, JSON.stringify(oldCh && oldCh.botAdmins));
  check("sweep: kanal yopilmadi (asosiy bot ishlayapti)",
    !!oldCh && oldCh.status === "active" && oldCh.botHasAdminRights === true, oldCh && oldCh.status);
  check("sweep: egasiga bir marta texnik xabar yuborildi",
    /worker_bot/.test(allText(UID)) || /bo‘lmagan botlar/.test(allText(UID)), lastText(UID));

  /* ---------- 4. Ishchi bot qo'shildi → keyingi tekshiruv ok ---------- */
  setMember("-1006|777001", "administrator");
  await click("ord:" + cid, 800);
  await say("50", 900);
  await click("ordok:" + (readDb().users["9001"].state || {}).token, 2500);
  const db3 = readDb();
  const ch3 = db3.channels.find((c) => c.id === cid);
  check("ishchi bot admin bo'lgach recheck ok", !!ch3 && ch3.botAdmins["bot-worker"].ok === true,
    JSON.stringify(ch3 && ch3.botAdmins));
  check("ro'yxat tozalandi", !!ch3 && (ch3.botsMissingAdmin || []).length === 0, JSON.stringify(ch3 && ch3.botsMissingAdmin));
  const ords = db3.orders.filter((o) => o.destinationId === cid);
  check("buyurtma yaratildi", ords.length === 2 && ords.every((o) => o.status === "active"),
    JSON.stringify(ords.map((o) => o.status)));
  check("kredit ikkinchi marta ham bir marta band qilindi",
    db3.users["9001"].credits.reserved === 100 && db3.users["9001"].credits.available === before - 100,
    `available ${db3.users["9001"].credits.available}, reserved ${db3.users["9001"].credits.reserved}`);
  check("har bir buyurtma uchun bitta reservation yozuvi",
    ords.length === 2 && ords.every((o) => db3.transactions.filter((t) => t.type === "order_spend" && t.orderId === o.id && t.amount === -50).length === 1),
    JSON.stringify(db3.transactions.map((t) => t.type + ":" + t.orderId)));
  check("kanal ishlatadigan bot tasdiqlangan botlardan biri",
    !!ch3 && [ch3.botAdminBotId === "bot-main", ch3.botAdminBotId === "bot-worker"].includes(true), ch3 && ch3.botAdminBotId);

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
