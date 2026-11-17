// verifyBatch() / runTaskCheckJob() saqlash xatosi → TO'LIQ rollback
// (haqiqiy PostgreSQL + haqiqiy server + mock Telegram).
//
// Ssenariy (hisobotdagi xato): tasdiqlash mukofotni beradi → persist yiqiladi →
// foydalanuvchi save_err oladi → keyin ALOQASIZ operatsiya save() chaqiradi.
// Bunday holda tasdiqlanmagan mukofot bazaga yozilib ketmasligi shart.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const PORT = 5601;
const MOCK = 5602;
const PGPORT = 55820;
const PG_DIR = "data/pg-verify-data";
const DB = "data/pg-verify-seed.json";
const STATE = "data/pg-verify-mtg.json";
const INBOX = "data/pg-verify-inbox.json";
const OUT = "data/pg-verify-out.log";
const CALLS = "data/pg-verify-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const user = (tid, available, notif = false) => ({
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
  notifications: notif,
  notif: { subscribers: notif, referrals: notif, orders: notif, technical: notif }
});

const seed = {
  seq: 300,
  users: {
    9700: user(9700, 0, true),
    9706: user(9706, 0),
    9702: user(9702, 100)
  },
  channels: [{
    id: "ch-v",
    channelId: "-4301",
    title: "ChV",
    username: "chv",
    ownerId: "u-9700",
    ownerName: "u-9700",
    botHasAdminRights: true,
    botAdminStatus: "ok",
    status: "active",
    verifiedSubscribers: 0,
    activeSubscribers: 0,
    pendingSubscriptions: 2,
    unsubscribedCount: 0,
    totalRequested: 2,
    controllers: [],
    createdAt: nowIso()
  }],
  igProfiles: [],
  orders: [{
    id: "ord-v", seq: 1, userId: "u-9700", userName: "u-9700", destinationId: "ch-v", destinationTitle: "ChV",
    platform: "telegram", requestedQuantity: 2, verifiedQuantity: 0, pendingQuantity: 2, cancelledQuantity: 0,
    unitCost: 1, totalCost: 2, freeUnits: 2, status: "active", createdAt: nowIso()
  }],
  tasks: [{
    id: "t-v", assignedTo: "u-9706", orderId: "ord-v", destinationId: "ch-v", destinationTitle: "ChV",
    destinationUrl: "https://t.me/chv", platform: "telegram", status: "PENDING", rewardCredits: 10,
    queueSequence: 1, createdAt: nowIso()
  }],
  transactions: [
    { id: "tx-seed-9702", userId: "u-9702", amount: 100, type: "admin_adjustment", idempotencyKey: "seed:9702", balanceAfter: 100 }
  ],
  memberships: [],
  membershipEvents: [],
  verificationJobs: [],
  verifyErrors: [],
  sponsorMemberships: [],
  notifPeriods: [],
  complaints: [],
  referrals: [{
    id: "ref-v", referrerId: "u-9700", referrerName: "U9700", referredUserId: "u-9706", referredUserName: "U9706",
    isRegistered: true, hasCompletedTask: false, isVerified: false, bonusIssued: false, bonusAmount: 0
  }],
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
    creditRewardSignup: 100,
    creditRewardChannelLink: 0,
    creditPerSubscriber: 1,
    autoOrderCredits: false,
    isInstagramEnabled: false,
    hourlyNotificationsEnabled: false,
    // Migratsiya signup bonusini nolga tushirmasligi uchun versiyalar belgilangan.
    rulesVersion: 3,
    bonusRuleVersion: 2,
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(STATE, JSON.stringify({ members: { "-4301|9706": "member", "-4301|777000": "administrator" }, chats: {} }));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

let pgApi = null;
let mock = null;
let srv = null;

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
      DATABASE_URL: pgApi.url,
      TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
      TELEGRAM_BOT_TOKEN: "TESTTOKEN",
      ADMIN_PASSWORD: "testpass",
      DATA_FILE: DB,
      KEEP_ALIVE: "0",
      VERIFY_BATCH: "25",
      MAINTENANCE_SEC: "3600",
      BOT_START_RETRY_SEC: "600"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  srv.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv] " + d));
  srv.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv:err] " + d));
}
async function login() {
  const r = await fetch(`http://127.0.0.1:${PORT}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function apiGet(route) {
  const cookie = await login();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/${route}`, { headers: { cookie } });
  try {
    return await r.json();
  } catch {
    return null;
  }
}
async function apiPost(route, body) {
  const cookie = await login();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/${route}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, ok: r.ok, body: j };
}
async function waitState(fn, ms = 12000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      last = await pgApi.readState();
      if (last && fn(last)) return last;
    } catch {}
    await sleep(200);
  }
  return last;
}
function parity(state, userId) {
  const u = Object.values(state.users).find((x) => x.id === userId);
  const txs = (state.transactions || []).filter((t) => t.userId === userId);
  const led = runtimeLedger(txs, Number(u.credits.spent) || 0);
  return {
    ok: Math.abs(led.available - u.credits.available) < 1e-6 && Math.abs(led.reserved - u.credits.reserved) < 1e-6,
    led,
    wallet: u.credits
  };
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
const cb = (id, data) => ({
  callback_query: {
    id: "c" + Math.random(),
    from: { id, is_bot: false, first_name: "U" + id, username: "u" + id, language_code: "uz" },
    message: { message_id: 1, chat: { id, type: "private" } },
    chat_instance: "1",
    data
  }
});
function push(u) {
  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8") || "[]");
  inbox.push(u);
  fs.writeFileSync(INBOX, JSON.stringify(inbox));
}
const outbox = () => fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const allText = (chat) => outbox().filter((x) => String(x.chat) === String(chat)).map((x) => String(x.text || "")).join("\n");
async function send(u, wait = 900) {
  push(u);
  await sleep(wait);
}

async function main() {
  pgApi = await startPg({ dir: PG_DIR, port: PGPORT });
  mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
    env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
    stdio: "ignore"
  });
  startServer();
  await waitHttp();
  check("PG: holat yozildi", !!(await waitState((s) => s && s.tasks && s.tasks.find((t) => t.id === "t-v"))));
  await sleep(1000);

  /* ═══ 1. verifyBatch: persist xatosi → to'liq rollback ═══ */
  const c = await pgApi.client();
  await c.query("ALTER TABLE app_state RENAME TO app_state_broken");
  await send(cb(9706, "verify:tg"), 2500);
  const failText = allText(9706);
  check("VERIFY: persist xatosida save_err yuborildi", /saqlashda xatolik/i.test(failText), failText.slice(-200));
  check("VERIFY: 'tasdiqlandi' xabari YUBORILMADI", !/Tasdiqlandi/i.test(failText), failText.slice(-200));
  await c.query("ALTER TABLE app_state_broken RENAME TO app_state");

  // ALOQASIZ operatsiya save() chaqiradi — tasdiqlanmagan mukofot yozilib ketmasin.
  const ok1 = await apiPost("user", { telegramId: 9702, action: "credits", amount: 1, client_token: "after-fail" });
  check("VERIFY: aloqasiz amal bajarildi", ok1.ok === true, JSON.stringify(ok1.body));
  let st = await waitState((s) => s.users["9702"].credits.available === 101);
  check("VERIFY: t-v PENDING bo'lib qoldi (rollback)", st.tasks.find((t) => t.id === "t-v").status === "PENDING",
    st.tasks.find((t) => t.id === "t-v").status);
  check("VERIFY: reward yozuvi yo'q", !(st.transactions || []).some((t) => t.idempotencyKey === "reward:t-v"));
  check("VERIFY: referral bonusi yozilmadi", !(st.transactions || []).some((t) => t.idempotencyKey === "refreward:ref-v"));
  check("VERIFY: u-9706 balansi 0", st.users["9706"].credits.available === 0, String(st.users["9706"].credits.available));
  check("VERIFY: u-9700 balansi 0", st.users["9700"].credits.available === 0, String(st.users["9700"].credits.available));
  check("VERIFY: order hisoblagichi o'zgarmadi", st.orders.find((o) => o.id === "ord-v").verifiedQuantity === 0);
  check("VERIFY: a'zolik yozuvi yaratilmadi (rollback)", (st.memberships || []).length === 0);
  check("VERIFY: verifyLog tozalandi (rollback)", (st.verifyLog || []).length === 0);
  check("VERIFY: referal bildirishnomasi yuborilmadi", !/referal bonusi/i.test(allText(9700)), allText(9700).slice(-200));
  check("VERIFY: ledger farqi 0 (u-9706)", parity(st, "u-9706").ok, JSON.stringify(parity(st, "u-9706")));

  // Endi sog'lom: qayta bosish tasdiqlaydi va mukofot beradi.
  await send(cb(9706, "verify:tg"), 2500);
  st = await waitState((s) => s.tasks.find((t) => t.id === "t-v").status === "VERIFIED");
  check("VERIFY: keyingi urinishda VERIFIED", st.tasks.find((t) => t.id === "t-v").status === "VERIFIED");
  check("VERIFY: reward bir marta", (st.transactions || []).filter((t) => t.idempotencyKey === "reward:t-v").length === 1);
  check("VERIFY: referal bonusi bir marta +300", (st.transactions || []).filter((t) => t.idempotencyKey === "refreward:ref-v").length === 1 &&
    st.users["9700"].credits.available === 300, String(st.users["9700"].credits.available));
  check("VERIFY: referal bildirishnomasi yuborildi", /referal bonusi/i.test(allText(9700)), allText(9700).slice(-200));
  check("VERIFY: ledger farqi 0 (referrer)", parity(st, "u-9700").ok, JSON.stringify(parity(st, "u-9700")));

  /* ═══ 2. Signup bonus: persist xatosi → berilmaydi, keyin qayta uriniladi ═══ */
  const c2 = await pgApi.client();
  await c2.query("ALTER TABLE app_state RENAME TO app_state_broken");
  await send(msg(9708, "/start"), 2000);
  await c2.query("ALTER TABLE app_state_broken RENAME TO app_state");
  // Aloqasiz save.
  await apiPost("user", { telegramId: 9702, action: "credits", amount: 1, client_token: "after-signup-fail" });
  st = await waitState((s) => s.users["9702"].credits.available === 102);
  check("SIGNUP: saqlanmasa bonus berilmadi", !(st.transactions || []).some((t) => t.type === "signup_bonus" && t.userId === "u-9708"));
  check("SIGNUP: balans 0 (rollback)", st.users["9708"] && st.users["9708"].credits.available === 0,
    JSON.stringify(st.users["9708"] && st.users["9708"].credits));
  check("SIGNUP: bayroq qayta qo'yilgan", st.users["9708"] && st.users["9708"].signupPending === true,
    JSON.stringify(st.users["9708"] && st.users["9708"].signupPending));

  // Keyingi xabar → qayta urinish muvaffaqiyatli.
  await send(msg(9708, "salom"), 2000);
  st = await waitState((s) => s.users["9708"].credits.available === 100);
  check("SIGNUP: keyingi xabarda bonus berildi", st.users["9708"].credits.available === 100, String(st.users["9708"].credits.available));
  check("SIGNUP: bitta signup_bonus yozuvi", (st.transactions || []).filter((t) => t.type === "signup_bonus" && t.userId === "u-9708").length === 1);
  check("SIGNUP: ledger farqi 0", parity(st, "u-9708").ok, JSON.stringify(parity(st, "u-9708")));

  /* ═══ 3. Umumiy moslik ═══ */
  const tasks = await apiGet("tasks");
  check("YAKUN: t-v VERIFIED (API)", tasks && tasks.byStatus && tasks.byStatus.VERIFIED === 1, JSON.stringify(tasks && tasks.byStatus));
  check("YAKUN: hech bir foydalanuvchida drift yo'q",
    parity(st, "u-9700").ok && parity(st, "u-9702").ok && parity(st, "u-9706").ok && parity(st, "u-9708").ok);

  try {
    srv.kill("SIGTERM");
  } catch {}
  await sleep(600);
  try {
    mock.kill();
  } catch {}
  await pgApi.stop();
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
  try {
    pgApi && (await pgApi.stop());
  } catch {}
  process.exit(1);
});
