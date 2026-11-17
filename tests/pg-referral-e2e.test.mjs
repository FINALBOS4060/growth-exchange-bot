// HAQIQIY PostgreSQL + HAQIQIY server + mock Telegram:
//  1. Referral job E2E: runTaskCheckJob → tryQualifyReferral → 300 kredit.
//  2. Order idempotency (bot tugmasi, 20 parallel + kechikkan + mismatch).
//  3. Refund: reserved < refund (foydalanuvchi va admin yo'li).
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const PORT = 5591;
const MOCK = 5592;
const PGPORT = 55810;
const PG_DIR = "data/pg-ref-data";
const DB = "data/pg-ref-seed.json";
const STATE = "data/pg-ref-mtg.json";
const INBOX = "data/pg-ref-inbox.json";
const OUT = "data/pg-ref-out.log";
const CALLS = "data/pg-ref-calls.log";

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

const channel = (id, tg, owner, over = {}) => ({
  id,
  channelId: String(tg),
  title: "Ch" + tg,
  username: "ch" + Math.abs(tg),
  ownerId: owner,
  ownerName: owner,
  botHasAdminRights: true,
  botAdminStatus: "ok",
  status: "active",
  verifiedSubscribers: 0,
  activeSubscribers: 0,
  pendingSubscriptions: 0,
  unsubscribedCount: 0,
  totalRequested: 0,
  controllers: [],
  createdAt: nowIso(),
  ...over
});

const task = (id, uid, dest, over = {}) => ({
  id,
  assignedTo: uid,
  orderId: "ord-ref",
  destinationId: dest,
  destinationTitle: "Ch",
  destinationUrl: "https://t.me/ch",
  platform: "telegram",
  status: "CHECK_ERROR",
  lastCheckResult: "error",
  lastCheckReason: "network",
  rewardCredits: 10,
  queueSequence: 1,
  consecutiveCheckErrors: 1,
  retryAt: new Date(Date.now() - 60000).toISOString(),
  createdAt: nowIso(),
  ...over
});

const job = (id, taskId, uid, key, over = {}) => ({
  id,
  membershipId: "",
  taskId,
  userId: uid,
  channelId: "",
  jobType: "TASK_CHECK",
  scheduledAt: new Date(Date.now() - 5000).toISOString(),
  status: "PENDING",
  attemptCount: 0,
  lastError: "",
  lockedAt: "",
  completedAt: "",
  idempotencyKey: key,
  ...over
});

const seed = {
  seq: 200,
  users: {
    9700: user(9700, 0),
    9701: user(9701, 0, { referredBy: "u-9700" }),
    9702: user(9702, 1000),
    9703: user(9703, 0, { referredBy: "u-9700" }),
    9704: user(9704, 0, { referredBy: "u-9700" }),
    9705: user(9705, 0, { credits: { available: 0, reserved: 5, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 }, activeOrdersCount: 1 })
  },
  channels: [
    channel("ch-ref", -4201, "u-9707"),
    channel("ch-own", -4202, "u-9702"),
    channel("ch-err", -4203, "u-9707"),
    channel("ch-low", -4204, "u-9705")
  ],
  igProfiles: [{ id: "ig-1", userId: "u-9701", username: "someig", status: "active", createdAt: nowIso() }],
  orders: [
    { id: "ord-ref", seq: 1, userId: "u-9707", userName: "u-9707", destinationId: "ch-ref", destinationTitle: "Ch-4201", platform: "telegram", requestedQuantity: 6, verifiedQuantity: 0, pendingQuantity: 6, cancelledQuantity: 0, unitCost: 1, totalCost: 6, freeUnits: 0, status: "active", createdAt: nowIso() },
    { id: "ord-LOW", seq: 2, userId: "u-9705", userName: "u-9705", destinationId: "ch-low", destinationTitle: "Ch-4204", platform: "telegram", requestedQuantity: 3, verifiedQuantity: 0, pendingQuantity: 3, cancelledQuantity: 0, unitCost: 10, totalCost: 30, freeUnits: 0, status: "active", createdAt: nowIso() }
  ],
  tasks: [
    task("t-ref", "u-9701", "ch-ref"),
    task("t-self", "u-9701", "ch-ref", { status: "SELF_CONFIRMED", lastCheckResult: "self", queueSequence: 2 }),
    task("t-err", "u-9701", "ch-err", { queueSequence: 3 }),
    task("t-ig", "u-9701", "ig-1", { platform: "instagram", queueSequence: 4 }),
    task("t-dup", "u-9703", "ch-ref", { queueSequence: 5 }),
    task("t-par", "u-9704", "ch-ref", { queueSequence: 6 })
  ],
  transactions: [
    { id: "tx-seed-9702", userId: "u-9702", amount: 1000, type: "admin_adjustment", idempotencyKey: "seed:9702", balanceAfter: 1000 },
    { id: "tx-seed-9705", userId: "u-9705", amount: 5, type: "admin_adjustment", idempotencyKey: "seed:9705", balanceAfter: 5 },
    { id: "tx-res-9705", userId: "u-9705", amount: -5, type: "order_spend", orderId: "ord-LOW", idempotencyKey: "reserve:ord-LOW" }
  ],
  memberships: [],
  membershipEvents: [],
  verificationJobs: [
    job("job-ref", "t-ref", "u-9701", "jr"),
    job("job-self", "t-self", "u-9701", "js"),
    job("job-err", "t-err", "u-9701", "je"),
    job("job-ig", "t-ig", "u-9701", "ji"),
    job("job-dup-a", "t-dup", "u-9703", "jd1"),
    job("job-dup-b", "t-dup", "u-9703", "jd2"),
    job("job-par", "t-par", "u-9704", "jp")
  ],
  referrals: [
    { id: "ref-1", referrerId: "u-9700", referrerName: "U9700", referredUserId: "u-9701", referredUserName: "U9701", isRegistered: true, hasCompletedTask: false, isVerified: false, bonusIssued: false, bonusAmount: 0 },
    { id: "ref-dup", referrerId: "u-9700", referrerName: "U9700", referredUserId: "u-9703", referredUserName: "U9703", isRegistered: true, hasCompletedTask: false, isVerified: false, bonusIssued: false, bonusAmount: 0 },
    { id: "ref-par", referrerId: "u-9700", referrerName: "U9700", referredUserId: "u-9704", referredUserName: "U9704", isRegistered: true, hasCompletedTask: false, isVerified: false, bonusIssued: false, bonusAmount: 0 }
  ],
  verifyErrors: [],
  sponsorMemberships: [],
  notifPeriods: [],
  complaints: [],
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
    hourlyNotificationsEnabled: false,
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(STATE, JSON.stringify({
  chats: { ch4202: { id: -4202, title: "Ch-4202" } },
  members: {
    "-4201|9701": "member",
    "-4201|9703": "member",
    "-4201|9704": "member",
    "-4203|9701": "server",
    "-4202|777000": "administrator",
    "-4202|9702": "creator",
    "-4204|777000": "administrator",
    "-4207|777000": "administrator"
  }
}));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

let pgApi = null;
let mock = null;
const servers = [];

function startServer(tag = "A") {
  const p = spawn("node", ["server.js"], {
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
  p.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${tag}] ` + d));
  p.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${tag}:err] ` + d));
  servers.push(p);
  return p;
}
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
const runJobs = () => apiPost("jobs", { action: "verify", limit: 25 });

async function waitState(fn, ms = 15000) {
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
const refTxs = (state, refId) => (state.transactions || []).filter((t) => t.idempotencyKey === "refreward:" + refId);

/* ─── bot haydash ─── */
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
const lastText = (chat) => {
  const rows = outbox().filter((x) => String(x.chat) === String(chat));
  return rows.length ? String(rows[rows.length - 1].text || "") : "";
};
const allText = (chat) => outbox().filter((x) => String(x.chat) === String(chat)).map((x) => String(x.text || "")).join("\n");
async function say(id, text, wait = 900) {
  push(msg(id, text));
  await sleep(wait);
}
async function click(id, data, wait = 900) {
  push(cb(id, data));
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
  check("PG: holat yozildi", !!(await waitState((s) => s && s.users && s.users["9700"])));
  await sleep(1200);

  /* ═══════ 1. Referal job E2E (real getChatMember → job → tryQualifyReferral) ═══════ */
  const j1 = await runJobs();
  check("JOB: verify trigger ishladi", j1.ok === true, JSON.stringify(j1.body));
  let st = await waitState((s) => s.tasks.find((t) => t.id === "t-ref").status === "VERIFIED");
  check("JOB: t-ref getChatMember orqali VERIFIED", st.tasks.find((t) => t.id === "t-ref").status === "VERIFIED");
  check("JOB: vazifa mukofoti berildi (10)", (st.transactions || []).some((t) => t.idempotencyKey === "reward:t-ref"));
  const rt = refTxs(st, "ref-1");
  check("JOB: REFERRAL_REWARD bitta yozuv +300", rt.length === 1 && Number(rt[0].amount) === 300, JSON.stringify(rt));
  // Bir trigger barcha muddati kelgan joblarni bajaradi — shu sabab balans
  // berilgan bonuslar soniga teng bo'lishi kerak (har biri 300).
  const refRewards = (st.transactions || []).filter((t) => t.type === "REFERRAL_REWARD");
  check("JOB: referrer hamyoni = 300 × bonuslar soni",
    st.users["9700"].credits.available === 300 * refRewards.length && refRewards.length >= 1,
    `${st.users["9700"].credits.available} vs ${300 * refRewards.length}`);
  check("JOB: bonus bepul birlik emas", !(st.orders || []).some((o) => o.source === "referral_bonus"));
  check("JOB: referrer ledger ↔ hamyon farqi 0", parity(st, "u-9700").ok, JSON.stringify(parity(st, "u-9700")));

  // SELF_CONFIRMED / Instagram / CHECK_ERROR → referal mukofoti yo'q.
  check("JOB: SELF_CONFIRMED vazifa o'zgarmadi", st.tasks.find((t) => t.id === "t-self").status === "SELF_CONFIRMED");
  check("JOB: CHECK_ERROR vazifa CHECK_ERROR bo'lib qoldi", st.tasks.find((t) => t.id === "t-err").status === "CHECK_ERROR",
    st.tasks.find((t) => t.id === "t-err").status);
  check("JOB: Instagram vazifasi referal bermadi", !(st.transactions || []).some((t) => t.idempotencyKey === "reward:t-ig"));

  // Takroriy job: qayta ishga tushirish hech narsa qo'shmaydi.
  const balAfterFirst = st.users["9700"].credits.available;
  await runJobs();
  await sleep(1200);
  st = await pgApi.readState();
  check("JOB: takroriy triggerda reward takrorlanmadi", (st.transactions || []).filter((t) => t.idempotencyKey === "reward:t-ref").length === 1);
  check("JOB: takroriy triggerda referal takrorlanmadi", refTxs(st, "ref-1").length === 1);
  check("JOB: takroriy triggerda balans o'zgarmadi", st.users["9700"].credits.available === balAfterFirst,
    `${balAfterFirst} → ${st.users["9700"].credits.available}`);

  // Bitta vazifaga ikkita job (dublikat) → bitta reward, bitta referal bonusi.
  st = await waitState((s) => s.tasks.find((t) => t.id === "t-dup").status === "VERIFIED");
  check("JOB: dublikat joblar bitta reward berdi", (st.transactions || []).filter((t) => t.idempotencyKey === "reward:t-dup").length === 1);
  check("JOB: dublikat joblar bitta referal bonusi", refTxs(st, "ref-dup").length === 1, JSON.stringify(refTxs(st, "ref-dup")));

  // Parallel triggerlar → bitta reward.
  await Promise.all([runJobs(), runJobs()]);
  await sleep(1500);
  st = await pgApi.readState();
  check("JOB: parallel triggerlar bitta reward", (st.transactions || []).filter((t) => t.idempotencyKey === "reward:t-par").length === 1);
  check("JOB: parallel triggerlar bitta referal bonusi", refTxs(st, "ref-par").length === 1);
  check("JOB: referrer jami 900 kredit (3×300)", st.users["9700"].credits.available === 900, String(st.users["9700"].credits.available));
  check("JOB: referrer ledger farqi 0", parity(st, "u-9700").ok, JSON.stringify(parity(st, "u-9700")));

  /* ═══════ 2. Order idempotency (bot tugmasi) ═══════ */
  await say(9702, "/start", 1000);
  await click(9702, "ord:ch-own", 900);
  await say(9702, "10", 1200);
  st = await pgApi.readState();
  const tok = (st.users["9702"].state || {}).token;
  check("ORD: tasdiqlash tokeni yaratildi", /^[0-9a-f]{16}$/.test(String(tok || "")), JSON.stringify(st.users["9702"].state));

  const balBefore = st.users["9702"].credits.available;
  for (let i = 0; i < 20; i++) push(cb(9702, "ordok:" + tok));
  await sleep(6000);
  st = await pgApi.readState();
  const ords = st.orders.filter((o) => o.destinationId === "ch-own");
  check("ORD: 20 parallel so'rovdan bitta buyurtma", ords.length === 1, JSON.stringify(ords.map((o) => o.id)));
  check("ORD: bitta reservation yozuvi", (st.transactions || []).filter((t) => t.idempotencyKey === "reserve:" + ords[0].id).length === 1);
  check("ORD: balans faqat bir marta band", st.users["9702"].credits.available === balBefore - ords[0].totalCost,
    `${balBefore} → ${st.users["9702"].credits.available} (cost ${ords[0].totalCost})`);

  // Kechikkan (late) takroriy so'rov.
  await click(9702, "ordok:" + tok, 1500);
  st = await pgApi.readState();
  check("ORD: kechikkan takroriy so'rov yangi buyurtma yaratmadi", st.orders.filter((o) => o.destinationId === "ch-own").length === 1);
  check("ORD: kechikkan so'rovda balans o'zgarmadi", st.users["9702"].credits.available === balBefore - ords[0].totalCost);

  // Boshqa foydalanuvchi tokenini ishlatish → rad.
  await say(9701, "/start", 900);
  await click(9701, "ordok:" + tok, 1500);
  st = await pgApi.readState();
  check("ORD: boshqa foydalanuvchi tokenini ishlatolmadi", st.orders.filter((o) => o.userId === "u-9701").length === 0);

  // Miqdor mos kelmasa (eski token, yangi miqdor) → rad.
  await click(9702, "ord:ch-own", 900);
  await say(9702, "20", 1200);
  await click(9702, "ordok:" + tok, 1800);
  st = await pgApi.readState();
  check("ORD: miqdor mos kelmasa rad etildi", st.orders.filter((o) => o.destinationId === "ch-own").length === 1);
  check("ORD: mismatchdan keyin balans o'zgarmadi", st.users["9702"].credits.available === balBefore - ords[0].totalCost);

  /* ═══════ 3. Refund: reserved < refund ═══════ */
  await say(9705, "/start", 900);
  await click(9705, "cxy:ord-LOW", 1500);
  st = await pgApi.readState();
  check("REFUND: foydalanuvchi yo'lida reserved yetmasa rad", /nomuvofiqlik/.test(allText(9705)), lastText(9705));
  check("REFUND: balans/jurnal o'zgarmadi", st.users["9705"].credits.available === 0 && st.users["9705"].credits.reserved === 5,
    JSON.stringify(st.users["9705"].credits));
  check("REFUND: buyurtma active qoldi", st.orders.find((o) => o.id === "ord-LOW").status === "active");
  check("REFUND: admin yo'lida ham rad etildi", (await apiPost("order", { id: "ord-LOW", action: "cancel" })).ok === false);
  st = await pgApi.readState();
  check("REFUND: admin rad etgach ham o'zgarish yo'q", st.users["9705"].credits.reserved === 5 && !(st.transactions || []).some((t) => t.type === "order_refund" && t.orderId === "ord-LOW"));

  // Oddiy bekor qilish (yangi buyurtma) — qaytim ishlaydi va ledger mos qoladi.
  const ordNew = st.orders.find((o) => o.destinationId === "ch-own");
  const cancel = await apiPost("order", { id: ordNew.id, action: "cancel" });
  check("REFUND: oddiy bekor qilish muvaffaqiyatli", cancel.ok === true && Number(cancel.body.refundCredits) === Number(ordNew.totalCost),
    JSON.stringify(cancel.body));
  st = await waitState((s) => s.orders.find((o) => o.id === ordNew.id).status === "cancelled");
  check("REFUND: reserved 0 ga tushdi", st.users["9702"].credits.reserved === 0, String(st.users["9702"].credits.reserved));
  check("REFUND: balans qaytdi", st.users["9702"].credits.available === balBefore, `${balBefore} → ${st.users["9702"].credits.available}`);
  check("REFUND: bitta refund yozuvi", (st.transactions || []).filter((t) => t.type === "order_refund" && t.orderId === ordNew.id).length === 1);
  check("REFUND: ledger farqi 0 (u-9702)", parity(st, "u-9702").ok, JSON.stringify(parity(st, "u-9702")));

  for (const p of servers) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
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
  for (const p of servers) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
  try {
    mock && mock.kill();
  } catch {}
  try {
    pgApi && (await pgApi.stop());
  } catch {}
  process.exit(1);
});
