// P3-(ii) — `invalid_token` boshqaruvi (spec §11–§14).
//
//  1. INVALID_TOKEN + boshqa bot VERIFIED_ADMIN → buyurtma o'tadi
//     ("bitta bot yetarli" qoidasi saqlanadi).
//  2. INVALID_TOKEN + hech qanday VERIFIED_ADMIN yo'q → buyurtma TEXNIK sabab
//     bilan bloklanadi; kanal `permission_lost` deb belgilanmaydi.
//  3. Sweep: barcha tokenlar yaroqsiz → kanal active qoladi, holat
//     `invalid_token` ko'rsatiladi (API_ERROR kabi vaqtinchalik ham emas,
//     `bot_not_admin` ham emas).
//  4. Bot o'chirilganda uning eski snapshot yozuvlari tozalanadi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3995;
const MOCK = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "data/bit-test-db.json";
const STATE = "data/bit-state.json";
const INBOX = "data/bit-inbox.json";
const OUT = "data/bit-out.log";
const CALLS = "data/bit-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
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

const UID = 9401;
const user = (id, tid, credits) => ({
  id, telegramId: tid, username: "u" + tid, displayName: "U" + tid, language: "uz",
  credits: { available: credits, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(), referralCode: "REF_" + tid, isReferralVerified: false,
  completedTasksCount: 0, activeOrdersCount: 0, status: "active", chatId: tid, botId: "bot-main",
  notifications: true, notif: { subscribers: true, referrals: true, orders: true, technical: true }
});
const OLD = "2026-01-01T00:00:00.000Z";
const chan = (id, cid, title, extra = {}) => ({
  id, channelId: cid, title, username: title.toLowerCase(), ownerId: "u-9401", ownerName: "U9401",
  botHasAdminRights: true, botAdminStatus: "ok", totalRequested: 10, verifiedSubscribers: 0,
  activeSubscribers: 0, unsubscribedCount: 0, pendingSubscriptions: 0, controllers: [],
  status: "active", createdAt: nowIso(), lastAdminCheckAt: nowIso(), ...extra
});
const seed = {
  seq: 9400,
  users: { 9401: user("u-9401", UID, 500) },
  channels: [
    chan("ch-pass", "-3401", "PassChan"),
    chan("ch-block", "-3402", "BlockChan"),
    chan("ch-sweep", "-3403", "SweepChan", { lastAdminCheckAt: OLD })
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
      { id: "bot-worker1", token: "WORKERTOKEN1", role: "worker", enabled: true, username: "worker_one", displayName: "W1", offset: 0 }
    ]
  }
};
fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(OUT, "");
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(CALLS, "");
fs.writeFileSync(STATE, JSON.stringify({
  chats: {
    passchan: { id: -3401, title: "PassChan" },
    blockchan: { id: -3402, title: "BlockChan" },
    sweepchan: { id: -3403, title: "SweepChan" }
  },
  members: {},
  botMembers: {
    // Kanal A: asosiy bot admin, ishchi botning tokeni yaroqsiz.
    "777000": { "-3401|777000": "administrator", "-3402|777000": "unauthorized", "-3403|777000": "unauthorized" },
    "777001": { "-3401|777001": "unauthorized", "-3402|777001": "unauthorized", "-3403|777001": "unauthorized" }
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
    from: { id: UID, is_bot: false, first_name: "U9401", username: "u9401", language_code: "uz" },
    chat: { id: UID, type: "private" }, date: Math.floor(Date.now() / 1e3), text
  }
});
const cb = (data) => ({
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: UID, is_bot: false, first_name: "U9401", username: "u9401", language_code: "uz" },
    message: { message_id: 1, chat: { id: UID } }, chat_instance: "1", data
  }
});
const say = async (t, w = 1200) => { push(msg(t)); await sleep(w); };
const click = async (d, w = 1000) => { push(cb(d)); await sleep(w); };
const chById = (id) => readDb().channels.find((c) => c.id === id);

async function buy(channelDbId, qty = 10) {
  await click("ord:" + channelDbId, 900);
  await say(String(qty), 900);
  const tok = (readDb().users["9401"].state || {}).token;
  if (tok) await click("ordok:" + tok, 2600);
  return tok;
}

async function main() {
  await waitHttp();
  await say("/start", 1500);

  /* ---------- 1. INVALID_TOKEN + VERIFIED_ADMIN → buyurtma o'tadi ---------- */
  const before = readDb().users["9401"].credits.available;
  await buy("ch-pass");
  const db1 = readDb();
  const ord1 = db1.orders.find((o) => o.destinationId === "ch-pass");
  check("invalid_token + verified admin → buyurtma yaratildi", !!ord1 && ord1.status === "active",
    JSON.stringify(db1.orders.map((o) => [o.destinationId, o.status])));
  check("kredit bir marta band qilindi", db1.users["9401"].credits.reserved === 10 &&
    db1.users["9401"].credits.available === before - 10,
    `available=${db1.users["9401"].credits.available}, reserved=${db1.users["9401"].credits.reserved}`);
  check("kanal ishlatadigan bot — asosiy", chById("ch-pass").botAdminBotId === "bot-main", chById("ch-pass").botAdminBotId);

  /* ---------- 2. INVALID_TOKEN + admin yo'q → texnik sabab bilan blok ---------- */
  const before2 = readDb().users["9401"].credits.available;
  await buy("ch-block");
  const db2 = readDb();
  check("invalid_token + verified admin yo'q → buyurtma yaratilmadi",
    db2.orders.filter((o) => o.destinationId === "ch-block").length === 0,
    JSON.stringify(db2.orders.map((o) => o.destinationId)));
  check("kredit band qilinmadi", db2.users["9401"].credits.available === before2 &&
    db2.users["9401"].credits.reserved === 10,
    `available=${db2.users["9401"].credits.available}, reserved=${db2.users["9401"].credits.reserved}`);
  check("texnik sabab ko'rsatildi", /Texnik|texnik|javob bermadi/.test(allText(UID)) ||
    /Kredit band qilinmadi/.test(lastText(UID)), lastText(UID));
  const blocked = chById("ch-block");
  check("kanal permission_lost deb belgilanmadi", blocked.status === "active", blocked.status);
  check("kanal holati invalid_token", blocked.botAdminStatus === "invalid_token", blocked.botAdminStatus);
  check("bot_not_admin deb aralashtirilmadi", blocked.botAdminStatus !== "bot_not_admin");

  /* ---------- 3. Sweep: barcha tokenlar yaroqsiz ---------- */
  const swept = await waitDb(() => {
    const c = chById("ch-sweep");
    return c && c.lastAdminCheckAt && c.lastAdminCheckAt !== OLD && c.botAdminStatus === "invalid_token";
  });
  const sw = chById("ch-sweep");
  check("sweep: barcha token yaroqsiz → invalid_token holati", swept, JSON.stringify({ at: sw.lastAdminCheckAt, s: sw.botAdminStatus }));
  check("sweep: kanal active qoladi", sw.status === "active" && sw.botHasAdminRights === true,
    JSON.stringify({ s: sw.status, ok: sw.botHasAdminRights }));

  /* ---------- 4. Bot o'chirilganda snapshot tozalanadi ---------- */
  const login = await fetch(BASE + "/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const del = await fetch(BASE + "/api/admin/bots", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "delete", id: "bot-worker1" })
  });
  const delJson = await del.json().catch(() => ({}));
  check("ishchi bot o'chirildi", del.ok && delJson.ok !== false, JSON.stringify(delJson));
  await sleep(600);
  const chA = chById("ch-pass");
  check("snapshotdan o'chirilgan bot tozalandi",
    !(chA.botAdmins && Object.hasOwn(chA.botAdmins, "bot-worker1")), JSON.stringify(chA.botAdmins));
  check("faol botlarning holati saqlandi", !!(chA.botAdmins && chA.botAdmins["bot-main"]), JSON.stringify(chA.botAdmins));
  const botsRes = await (await fetch(BASE + "/api/admin/bots", { headers: { cookie } })).json();
  check("panel ro'yxatida o'chirilgan bot yo'q",
    !(botsRes.bots || []).some((b) => b.id === "bot-worker1"), JSON.stringify((botsRes.bots || []).map((b) => b.id)));
  check("panel: checkedAt ko'rsatiladi", !!(botsRes.bots || []).find((b) => b.id === "bot-main")?.adminLastCheckAt,
    JSON.stringify((botsRes.bots || []).map((b) => [b.id, b.adminLastCheckAt])));

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
