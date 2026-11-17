// KO'P INSTANS — ikkita MUSTAQIL `server.js` jarayoni, bitta PostgreSQL.
//
// Har bir jarayonning o'z `dbPool`, o'z xotira holati va o'z HTTP porti bor.
// Maqsad: `app_state` ning bitta JSONB qatori bilan ishlaydigan arxitekturada
// ham yo'qolgan yozuv (lost update) va dublikat to'lov bo'lmasligini isbotlash.
//
// Himoya: `gxb:state` advisory lock (o'qish → tekshirish → mutatsiya → yozish
// to'liq qulf ostida) + `rev` bo'yicha CAS + uch tomonlama merge.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const PA = 5631;
const PB = 5632;
const MOCK = 5633;
const PGPORT = 55861;
const PG_DIR = "data/pg-multi-data";
const DB = "data/pg-multi-seed.json";
const STATE = "data/pg-multi-mtg.json";
const INBOX = "data/pg-multi-inbox.json";
const OUT = "data/pg-multi-out.log";
const CALLS = "data/pg-multi-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const user = (tid) => ({
  id: "u-" + tid,
  telegramId: tid,
  username: "u" + tid,
  displayName: "U" + tid,
  language: "uz",
  credits: { available: 0, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(),
  referralCode: "REF_" + tid,
  isReferralVerified: false,
  completedTasksCount: 0,
  activeOrdersCount: 0,
  status: "active",
  chatId: tid,
  botId: "bot-main",
  notifications: false,
  notif: { subscribers: false, referrals: false, orders: false, technical: false }
});

const order = (id, seq, uid, qty, cost, freeUnits = 0) => ({
  id, seq, userId: uid, userName: uid, destinationId: "ch-m", destinationTitle: "ChM",
  platform: "telegram", requestedQuantity: qty, verifiedQuantity: 0, pendingQuantity: qty,
  cancelledQuantity: 0, unitCost: 1, totalCost: cost, freeUnits, status: "active", createdAt: nowIso()
});

const task = (id, uid, orderId, status, seq, reward = 10) => ({
  id, assignedTo: uid, orderId, destinationId: "ch-m", destinationTitle: "ChM",
  destinationUrl: "https://t.me/chm", platform: "telegram", status, rewardCredits: reward,
  queueSequence: seq, createdAt: nowIso(),
  ...(status === "CHECK_ERROR" ? { lastCheckResult: "error", retryAt: nowIso() } : {})
});

const seed = {
  seq: 500,
  users: {
    9740: user(9740), 9741: user(9741), 9742: user(9742),
    9743: { ...user(9743), credits: { available: 0, reserved: 30, spent: 0, refunded: 0, verifiedRewards: 30, selfReportedRewards: 0, signupBonus: 0 }, activeOrdersCount: 1 },
    9744: user(9744), 9799: user(9799)
  },
  channels: [{
    id: "ch-m", channelId: "-5501", title: "ChM", username: "chm", ownerId: "u-9799", ownerName: "u-9799",
    botHasAdminRights: true, botAdminStatus: "ok", status: "active", verifiedSubscribers: 0,
    activeSubscribers: 0, pendingSubscriptions: 60, unsubscribedCount: 0, totalRequested: 60,
    controllers: [], createdAt: nowIso()
  }],
  igProfiles: [],
  orders: [
    order("ord-a", 1, "u-9799", 50, 50, 50),
    order("ord-b", 2, "u-9799", 50, 50, 50),
    order("ord-f", 3, "u-9799", 50, 50, 50),
    order("ord-j", 4, "u-9799", 50, 50, 50),
    order("ord-r", 5, "u-9743", 30, 30)
  ],
  tasks: [
    task("t-a", "u-9740", "ord-a", "PENDING", 1),
    task("t-f", "u-9741", "ord-f", "PENDING", 2),
    task("t-j", "u-9742", "ord-j", "PENDING", 3),
    task("t-b", "u-9744", "ord-b", "PENDING", 4)
  ],
  // u-9743: 30 kredit ishlab, hammasi `ord-r` ga band qilingan (reserved 30).
  transactions: [
    { id: "tx-s1", userId: "u-9743", userName: "u-9743", amount: 30, type: "reward_task", description: "seed", createdAt: nowIso(), idempotencyKey: "seed:u-9743" },
    { id: "tx-s2", userId: "u-9743", userName: "u-9743", amount: -30, type: "order_spend", description: "seed", orderId: "ord-r", createdAt: nowIso(), idempotencyKey: "reserve:ord-r" }
  ],
  memberships: [],
  membershipEvents: [],
  verificationJobs: [{
    id: "job-b", membershipId: "", taskId: "t-b", userId: "u-9744", channelId: "ch-m",
    jobType: "TASK_CHECK", scheduledAt: new Date(Date.now() - 10000).toISOString(),
    status: "PENDING", attemptCount: 0, lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "jb"
  }],
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
    isInstagramEnabled: false,
    hourlyNotificationsEnabled: false,
    rulesVersion: 3,
    bonusRuleVersion: 2,
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(STATE, JSON.stringify({
  members: {
    "-5501|9740": "member", "-5501|9741": "member", "-5501|9742": "member",
    "-5501|9743": "member", "-5501|9744": "member", "-5501|777000": "administrator"
  },
  chats: {}
}));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

let pgApi = null;
let mock = null;
const srv = { A: null, B: null };
const cookie = { A: "", B: "" };
const PORT = { A: PA, B: PB };

function startServer(tag) {
  srv[tag] = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT[tag]),
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
  srv[tag].stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${tag}] ` + d));
  srv[tag].stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${tag}:err] ` + d));
}
async function waitHttp(port) {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server ${port} ko'tarilmadi`);
}
async function login(port) {
  const r = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function api(tag, route, body) {
  const r = await fetch(`http://127.0.0.1:${PORT[tag]}/api/admin/${route}`, {
    method: "POST",
    headers: { cookie: cookie[tag], "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok !== false, status: r.status, body: j };
}
async function get(tag, route) {
  const r = await fetch(`http://127.0.0.1:${PORT[tag]}/api/admin/${route}`, { headers: { cookie: cookie[tag] } });
  return r.json().catch(() => ({}));
}
async function waitState(fn, ms = 20000) {
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
    wallet: { available: u.credits.available, reserved: u.credits.reserved, spent: u.credits.spent }
  };
}
const rewardOf = (state, taskId) => (state.transactions || []).filter((t) => t.idempotencyKey === "reward:" + taskId);
const taskOf = (state, id) => state.tasks.find((t) => t.id === id);
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
// Qaysi instans polling qilmoqda? (Telegram qulfi bitta jarayonda).
async function pollerTag() {
  for (const tag of ["A", "B"]) {
    try {
      const h = await get(tag, "health");
      const online = (h.bots || []).filter((b) => b.online).length;
      if (online > 0) return tag;
    } catch {}
  }
  return "";
}

/* ─── persist xatosi in'ektsiyasi (faqat tanlangan vazifa VERIFIED bo'lganda) ─── */
async function armGuard(taskId, delayMs) {
  const tid = String(taskId).replace(/'/g, "''");
  await pgApi.query("CREATE SEQUENCE IF NOT EXISTS fail_seq START 1");
  await pgApi.query("CREATE TABLE IF NOT EXISTS fail_flag (id int PRIMARY KEY, budget int NOT NULL DEFAULT 0)");
  await pgApi.query("INSERT INTO fail_flag (id, budget) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET budget = 0");
  await pgApi.query(`CREATE OR REPLACE FUNCTION app_state_guard() RETURNS trigger AS $$
DECLARE v bigint;
BEGIN
  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.data -> 'tasks') t
       WHERE t ->> 'id' = '${tid}' AND t ->> 'status' = 'VERIFIED'
     ) THEN
    v := nextval('fail_seq');
    IF v <= (SELECT budget FROM fail_flag WHERE id = 1) THEN
      PERFORM pg_sleep(${Number(delayMs) / 1000});
      RAISE EXCEPTION 'injected persist failure';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;`);
  await pgApi.query("DROP TRIGGER IF EXISTS app_state_guard_trg ON app_state");
  await pgApi.query("CREATE TRIGGER app_state_guard_trg BEFORE INSERT OR UPDATE ON app_state FOR EACH ROW EXECUTE FUNCTION app_state_guard()");
  await pgApi.query("UPDATE fail_flag SET budget = 1 WHERE id = 1");
  await pgApi.query("ALTER SEQUENCE fail_seq RESTART WITH 1");
}
async function disarmGuard() {
  await pgApi.query("UPDATE fail_flag SET budget = 0 WHERE id = 1");
}

async function main() {
  pgApi = await startPg({ dir: PG_DIR, port: PGPORT });
  mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
    env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
    stdio: "ignore"
  });
  startServer("A");
  await waitHttp(PA);
  startServer("B");
  await waitHttp(PB);
  cookie.A = await login(PA);
  cookie.B = await login(PB);
  check("IKKI INSTANS: ikkalasi ham ko'tarildi", !!(await waitState((s) => s && s.users && s.users["9740"])));
  await sleep(1500);

  const poller = await pollerTag();
  const other = poller === "A" ? "B" : "A";
  check("IKKI INSTANS: faqat bitta instans polling qiladi", !!poller, `poller=${poller}`);

  /* ═══ 1. Ikki instans bir foydalanuvchi balansini parallel o'zgartiradi ═══ */
  // 10 ta so'rov A ga, 10 ta B ga — bir vaqtda. Yo'qolgan yozuv bo'lsa
  // balans 20×10 dan kam bo'ladi.
  const adj = [];
  for (let i = 0; i < 10; i++) {
    adj.push(api("A", "user", { telegramId: 9740, action: "credits", amount: 10, client_token: "multi-a" + i }));
    adj.push(api("B", "user", { telegramId: 9740, action: "credits", amount: 10, client_token: "multi-b" + i }));
  }
  const adjRes = await Promise.all(adj);
  const adjOk = adjRes.filter((r) => r.ok).length;
  let st = await waitState((s) => s.users["9740"].credits.available === 200, 25000);
  check("PARALLEL BALANS: barcha 20 so'rov muvaffaqiyatli", adjOk === 20, `${adjOk}/20 ${JSON.stringify(adjRes.filter((r) => !r.ok).map((r) => r.body))}`);
  check("PARALLEL BALANS: yo'qolgan yozuv yo'q (200 kredit)", st.users["9740"].credits.available === 200, String(st.users["9740"].credits.available));
  const adjTx = (st.transactions || []).filter((t) => t.type === "admin_adjustment" && t.userId === "u-9740");
  check("PARALLEL BALANS: aynan 20 ta jurnal yozuvi", adjTx.length === 20, String(adjTx.length));
  check("PARALLEL BALANS: dublikat idempotency kaliti yo'q", new Set(adjTx.map((t) => t.idempotencyKey)).size === 20);
  check("PARALLEL BALANS: ledger ↔ hamyon farqi 0", parity(st, "u-9740").ok, JSON.stringify(parity(st, "u-9740")));

  /* ═══ 2. Ikki instans bir vazifa uchun reward beradi (job + tugma) ═══ */
  // `t-b` uchun TASK_CHECK jobi muddati kelgan. Bir instans tugma orqali
  // (verifyBatch), ikkinchisi job orqali tasdiqlaydi — reward FAQAT bitta.
  push(cb(9744, "verify:tg"));
  await sleep(250);
  const jobCalls = await Promise.all([api(poller, "jobs", { action: "verify", limit: 25 }), api(other, "jobs", { action: "verify", limit: 25 })]);
  st = await waitState((s) => taskOf(s, "t-b").status === "VERIFIED", 25000);
  await sleep(1500);
  st = await pgApi.readState();
  check("DUBLIKAT REWARD: t-b VERIFIED", taskOf(st, "t-b").status === "VERIFIED", taskOf(st, "t-b").status);
  check("DUBLIKAT REWARD: aynan 1 ta reward yozuvi", rewardOf(st, "t-b").length === 1, JSON.stringify(rewardOf(st, "t-b")).slice(0, 200));
  check("DUBLIKAT REWARD: balans +10 (bir marta)", st.users["9744"].credits.available === 10, String(st.users["9744"].credits.available));
  check("DUBLIKAT REWARD: order.verifiedQuantity = 1", st.orders.find((o) => o.id === "ord-b").verifiedQuantity === 1,
    String(st.orders.find((o) => o.id === "ord-b").verifiedQuantity));
  check("DUBLIKAT REWARD: a'zolik yozuvi bitta", (st.memberships || []).filter((m) => m.userId === "u-9744").length === 1,
    JSON.stringify((st.memberships || []).filter((m) => m.userId === "u-9744").map((m) => m.id)));
  check("DUBLIKAT REWARD: ledger farqi 0", parity(st, "u-9744").ok, JSON.stringify(parity(st, "u-9744")));
  check("DUBLIKAT REWARD: job yopilgan (takror ishlamaydi)", !(st.verificationJobs || []).some((j) => j.taskId === "t-b" && j.status === "PENDING"),
    JSON.stringify((st.verificationJobs || []).filter((j) => j.taskId === "t-b").map((j) => j.status)) + " " + JSON.stringify(jobCalls.map((r) => r.status)));

  /* ═══ 3. Ikki instans bir orderni bekor qiladi (qaytim ikki marta bo'lmasin) ═══ */
  const resBefore = st.users["9743"].credits.reserved;
  const refRes = await Promise.all([api("A", "order", { id: "ord-r", action: "cancel" }), api("B", "order", { id: "ord-r", action: "cancel" })]);
  st = await waitState((s) => s.orders.find((o) => o.id === "ord-r").status === "cancelled", 20000);
  await sleep(1200);
  st = await pgApi.readState();
  const refundTx = (st.transactions || []).filter((t) => t.idempotencyKey === "refund:ord-r");
  check("DUBLIKAT REFUND: order bir marta bekor qilindi", st.orders.find((o) => o.id === "ord-r").status === "cancelled");
  check("DUBLIKAT REFUND: aynan 1 ta qaytim yozuvi", refundTx.length === 1, JSON.stringify(refundTx).slice(0, 200));
  check("DUBLIKAT REFUND: reserved 0 ga tushdi", st.users["9743"].credits.reserved === 0, `${resBefore} → ${st.users["9743"].credits.reserved}`);
  check("DUBLIKAT REFUND: available +30 (bir marta)", st.users["9743"].credits.available === 30, String(st.users["9743"].credits.available));
  check("DUBLIKAT REFUND: ledger farqi 0", parity(st, "u-9743").ok, JSON.stringify(parity(st, "u-9743")));
  check("DUBLIKAT REFUND: javoblardan biri rad etildi", refRes.some((r) => !r.ok), JSON.stringify(refRes.map((r) => r.status)));

  /* ═══ 4. Bir instans persist xatosiga uchraydi, ikkinchisi yozadi ═══ */
  await armGuard("t-f", 2500);
  const beforeOther = (await pgApi.readState()).users["9740"].credits.available;
  push(cb(9741, "verify:tg")); // poller: t-f → reward → persist yiqiladi
  await sleep(500);
  const otherWrite = await api(other, "user", { telegramId: 9740, action: "credits", amount: 5, client_token: "multi-during-fail" });
  await sleep(6000);
  await disarmGuard();
  st = await pgApi.readState();
  check("PERSIST XATOSI: yiqilgan instans vazifasi PENDING", taskOf(st, "t-f").status === "PENDING", taskOf(st, "t-f").status);
  check("PERSIST XATOSI: yiqilgan reward yozilmadi", rewardOf(st, "t-f").length === 0);
  check("PERSIST XATOSI: foydalanuvchi balansi 0", st.users["9741"].credits.available === 0, String(st.users["9741"].credits.available));
  check("PERSIST XATOSI: ikkinchi instans yozuvi SAQLANDI", otherWrite.ok && st.users["9740"].credits.available === beforeOther + 5,
    `${beforeOther} → ${st.users["9740"].credits.available} (${JSON.stringify(otherWrite.body)})`);
  check("PERSIST XATOSI: ikkinchi instans jurnali bazada", (st.transactions || []).some((t) => t.idempotencyKey === "adminadj:panel:owner:multi-during-fail"));
  check("PERSIST XATOSI: ikkala foydalanuvchida drift 0", parity(st, "u-9740").ok && parity(st, "u-9741").ok,
    JSON.stringify([parity(st, "u-9740").ok, parity(st, "u-9741").ok]));

  /* ═══ 5. Eski xotira snapshot'i yangi yozuvni bosib ketmaydi ═══ */
  // A pul yozadi (to'liq JSON hujjat), B esa boshqa maydonni (status) yozadi.
  // B ning debounce oynasi A ning yozuvidan keyin tugaydi — merge bo'lmasa
  // A ning krediti B ning eski nusxasi bilan o'chib ketardi.
  const bBefore = (await pgApi.readState()).users["9742"].credits.available;
  const w1 = await api("A", "user", { telegramId: 9742, action: "credits", amount: 7, client_token: "multi-stale-1" });
  const w2 = await api("B", "user", { telegramId: 9742, action: "block" });
  await sleep(2500);
  const w3 = await api("B", "user", { telegramId: 9742, action: "unblock" });
  await sleep(2500);
  st = await pgApi.readState();
  check("STALE WRITE: ikkala yozuv ham saqlandi (kredit)", st.users["9742"].credits.available === bBefore + 7,
    `${bBefore} → ${st.users["9742"].credits.available} (${JSON.stringify([w1.body, w2.body, w3.body])})`);
  check("STALE WRITE: status yozuvi saqlandi", st.users["9742"].status === "active", st.users["9742"].status);
  check("STALE WRITE: bitta jurnal yozuvi", (st.transactions || []).filter((t) => t.idempotencyKey === "adminadj:panel:owner:multi-stale-1").length === 1);
  check("STALE WRITE: ledger farqi 0", parity(st, "u-9742").ok, JSON.stringify(parity(st, "u-9742")));

  /* ═══ 6. Yakuniy izchillik ═══ */
  st = await pgApi.readState();
  const ids = ["u-9740", "u-9741", "u-9742", "u-9743", "u-9744"];
  check("YAKUN: barcha foydalanuvchilarda ledger ↔ hamyon farqi 0", ids.every((id) => parity(st, id).ok),
    JSON.stringify(ids.map((id) => [id, parity(st, id).ok])));
  const dupKeys = {};
  for (const t of st.transactions || []) if (t.idempotencyKey) dupKeys[t.idempotencyKey] = (dupKeys[t.idempotencyKey] || 0) + 1;
  check("YAKUN: dublikat idempotency kaliti yo'q", Object.values(dupKeys).every((n) => n === 1),
    JSON.stringify(Object.entries(dupKeys).filter(([, n]) => n > 1)));
  const r = await pgApi.query("SELECT rev FROM app_state WHERE id = 1");
  check("YAKUN: app_state.rev o'sgan (CAS yozuvlari)", Number(r.rows[0].rev) > 10, String(r.rows[0].rev));
  // Polling hali ham bitta instansda: ikkalasi bir tokenni tortib olmaydi.
  const p1 = await pollerTag();
  const onlineA = ((await get("A", "health")).bots || []).filter((b) => b.online).length;
  const onlineB = ((await get("B", "health")).bots || []).filter((b) => b.online).length;
  check("YAKUN: bir vaqtda faol polling instansi = 1", onlineA + onlineB === 1, `A=${onlineA} B=${onlineB} poller=${p1}`);

  for (const t of ["A", "B"]) {
    try {
      srv[t].kill("SIGTERM");
    } catch {}
  }
  await sleep(800);
  try {
    mock.kill();
  } catch {}
  await pgApi.stop();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  for (const t of ["A", "B"]) {
    try {
      srv[t] && srv[t].kill("SIGTERM");
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
