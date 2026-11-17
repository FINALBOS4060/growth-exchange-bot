// CONCURRENCY + ROLLBACK (haqiqiy PostgreSQL): rollback boshqa handler yozgan
// yozuvlarni o'chirmasligi isbotlanadi.
//
// Xato in'ektsiyasi: `app_state` ga BEFORE trigger o'rnatiladi — u FAQAT
// belgilangan vazifa `VERIFIED` bo'lgan payload'da ishlaydi, `delay_ms` kutadi
// va xato ko'taradi. Shu bilan persist kutish oynasida boshqa handler yozishi
// mumkin bo'ladi.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const PORT = 5611;
const MOCK = 5612;
const PGPORT = 55830;
const PG_DIR = "data/pg-conc-data";
const DB = "data/pg-conc-seed.json";
const STATE = "data/pg-conc-mtg.json";
const INBOX = "data/pg-conc-inbox.json";
const OUT = "data/pg-conc-out.log";
const CALLS = "data/pg-conc-calls.log";

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

const order = (id, seq) => ({
  id, seq, userId: "u-9799", userName: "u-9799", destinationId: "ch-c", destinationTitle: "ChC",
  platform: "telegram", requestedQuantity: 5, verifiedQuantity: 0, pendingQuantity: 5, cancelledQuantity: 0,
  unitCost: 1, totalCost: 5, freeUnits: 5, status: "active", createdAt: nowIso()
});

const task = (id, uid, orderId, status, seq) => ({
  id, assignedTo: uid, orderId, destinationId: "ch-c", destinationTitle: "ChC",
  destinationUrl: "https://t.me/chc", platform: "telegram", status, rewardCredits: 10,
  queueSequence: seq, createdAt: nowIso(), ...(status === "CHECK_ERROR" ? { lastCheckResult: "error", retryAt: nowIso() } : {})
});

const seed = {
  seq: 400,
  users: {
    9710: user(9710), 9711: user(9711), 9712: user(9712), 9713: user(9713),
    9714: user(9714), 9715: user(9715), 9799: user(9799)
  },
  channels: [{
    id: "ch-c", channelId: "-4401", title: "ChC", username: "chc", ownerId: "u-9799", ownerName: "u-9799",
    botHasAdminRights: true, botAdminStatus: "ok", status: "active", verifiedSubscribers: 0,
    activeSubscribers: 0, pendingSubscriptions: 6, unsubscribedCount: 0, totalRequested: 6,
    controllers: [], createdAt: nowIso()
  }],
  igProfiles: [],
  orders: [
    order("ord-a", 1), order("ord-b", 2), order("ord-12", 3), order("ord-13", 4),
    order("ord-c1", 5), order("ord-c2", 6)
  ],
  tasks: [
    task("t-a", "u-9710", "ord-a", "PENDING", 1),
    task("t-b", "u-9711", "ord-b", "PENDING", 2),
    task("t-12", "u-9712", "ord-12", "PENDING", 3),
    task("t-13", "u-9713", "ord-13", "CHECK_ERROR", 4),
    task("t-c1", "u-9714", "ord-c1", "PENDING", 5),
    task("t-c2", "u-9715", "ord-c2", "PENDING", 6)
  ],
  transactions: [],
  memberships: [],
  membershipEvents: [],
  verificationJobs: [{
    id: "job-13", membershipId: "", taskId: "t-13", userId: "u-9713", channelId: "ch-c",
    jobType: "TASK_CHECK", scheduledAt: new Date(Date.now() - 5000).toISOString(),
    status: "PENDING", attemptCount: 0, lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "j13"
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
    "-4401|9710": "member", "-4401|9711": "member", "-4401|9712": "member",
    "-4401|9713": "member", "-4401|9714": "member", "-4401|9715": "member",
    "-4401|777000": "administrator"
  },
  chats: {}
}));
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
const rewardOf = (state, taskId) => (state.transactions || []).filter((t) => t.idempotencyKey === "reward:" + taskId);
const taskOf = (state, id) => state.tasks.find((t) => t.id === id);

/* ─── xato in'ektsiyasi ─── */
async function ensureGuardTable() {
  await pgApi.query("CREATE SEQUENCE IF NOT EXISTS fail_seq START 1");
  await pgApi.query("CREATE TABLE IF NOT EXISTS fail_flag (id int PRIMARY KEY, budget int NOT NULL DEFAULT 0)");
  await pgApi.query("INSERT INTO fail_flag (id, budget) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET budget = 0");
}
// Trigger faqat `taskId` VERIFIED bo'lgan payload'da hisoblaydi. Hisoblagich —
// SEQUENCE: `nextval` tranzaksiya bekor qilinsa ham qaytmaydi (oddiy UPDATE
// `RAISE EXCEPTION` bilan birga qaytarilib ketardi).
async function armGuard(taskId, delayMs) {
  const tid = String(taskId).replace(/'/g, "''");
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

async function main() {
  pgApi = await startPg({ dir: PG_DIR, port: PGPORT });
  mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
    env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
    stdio: "ignore"
  });
  startServer();
  await waitHttp();
  check("PG: holat yozildi", !!(await waitState((s) => s && s.tasks && s.tasks.length === 6)));
  await sleep(1000);
  await ensureGuardTable();

  /* ═══ A. verifyBatch yiqiladi, boshqa handler yozuvi SAQLANADI ═══ */
  await armGuard("t-a", 2500);
  push(cb(9710, "verify:tg")); // A: persist 2.5 s kutadi va yiqiladi
  await sleep(400);
  push(cb(9711, "verify:tg")); // B: shu oynada mutatsiya qiladi
  await sleep(6000);
  let st = await pgApi.readState();
  check("A: yiqilgan foydalanuvchi vazifasi PENDING", taskOf(st, "t-a").status === "PENDING", taskOf(st, "t-a").status);
  check("A: yiqilgan reward yozilmadi", rewardOf(st, "t-a").length === 0);
  check("A: yiqilgan foydalanuvchi balansi 0", st.users["9710"].credits.available === 0, String(st.users["9710"].credits.available));
  check("A: yiqilgan foydalanuvchi a'zoligi yo'q", !(st.memberships || []).some((m) => m.userId === "u-9710"));

  check("B: parallel handler vazifasi VERIFIED", taskOf(st, "t-b").status === "VERIFIED", taskOf(st, "t-b").status);
  check("B: parallel handler reward yozuvi SAQLANDI", rewardOf(st, "t-b").length === 1, JSON.stringify(rewardOf(st, "t-b")));
  check("B: parallel handler balansi +10", st.users["9711"].credits.available === 10, String(st.users["9711"].credits.available));
  check("B: membershipEvent SAQLANDI", (st.membershipEvents || []).some((e) => e.userId === "u-9711" && e.eventType === "FIRST_VERIFIED"),
    JSON.stringify((st.membershipEvents || []).map((e) => e.userId + ":" + e.eventType)));
  check("B: verifyLog SAQLANDI", (st.verifyLog || []).some((l) => l.ownerId === "u-9799" && l.at), String((st.verifyLog || []).length));
  check("B: a'zolik yozuvi SAQLANDI", (st.memberships || []).some((m) => m.userId === "u-9711"));
  check("B: order hisoblagichi (verifiedQuantity=1)", st.orders.find((o) => o.id === "ord-b").verifiedQuantity === 1);
  check("A+B: yiqilgan order tegmagan", st.orders.find((o) => o.id === "ord-a").verifiedQuantity === 0);
  check("A: ledger farqi 0", parity(st, "u-9710").ok, JSON.stringify(parity(st, "u-9710")));
  check("B: ledger farqi 0", parity(st, "u-9711").ok, JSON.stringify(parity(st, "u-9711")));

  /* ═══ B. runTaskCheckJob yiqiladi, boshqa handler yozuvi SAQLANADI ═══ */
  await armGuard("t-13", 2500);
  const cookie = await login();
  const jobsPromise = fetch(`http://127.0.0.1:${PORT}/api/admin/jobs`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "verify", limit: 25 })
  }).catch(() => null);
  await sleep(400);
  push(cb(9712, "verify:tg")); // boshqa handler
  await sleep(6500);
  await jobsPromise;
  st = await pgApi.readState();
  const job = st.verificationJobs.find((j) => j.id === "job-13");
  check("JOB: yiqilgan job PENDING ga qaytdi", job.status === "PENDING", job.status);
  check("JOB: sabab save_failed", /save_failed/.test(String(job.lastError || "")), String(job.lastError));
  check("JOB: job qayta rejalashtirildi", Date.parse(job.scheduledAt) > Date.now() - 60000, job.scheduledAt);
  check("JOB: yiqilgan vazifa CHECK_ERROR", taskOf(st, "t-13").status === "CHECK_ERROR", taskOf(st, "t-13").status);
  check("JOB: yiqilgan reward yo'q", rewardOf(st, "t-13").length === 0);
  check("JOB: yiqilgan foydalanuvchi balansi 0", st.users["9713"].credits.available === 0, String(st.users["9713"].credits.available));
  check("JOB: parallel handler VERIFIED", taskOf(st, "t-12").status === "VERIFIED", taskOf(st, "t-12").status);
  check("JOB: parallel handler reward SAQLANDI", rewardOf(st, "t-12").length === 1);
  check("JOB: parallel handler balansi +10", st.users["9712"].credits.available === 10, String(st.users["9712"].credits.available));
  check("JOB: parallel handler a'zoligi SAQLANDI", (st.memberships || []).some((m) => m.userId === "u-9712"));

  /* ═══ C. Ikki verifyBatch parallel, bittasi yiqiladi ═══ */
  await armGuard("t-c1", 2000);
  const beforeEvents = (st.membershipEvents || []).length;
  push(cb(9714, "verify:tg"));
  push(cb(9715, "verify:tg"));
  await sleep(7000);
  st = await pgApi.readState();
  const c1 = taskOf(st, "t-c1").status;
  const c2 = taskOf(st, "t-c2").status;
  const verifiedCount = [c1, c2].filter((x) => x === "VERIFIED").length;
  check("C: aynan bitta vazifa VERIFIED", verifiedCount === 1, `${c1} / ${c2}`);
  check("C: aynan bitta reward yozuvi", rewardOf(st, "t-c1").length + rewardOf(st, "t-c2").length === 1,
    JSON.stringify([rewardOf(st, "t-c1").length, rewardOf(st, "t-c2").length]));
  const balSum = st.users["9714"].credits.available + st.users["9715"].credits.available;
  check("C: balanslar yig'indisi 10", balSum === 10, String(balSum));
  check("C: yiqilgan foydalanuvchida a'zolik yo'q", (st.memberships || []).filter((m) => ["u-9714", "u-9715"].includes(m.userId)).length === 1,
    JSON.stringify((st.memberships || []).filter((m) => ["u-9714", "u-9715"].includes(m.userId)).map((m) => m.userId)));
  check("C: membershipEvent bittadan oshmadi", (st.membershipEvents || []).length - beforeEvents === 1,
    String((st.membershipEvents || []).length - beforeEvents));
  check("C: ikkala foydalanuvchida drift yo'q", parity(st, "u-9714").ok && parity(st, "u-9715").ok,
    JSON.stringify([parity(st, "u-9714").ok, parity(st, "u-9715").ok]));

  /* ═══ Yakuniy moslik ═══ */
  await disarmGuard();
  const ids = ["u-9710", "u-9711", "u-9712", "u-9713", "u-9714", "u-9715"];
  check("YAKUN: barcha foydalanuvchilarda ledger ↔ hamyon farqi 0", ids.every((id) => parity(st, id).ok),
    JSON.stringify(ids.map((id) => [id, parity(st, id).ok])));
  check("YAKUN: yiqilgan operatsiyalardan ortiqcha yozuv qolmadi",
    rewardOf(st, "t-a").length === 0 && rewardOf(st, "t-13").length === 0);

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
