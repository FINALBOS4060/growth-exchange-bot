// Qayta urinish (retry) scheduler xavfsizligi uchun acceptance testlar.
//
// Tekshiriladi (spec §3):
//  1. Muddati kelmagan job bajarilmaydi.
//  2. Muddati kelgan job bajariladi.
//  3. Bir vaqtda ikkita ishga tushirish bir jobni ikki marta bajarmaydi.
//  4. Crash bo'lgan RUNNING job xavfsiz tiklanadi.
//  5. 429 retry_after saqlanadi va obunadan chiqish deb hisoblanmaydi.
//  6. Ikki instans bir vaqtda ishlasa ham mukofot takrorlanmaydi.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3976;
const PORT2 = 3977;
const MOCK = 3975;
const DB = "data/retry-test-db.json";
const STATE = "data/retry-state.json";
const INBOX = "data/retry-inbox.json";
const OUT = "data/retry-out.log";
const CALLS = "data/retry-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const readDb = () => JSON.parse(fs.readFileSync(DB, "utf8"));

let seq = 9500;
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

const members = {};
const channels = [];
const orders = [];
const tasks = [];

function addCase(tg, mode) {
  const chId = "ch-" + tg;
  channels.push({
    id: chId,
    channelId: String(tg),
    title: "C" + tg,
    username: "c" + Math.abs(tg),
    ownerId: "u-9400",
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
  const ordId = "ord-" + tg;
  orders.push({
    id: ordId,
    seq: orders.length + 1,
    userId: "u-9400",
    userName: "Owner",
    destinationId: chId,
    destinationTitle: "C" + tg,
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
  const taskId = "t-" + tg + "-9401";
  tasks.push({
    id: taskId,
    assignedTo: "u-9401",
    orderId: ordId,
    destinationId: chId,
    destinationTitle: "C" + tg,
    destinationUrl: "https://t.me/c" + Math.abs(tg),
    platform: "telegram",
    status: "CHECK_ERROR",
    lastCheckResult: "error",
    lastCheckReason: mode === "rate" ? "rate_limit" : "network",
    rewardCredits: 10,
    queueSequence: ++seq,
    createdAt: nowIso()
  });
  members[String(tg) + "|9401"] = mode;
  members[String(tg) + "|777000"] = "administrator";
  return { chId, taskId };
}

const future = addCase(-3001, "member");
const due = addCase(-3002, "member");
const crash = addCase(-3004, "member");
const conc = addCase(-3006, "member");
const inst = addCase(-3007, "member");
// 429 uchun a'zolik qayta tekshiruvi
const rl = addCase(-3005, "rate:5");

const jobs = [
  {
    id: "job-future", membershipId: "", taskId: future.taskId, userId: "u-9401", channelId: future.chId,
    jobType: "TASK_CHECK", scheduledAt: new Date(Date.now() + 6e4).toISOString(),
    status: "PENDING", attemptCount: 0, lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "tf"
  },
  {
    id: "job-due", membershipId: "", taskId: due.taskId, userId: "u-9401", channelId: due.chId,
    jobType: "TASK_CHECK", scheduledAt: new Date(Date.now() - 5e3).toISOString(),
    status: "PENDING", attemptCount: 0, lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "td"
  },
  {
    id: "job-crash", membershipId: "", taskId: crash.taskId, userId: "u-9401", channelId: crash.chId,
    jobType: "TASK_CHECK", scheduledAt: new Date(Date.now() - 5e3).toISOString(),
    status: "RUNNING", attemptCount: 1, lastError: "", lockedAt: new Date(Date.now() - 20 * 6e4).toISOString(),
    completedAt: "", idempotencyKey: "tc"
  },
  {
    id: "job-conc", membershipId: "", taskId: conc.taskId, userId: "u-9401", channelId: conc.chId,
    jobType: "TASK_CHECK", scheduledAt: new Date(Date.now() - 2e3).toISOString(),
    status: "PENDING", attemptCount: 0, lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "tk"
  },
  {
    id: "job-inst", membershipId: "", taskId: inst.taskId, userId: "u-9401", channelId: inst.chId,
    jobType: "TASK_CHECK", scheduledAt: new Date(Date.now() - 2e3).toISOString(),
    status: "PENDING", attemptCount: 0, lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "ti"
  },
  {
    id: "job-rl", membershipId: "mem-rl", taskId: "", userId: "u-9401", channelId: rl.chId,
    jobType: "RECHECK", scheduledAt: new Date(Date.now() - 2e3).toISOString(),
    status: "PENDING", attemptCount: 0, lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "tr"
  }
];

const seed = {
  seq,
  users: { 9400: user(9400), 9401: user(9401) },
  channels,
  igProfiles: [],
  orders,
  tasks,
  transactions: [],
  memberships: [{
    id: "mem-rl", userId: "u-9401", channelId: rl.chId, status: "ACTIVE",
    firstSeenAt: nowIso(), firstVerifiedAt: nowIso(), lastCheckedAt: "", nextCheckAt: nowIso(),
    lastMembershipChangeAt: "", lastCheckResult: "member", consecutiveCheckErrors: 0,
    createdAt: nowIso(), updatedAt: nowIso()
  }],
  membershipEvents: [],
  verificationJobs: jobs,
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
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: false, username: "test_bot", displayName: "Test", offset: 0 }]
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

const servers = [];
function startServer(port) {
  const p = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
      TELEGRAM_BOT_TOKEN: "TESTTOKEN",
      ADMIN_PASSWORD: "testpass",
      DATA_FILE: DB,
      KEEP_ALIVE: "0",
      VERIFY_BATCH: "25",
      MAINTENANCE_SEC: "1",
      BOT_START_RETRY_SEC: "600"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  p.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv:" + port + "] " + d));
  p.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv:" + port + ":err] " + d));
  servers.push(p);
  return p;
}
async function waitHttp(port) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  throw new Error("server ko'tarilmadi: " + port);
}
async function login(port) {
  const r = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function runJobs(port) {
  const cookie = await login(port);
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/jobs`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "verify", limit: 25 })
  });
  return r.json();
}
const rewardsFor = (db, taskId) => db.transactions.filter((t) => t.idempotencyKey === "reward:" + taskId);
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
  startServer(PORT);
  await waitHttp(PORT);
  await sleep(800);

  // 1. Muddatidan oldin bajarilmasligi: maintenance bir necha marta ishlaydi.
  await sleep(3500);
  let db = readDb();
  let jf = db.verificationJobs.find((j) => j.id === "job-future");
  check("Muddati kelmagan job bajarilmadi", !!jf && jf.status === "PENDING", jf && jf.status);
  check("Muddati kelmagan jobning vazifasi o'zgarmadi", db.tasks.find((t) => t.id === "t--3001-9401").status === "CHECK_ERROR");

  // 2. Muddati kelgan job bajarildi.
  check("Muddati kelgan job bajarildi (DONE)", await waitFor(() => readDb().verificationJobs.find((j) => j.id === "job-due").status === "DONE", 12000));
  db = readDb();
  check("Job muvaffaqiyatli tekshiruvdan keyin vazifa VERIFIED", db.tasks.find((t) => t.id === "t--3002-9401").status === "VERIFIED");
  check("Mukofot bir marta berildi", rewardsFor(db, "t--3002-9401").length === 1, `count=${rewardsFor(db, "t--3002-9401").length}`);

  // 4. Crash bo'lgan RUNNING job tiklandi.
  check("Crash bo'lgan RUNNING job tiklanib bajarildi", await waitFor(() => readDb().verificationJobs.find((j) => j.id === "job-crash").status === "DONE", 15000));
  db = readDb();
  check("Tiklangan job vazifani tasdiqladi", db.tasks.find((t) => t.id === "t--3004-9401").status === "VERIFIED");
  check("Tiklangan job mukofotni takrorlamadi", rewardsFor(db, "t--3004-9401").length === 1);

  // 5. 429 retry_after: job keyinga suriladi, a'zolik CANCELLED bo'lmaydi.
  db = readDb();
  const jr = db.verificationJobs.find((j) => j.id === "job-rl");
  check("429: job PENDING holatida qoldi", !!jr && jr.status === "PENDING", jr && jr.status);
  // Kutish vaqti tekshiruv paytidan hisoblanadi (a'zolikning lastCheckedAt),
  // shunda o'lchov test davomida o'tgan vaqtga bog'liq bo'lmaydi.
  const memForDelay = db.memberships.find((m) => m.id === "mem-rl");
  const rlDelay = jr && memForDelay && memForDelay.lastCheckedAt
    ? Date.parse(jr.scheduledAt) - Date.parse(memForDelay.lastCheckedAt)
    : 0;
  check("429: retry_after hurmat qilindi (≈5–7 s)", rlDelay > 4500 && rlDelay <= 8000, `delay=${rlDelay}`);
  check("429: job haqiqiy sababni saqladi", !!jr && /rate_limit/.test(String(jr.lastError || "")), jr && jr.lastError);
  const mem = db.memberships.find((m) => m.id === "mem-rl");
  check("429: a'zolik CANCELLED bo'lmadi", !!mem && mem.status === "ACTIVE", mem && mem.status);
  check("429: CHECK_ERROR voqeasi yozildi", db.membershipEvents.some((e) => e.eventType === "CHECK_ERROR"));

  // 3. Bir vaqtda ikkita ishga tushirish: bitta job bir marta bajariladi.
  const [r1, r2] = await Promise.all([runJobs(PORT), runJobs(PORT)]);
  check("Ikki parallel trigger ishladi", r1.ok === true && r2.ok === true, JSON.stringify([r1, r2]));
  await sleep(1200);
  db = readDb();
  check("Parallel triggerda job bir marta bajarildi", db.tasks.find((t) => t.id === "t--3006-9401").status === "VERIFIED");
  check("Parallel triggerda mukofot takrorlanmadi", rewardsFor(db, "t--3006-9401").length === 1, `count=${rewardsFor(db, "t--3006-9401").length}`);

  // 6. Ikki instans bir vaqtda: scheduler qulfi ikkinchisini to'xtatadi.
  startServer(PORT2);
  await waitHttp(PORT2);
  await sleep(1200);
  const res = await Promise.allSettled([runJobs(PORT), runJobs(PORT2)]);
  await sleep(1500);
  db = readDb();
  check("Ikki instansda job bir marta bajarildi", db.tasks.find((t) => t.id === "t--3007-9401").status === "VERIFIED", JSON.stringify(res.map((x) => x.status)));
  check("Ikki instansda mukofot takrorlanmadi", rewardsFor(db, "t--3007-9401").length === 1, `count=${rewardsFor(db, "t--3007-9401").length}`);

  for (const p of servers) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
  await sleep(800);
  mock.kill();
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
    mock.kill();
  } catch {}
  process.exit(1);
});
