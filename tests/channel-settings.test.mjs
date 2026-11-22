// Kanal administratorligini tekshirish va Sozlamalar menyusi uchun
// acceptance testlar (mock Telegram, real server jarayoni).
//
// Tekshiriladi:
//  A. Kanal qo'shishda 5 xil nosozlik ALOHIDA ajratiladi:
//     bot admin emas / huquq yetarli emas / kanal ochilmadi / sizda huquq yo'q /
//     vaqtinchalik API xatosi — va muvaffaqiyatli holat.
//  B. Buyurtma yaratishdan oldin kanal huquqi qayta tekshiriladi (kredit band qilinmaydi).
//  C. Sozlamalar submenyusi: bildirishnomalar, xavfsizlik, Telegram hisoblari,
//     orqaga / asosiy menyu, uch tilda.
//  D. Sozlamalar restartdan keyin saqlanadi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3996;
const MOCK = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "data/ch-test-db.json";
const STATE = "data/ch-state.json";
const INBOX = "data/ch-inbox.json";
const OUT = "data/ch-out.log";
const CALLS = "data/ch-calls.log";

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
const lastText = (chat) => {
  const rows = outLines().filter((r) => String(r.chat) === String(chat));
  return rows.length ? String(rows[rows.length - 1].text || "") : "";
};
const allText = (chat) => outLines().filter((r) => String(r.chat) === String(chat)).map((r) => String(r.text || "")).join("\n");
const lastKb = (chat) => {
  const rows = outLines().filter((r) => String(r.chat) === String(chat));
  return rows.length ? rows[rows.length - 1].kb : null;
};
const kbFlat = (kb) => JSON.stringify(kb || {});

const user = (id, name, credits) => ({
  id,
  telegramId: Number(id.slice(2)),
  username: name.toLowerCase(),
  displayName: name,
  language: "uz",
  credits: { available: credits, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(),
  referralCode: "REF_" + id,
  isReferralVerified: false,
  completedTasksCount: 0,
  activeOrdersCount: 0,
  status: "active",
  chatId: Number(id.slice(2)),
  botId: "bot-main",
  notifications: true,
  notif: { subscribers: true, referrals: true, orders: true, technical: true }
});

const seed = {
  seq: 7000,
  users: { 9001: user("u-9001", "Tester", 500) },
  channels: [
    {
      id: "ch-9",
      channelId: "-1099",
      title: "LostRights",
      username: "lostrights",
      ownerId: "u-9001",
      ownerName: "Tester",
      botHasAdminRights: true,
      totalRequested: 0,
      verifiedSubscribers: 0,
      activeSubscribers: 0,
      unsubscribedCount: 0,
      pendingSubscriptions: 0,
      controllers: [],
      status: "active",
      createdAt: nowIso()
    }
  ],
  igProfiles: [],
  orders: [],
  tasks: [],
  transactions: [],
  memberships: [],
  membershipEvents: [],
  verificationJobs: [],
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
    creditRewardTelegram: 100,
    creditRewardInstagram: 100,
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

// Mock holati: har bir kanal uchun bot/foydalanuvchi holati alohida o'rnatiladi.
fs.writeFileSync(STATE, JSON.stringify({
  chats: {
    chan_botno: { id: -1002, title: "BotNoAdmin" },
    chan_norights: { id: -1003, title: "NoRights" },
    chan_userno: { id: -1004, title: "UserNoAdmin" },
    chan_err: { id: -1005, title: "ApiError" },
    chan_ok: { id: -1006, title: "GoodChannel" },
    chan_limited: { id: -1088, title: "LimitedRights" }
  },
  members: {
    "-1002|777000": "left",
    "-1003|777000": "administrator",
    "-1003|9001": "no_rights",
    "-1004|777000": "administrator",
    "-1004|9001": "member",
    "-1005|777000": "timeout",
    "-1006|777000": "creator",
    "-1006|9001": "creator",
    "-1088|777000": "administrator",
    "-1088|9001": "creator",
    "-1099|777000": "no_rights",
    "-1099|9001": "creator"
  }
}));
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
      // Bu testda «bitta salbiy natija → qulf» xatti-harakati tekshiriladi;
      // ikki marta tasdiqlash alohida testda (admin-lock-confirm).
      ADMIN_LOCK_CONFIRM_SEC: "0"
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
    await sleep(400);
  }
  throw new Error("server ko'tarilmadi");
}
async function stopServer() {
  if (!srv) return;
  srv.kill();
  await sleep(600);
  srv = null;
}

function push(update) {
  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8") || "[]");
  inbox.push(update);
  fs.writeFileSync(INBOX, JSON.stringify(inbox));
}
const USER_ID = 9001;
const msg = (text) => ({
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    from: { id: USER_ID, is_bot: false, first_name: "Tester", username: "tester", language_code: "uz" },
    chat: { id: USER_ID, type: "private" },
    date: Math.floor(Date.now() / 1e3),
    text
  }
});
const cb = (data) => ({
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: USER_ID, is_bot: false, first_name: "Tester", username: "tester", language_code: "uz" },
    message: { message_id: 1, chat: { id: USER_ID, type: "private" } },
    chat_instance: "1",
    data
  }
});
// Baza fayli `save()` debounce'i bilan yoziladi — qat'iy kutish o'rniga
// kerakli qiymat paydo bo'lishini kutamiz (sekin mashinada beqaror bo'lardi).
async function waitDb(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}
async function say(text, wait = 900) {
  push(msg(text));
  await sleep(wait);
}
async function click(data, wait = 900) {
  push(cb(data));
  await sleep(wait);
}

async function main() {
  startServer();
  await waitHttp();
  await say("/start", 1200);
  check("Foydalanuvchi ro'yxatdan o'tdi", !!readDb().users["9001"]);

  /* ---------- A. Kanal qo'shish: 5 xil nosozlik ---------- */
  await click("chadd", 600);
  await say("@nochanexists", 1200);
  check("Kanal topilmadi → alohida xabar", /Kanalni ochib bo/.test(lastText(USER_ID)), lastText(USER_ID));

  await say("@chan_botno", 1200);
  check("Bot admin emas → alohida xabar", /Bot bu kanalda/.test(lastText(USER_ID)) && /administrator emas/.test(lastText(USER_ID)), lastText(USER_ID));

  await say("@chan_norights", 1200);
  check("Huquq yetarli emas → alohida xabar", /huquqi yetarli emas/.test(lastText(USER_ID)), lastText(USER_ID));

  await say("@chan_userno", 1200);
  check("Foydalanuvchida huquq yo'q → alohida xabar", /boshqarish huquqi yo/.test(lastText(USER_ID)), lastText(USER_ID));

  await say("@chan_err", 1200);
  check("Vaqtinchalik API xatosi → 'bot admin emas' deb talqin qilinmaydi", /Telegram hozir javob bermadi/.test(lastText(USER_ID)) && !/administrator emas/.test(lastText(USER_ID)), lastText(USER_ID));

  await say("@chan_ok", 1400);
  const db1 = readDb();
  const okCh = db1.channels.find((c) => c.channelId === "-1006");
  check("Muvaffaqiyatli holatda kanal faol qo'shildi", !!okCh && okCh.status === "active" && okCh.botHasAdminRights === true);
  check("ch_added xabari yuborildi", /Kanal ulandi/.test(lastText(USER_ID)), lastText(USER_ID));

  await click("chadd", 600);
  await say("@chan_limited", 1400);
  const limCh = readDb().channels.find((c) => c.channelId === "-1088");
  check("Cheklangan huquqda kanal ulandi, lekin ogohlantirish berildi", !!limCh && /taklif qilish/.test(lastText(USER_ID)), lastText(USER_ID));

  /* ---------- B. Buyurtmadan oldin huquqni qayta tekshirish ---------- */
  const before = readDb().users["9001"].credits.available;
  await click("ord:ch-9", 800);
  await say("50", 900);
  // `client_token` majburiy: buyurtma faqat tasdiqlash kaliti bilan yaratiladi.
  await click("ordok:" + (readDb().users["9001"].state || {}).token, 1400);
  const db2 = readDb();
  check("Huquq yo'qolgan kanalga buyurtma yaratilmadi", db2.orders.filter((o) => o.destinationId === "ch-9").length === 0);
  check("Kredit band qilinmadi", db2.users["9001"].credits.available === before, `${before} → ${db2.users["9001"].credits.available}`);
  check("Buyurtma rad etilgani tushuntirildi", /Buyurtma yaratilmadi/.test(allText(USER_ID)), lastText(USER_ID));
  const lostCh = db2.channels.find((c) => c.id === "ch-9");
  check("Kanal 'permission_lost' deb belgilandi", lostCh.status === "permission_lost" && lostCh.botHasAdminRights === false);

  /* ---------- B2. Order client_token: kalitsiz/takroriy/parallel ---------- */
  const chOkDb = readDb().channels.find((c) => c.channelId === "-1006");
  await click("ord:" + chOkDb.id, 900);
  await say("10", 1000);
  const stTok = readDb().users["9001"].state || {};
  check("buyurtma tasdiqlash kaliti yaratildi", /^[0-9a-f]{16}$/.test(String(stTok.token || "")), JSON.stringify(stTok));
  // Kalitsiz (eski) tugma: buyurtma YARATILMAYDI.
  push(cb("ordok:1"));
  await sleep(1200);
  check("kalitsiz ordok buyurtma yaratmaydi", readDb().orders.filter((o) => o.destinationId === chOkDb.id).length === 0,
    JSON.stringify(readDb().orders.filter((o) => o.destinationId === chOkDb.id).map((o) => o.id)));
  // 20 ta BIR XIL tasdiqlash so'rovi: faqat bitta buyurtma va bitta reservation.
  const beforeTok = readDb().users["9001"].credits.available;
  for (let i = 0; i < 20; i++) push(cb("ordok:" + stTok.token));
  await sleep(5000);
  const dbTok = readDb();
  const ords = dbTok.orders.filter((o) => o.destinationId === chOkDb.id);
  check("20 ta takroriy tasdiqdan faqat bitta buyurtma", ords.length === 1, JSON.stringify(ords.map((o) => o.id)));
  check("bitta reservation yozuvi", ords.length === 1 && dbTok.transactions.filter((t) => t.idempotencyKey === "reserve:" + ords[0].id).length === 1);
  check("balans faqat bir marta band qilindi", ords.length === 1 && dbTok.users["9001"].credits.available === beforeTok - 10,
    `${beforeTok} → ${dbTok.users["9001"].credits.available}`);

  /* ---------- C. Sozlamalar submenyusi ---------- */
  await click("settings", 900);
  let kb = kbFlat(lastKb(USER_ID));
  check("Sozlamalar submenyusi: bildirishnomalar", kb.includes("setnotif"));
  check("Sozlamalar submenyusi: xavfsizlik", kb.includes("setsec"));
  check("Sozlamalar submenyusi: Telegram hisoblari", kb.includes("setacc"));
  check("Sozlamalar submenyusi: asosiy menyu", kb.includes("setmain"));

  await click("setnotif", 900);
  kb = kbFlat(lastKb(USER_ID));
  check("Bildirishnomalar sahifasida 4 turkum bor", kb.includes("nt:subscribers") && kb.includes("nt:referrals") && kb.includes("nt:orders") && kb.includes("nt:technical"));

  await click("nt:orders", 300);
  check("Buyurtma bildirishnomasi o'chirildi", await waitDb(() => readDb().users["9001"].notif.orders === false));

  await click("settings", 700);
  await click("setsec", 900);
  check("Xavfsizlik sahifasi ishlaydi", /Hisob xavfsizligi/.test(lastText(USER_ID)) && kbFlat(lastKb(USER_ID)).includes("secrep"));
  check("Xavfsizlik bildirishnomalari alohida (o'chirilmaydi)", /alohida/.test(lastText(USER_ID)));

  await click("setacc", 900);
  const accText = lastText(USER_ID);
  check("Telegram hisoblari sahifasida akkaunt va kanallar ajratilgan", /Shaxsiy akkaunt/.test(accText) && /bog‘langan kanallar/.test(accText), accText);
  check("Huquqi yo'qolgan kanal 'admin emas' deb ko'rsatildi", /admin emas/.test(accText), accText);

  await click("setmain", 800);
  check("Asosiy menyu tugmasi reply keyboard qaytaradi", !!lastKb(USER_ID) && kbFlat(lastKb(USER_ID)).includes("📢 Kanallarim"));

  /* ---------- Uch til ---------- */
  await click("settings", 700);
  await click("lang:ru", 1000);
  check("Rus tili saqlandi", readDb().users["9001"].language === "ru");
  await click("settings", 900);
  check("Sozlamalar rus tilida ko'rsatildi", /Настройки/.test(lastText(USER_ID)), lastText(USER_ID));
  await click("setsec", 900);
  check("Xavfsizlik sahifasi rus tilida", /Безопасность аккаунта/.test(lastText(USER_ID)), lastText(USER_ID));
  await click("lang:en", 900);
  await click("settings", 900);
  check("Sozlamalar ingliz tilida ko'rsatildi", /Settings/.test(lastText(USER_ID)), lastText(USER_ID));
  await click("setacc", 900);
  check("Telegram accounts sahifasi ingliz tilida", /Telegram accounts/.test(lastText(USER_ID)), lastText(USER_ID));

  /* ---------- D. Restartdan keyin saqlanishi ---------- */
  await stopServer();
  startServer();
  await waitHttp();
  await sleep(800);
  const db3 = readDb();
  check("Til restartdan keyin saqlandi", db3.users["9001"].language === "en");
  check("Bildirishnoma sozlamasi restartdan keyin saqlandi", db3.users["9001"].notif.orders === false);
  await click("settings", 900);
  await click("setnotif", 900);
  check("Restartdan keyin bildirishnomalar sahifasi holatni ko'rsatadi", /Notifications/.test(lastText(USER_ID)), lastText(USER_ID));

  await stopServer();
  mock.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
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
