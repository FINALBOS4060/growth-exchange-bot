// Ishchi botlarning administratorlik HOLAT MODELI (spec §3–§5).
//
// Qamrab olinadi:
//  1. 401  → `invalid_token` (token yaroqsiz), "admin emas" EMAS.
//  2. 403  → `bot_not_found` (bot kanaldan chiqarilgan).
//  3. 429  → `api_error` (vaqtinchalik), xulosa chiqarilmaydi.
//  4. 5xx  → `api_error` (vaqtinchalik).
//  5. Huquq yetishmasligi (400 no_rights) → `bot_not_admin`.
//  6. `can_invite_users=false` → `missing_permissions` (ok:true, bloklamaydi).
//  7. 4+ bot: barchasi tekshiriladi, admin bot 3 tadan keyin ham topiladi.
//  8. Hech bir bot admin emas → kanal ulanmaydi.
//  9. Barcha bot API xatosida → kanal "admin emas" deb belgilanmaydi (api_error).
// 10. Reconnect: `botAdminBotId` yangilanadi.
// 11. Panel `/api/admin/bots` har bir botning admin holatini qaytaradi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3991;
const MOCK = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "data/bas-test-db.json";
const STATE = "data/bas-state.json";
const INBOX = "data/bas-inbox.json";
const OUT = "data/bas-out.log";
const CALLS = "data/bas-calls.log";

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

const UID = 9201;
const OWNER = 9202;
const user = (id, tid, credits) => ({
  id, telegramId: tid, username: "u" + tid, displayName: "U" + tid, language: "uz",
  credits: { available: credits, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(), referralCode: "REF_" + tid, isReferralVerified: false,
  completedTasksCount: 0, activeOrdersCount: 0, status: "active", chatId: tid, botId: "bot-main",
  notifications: true, notif: { subscribers: true, referrals: true, orders: true, technical: true }
});

const seed = {
  seq: 9200,
  users: { 9201: user("u-9201", UID, 500), 9202: user("u-9202", OWNER, 0) },
  channels: [{
    id: "ch-recon", channelId: "-3108", title: "Reconnect", username: "recon_chan",
    ownerId: "u-9201", ownerName: "U9201", botHasAdminRights: false, botAdminStatus: "bot_not_admin",
    totalRequested: 0, verifiedSubscribers: 0, activeSubscribers: 0, unsubscribedCount: 0,
    pendingSubscriptions: 0, controllers: [], status: "disconnected", createdAt: nowIso(),
    disconnectedAt: "2026-01-01T00:00:00.000Z", botAdminBotId: ""
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
      { id: "bot-worker1", token: "WORKERTOKEN1", role: "worker", enabled: true, username: "worker_one", displayName: "W1", offset: 0 },
      { id: "bot-worker2", token: "WORKERTOKEN2", role: "worker", enabled: true, username: "worker_two", displayName: "W2", offset: 0 },
      { id: "bot-worker3", token: "WORKERTOKEN3", role: "worker", enabled: true, username: "worker_three", displayName: "W3", offset: 0 }
    ]
  }
};
fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(OUT, "");
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(CALLS, "");

// Har bir bot uchun ALOHIDA admin holati (`botMembers`).
// DIQQAT: kalit `<chat_id>|<bot_user_id>` ko'rinishida.
const botMembers = {
  "777000": {
    "-3101|777000": "administrator", "-3102|777000": "administrator", "-1088|777000": "left",
    "-3104|777000": "left", "-3105|777000": "left", "-3106|777000": "server", "-3108|777000": "left"
  },
  "777001": {
    "-3101|777001": "unauthorized", "-3102|777001": "rate:7", "-1088|777001": "left",
    "-3104|777001": "left", "-3105|777001": "left", "-3106|777001": "server", "-3108|777001": "administrator"
  },
  "777002": {
    "-3101|777002": "forbidden", "-3102|777002": "no_rights", "-1088|777002": "administrator",
    "-3104|777002": "left", "-3105|777002": "left", "-3106|777002": "server", "-3108|777002": "left"
  },
  "777003": {
    "-3101|777003": "no_rights", "-3102|777003": "netfail", "-1088|777003": "left",
    "-3104|777003": "administrator", "-3105|777003": "left", "-3106|777003": "server", "-3108|777003": "left"
  }
};
fs.writeFileSync(STATE, JSON.stringify({
  chats: {
    states_chan: { id: -3101, title: "States" },
    rate_chan: { id: -3102, title: "Rate" },
    lim_chan: { id: -1088, title: "Limited" },
    deep_chan: { id: -3104, title: "Deep" },
    none_chan: { id: -3105, title: "None" },
    err_chan: { id: -3106, title: "Errors" },
    recon_chan: { id: -3108, title: "Reconnect" }
  },
  // Foydalanuvchi huquqi hamma bot uchun bir xil — umumiy `members` dan olinadi.
  members: {
    "-3101|9201": "creator", "-3102|9201": "creator", "-1088|9201": "creator",
    "-3104|9201": "creator", "-3105|9201": "creator", "-3106|9201": "creator",
    "-3108|9201": "creator"
  },
  botMembers
}));

const mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
  env: {
    ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX,
    MOCK_OUT: OUT, MOCK_CALLS: CALLS,
    MOCK_BOT_ID_MAP: JSON.stringify({
      WORKERTOKEN1: { id: 777001, username: "worker_one" },
      WORKERTOKEN2: { id: 777002, username: "worker_two" },
      WORKERTOKEN3: { id: 777003, username: "worker_three" }
    })
  },
  stdio: "ignore"
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
const msg = (text) => ({
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    from: { id: UID, is_bot: false, first_name: "U9201", username: "u9201", language_code: "uz" },
    chat: { id: UID, type: "private" }, date: Math.floor(Date.now() / 1e3), text
  }
});
const cb = (data) => ({
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: UID, is_bot: false, first_name: "U9201", username: "u9201", language_code: "uz" },
    message: { message_id: 1, chat: { id: UID } }, chat_instance: "1", data
  }
});
const say = async (t, w = 1200) => { push(msg(t)); await sleep(w); };
const click = async (d, w = 1000) => { push(cb(d)); await sleep(w); };
const chAt = (channelId) => readDb().channels.find((c) => c.channelId === channelId);

async function main() {
  await waitHttp();
  await say("/start", 1500);

  /* ---------- 1. Bir kanalda uch xil nosozlik ---------- */
  await click("chadd", 400);
  await say("@states_chan", 3200);
  const ch1 = chAt("-3101");
  check("kanal ulandi (asosiy bot admin)", !!ch1 && ch1.status === "active", ch1 && ch1.status);
  check("kanal ishlatadigan bot — asosiy", !!ch1 && ch1.botAdminBotId === "bot-main", ch1 && ch1.botAdminBotId);
  check("401 → invalid_token", ch1.botAdmins["bot-worker1"].status === "invalid_token",
    JSON.stringify(ch1.botAdmins["bot-worker1"]));
  check("401 → ok:false, boshqa holat emas", ch1.botAdmins["bot-worker1"].ok === false);
  check("403 (kicked) → bot_not_found", ch1.botAdmins["bot-worker2"].status === "bot_not_found",
    JSON.stringify(ch1.botAdmins["bot-worker2"]));
  check("400 no_rights → bot_not_admin", ch1.botAdmins["bot-worker3"].status === "bot_not_admin",
    JSON.stringify(ch1.botAdmins["bot-worker3"]));
  check("invalid_token 'admin emas' ro'yxatiga tushmaydi",
    !(ch1.botsMissingAdmin || []).some((l) => /worker_one/.test(l)), JSON.stringify(ch1.botsMissingAdmin));
  check("haqiqiy NOT_ADMIN ro'yxatga tushadi",
    (ch1.botsMissingAdmin || []).some((l) => /worker_three/.test(l)), JSON.stringify(ch1.botsMissingAdmin));

  /* ---------- 2. 429 va timeout → api_error, xulosa yo'q ---------- */
  await click("chadd", 400);
  await say("@rate_chan", 3200);
  const ch2 = chAt("-3102");
  check("429 → api_error (transient)", ch2.botAdmins["bot-worker1"].status === "api_error" && ch2.botAdmins["bot-worker1"].transient === true,
    JSON.stringify(ch2.botAdmins["bot-worker1"]));
  check("timeout/netfail → api_error (transient)", ch2.botAdmins["bot-worker3"].status === "api_error" && ch2.botAdmins["bot-worker3"].transient === true,
    JSON.stringify(ch2.botAdmins["bot-worker3"]));
  check("API xatosi 'admin emas' ro'yxatiga tushmaydi",
    !(ch2.botsMissingAdmin || []).some((l) => /worker_one|worker_three/.test(l)), JSON.stringify(ch2.botsMissingAdmin));
  check("kanal API xatosi sabab yopilmadi", ch2.status === "active", ch2.status);

  /* ---------- 3. Huquq qisqartirilgan administrator ---------- */
  await click("chadd", 400);
  await say("@lim_chan", 3200);
  const ch3 = chAt("-1088");
  check("missive: faqat limited bot admin → kanal ulanadi", !!ch3 && ch3.status === "active", ch3 && ch3.status);
  check("can_invite_users=false → missing_permissions", ch3.botAdmins["bot-worker2"].status === "missing_permissions",
    JSON.stringify(ch3.botAdmins["bot-worker2"]));
  check("limited bot ok:true (a'zolikni o'qiy oladi)", ch3.botAdmins["bot-worker2"].ok === true);
  check("kanal botRightsLimited bayrog'i", ch3.botRightsLimited === true, String(ch3.botRightsLimited));
  check("limited bot tanlandi", ch3.botAdminBotId === "bot-worker2", ch3.botAdminBotId);

  /* ---------- 4. 4+ bot: cheklovsiz tekshiruv ---------- */
  await click("chadd", 400);
  await say("@deep_chan", 4200);
  const ch4 = chAt("-3104");
  check("3 tadan keyingi bot ham tekshirildi", !!ch4 && ch4.botAdmins["bot-worker3"] && ch4.botAdmins["bot-worker3"].ok === true,
    JSON.stringify(ch4 && ch4.botAdmins));
  check("chuqurdagi admin bot tanlandi", ch4.botAdminBotId === "bot-worker3", ch4.botAdminBotId);

  /* ---------- 5. Hech bir bot admin emas ---------- */
  await click("chadd", 400);
  await say("@none_chan", 3200);
  check("hech bir bot admin emas → kanal ulanmadi", !chAt("-3105"));
  check("sabab aniq ko'rsatildi", /administrator emas|Bot bu kanalda/.test(lastText(UID)), lastText(UID));

  /* ---------- 6. Barcha bot API xatosida → "admin emas" emas ---------- */
  await click("chadd", 400);
  await say("@err_chan", 3200);
  check("barcha bot 5xx → kanal ulanmadi (xulosa yo'q)", !chAt("-3106"));
  check("API xatosi 'administrator emas' deb talqin qilinmadi", !/administrator emas/.test(lastText(UID)), lastText(UID));
  check("foydalanuvchiga texnik xato aytildi", /javob bermadi|texnik/.test(lastText(UID)), lastText(UID));

  /* ---------- 7. Reconnect: botAdminBotId yangilanadi ---------- */
  await click("chadd", 400);
  await say("@recon_chan", 3200);
  const rec = chAt("-3108");
  check("reconnect: kanal qayta ulandi", !!rec && rec.status === "active" && !rec.disconnectedAt,
    JSON.stringify({ status: rec && rec.status, d: rec && rec.disconnectedAt }));
  check("reconnect: botAdminBotId yozildi (ishchi bot)", !!rec && rec.botAdminBotId === "bot-worker1",
    rec && rec.botAdminBotId);

  /* ---------- 8. Panel: per-bot admin holati ---------- */
  const login = await fetch(BASE + "/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const botsRes = await fetch(BASE + "/api/admin/bots", { headers: { cookie } });
  const botsJson = await botsRes.json();
  const byId = Object.fromEntries((botsJson.bots || []).map((b) => [b.id, b]));
  check("panel: bot ro'yxati qaytadi", !!byId["bot-worker1"], JSON.stringify(Object.keys(byId)));

  // Yangi tekshiruvlar uchun worker1 holatini yangilaymiz: rate_chan'da api_error.
  check("panel: adminStatus maydoni bor", typeof byId["bot-worker1"].adminStatus === "string",
    JSON.stringify(byId["bot-worker1"]));
  check("panel: adminChannels soni", byId["bot-main"].adminChannels === 2, String(byId["bot-main"].adminChannels));
  check("panel: tekshirilgan kanallar soni", byId["bot-worker1"].adminCheckedChannels >= 5,
    String(byId["bot-worker1"].adminCheckedChannels));
  check("panel: ishchi botning admin kanallari (faqat reconnect)",
    byId["bot-worker1"].adminChannels === 1, String(byId["bot-worker1"].adminChannels));
  check("panel: reconnectdan keyin worker1 admin",
    byId["bot-worker1"].adminStatus === "ok", byId["bot-worker1"].adminStatus);
  const panelHtml = await (await fetch(BASE + "/", { headers: { cookie } })).text();
  check("panel HTML: 'Admin tekshiruvi' ustuni", /Admin tekshiruvi/.test(panelHtml));

  // Windows'da oqimlar yopilishidan oldin `process.exit` libuv assertion beradi.
  srv.stdout.removeAllListeners();
  srv.stderr.removeAllListeners();
  srv.kill();
  mock.kill();
  await sleep(500);
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
