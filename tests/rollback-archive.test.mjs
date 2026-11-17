// Rollback xavfsizligi: TASK_CHECK arxivi (spec: "hech qanday ma'lumot o'chmaydi").
//
// Tekshiriladi:
//  1. dry-run holatni O'ZGARTIRMAYDI (fayl bayt-bayt bir xil).
//  2. --apply arxivga TO'LIQ nusxa yozadi; job o'chirilmaydi, faqat status.
//  3. Arxivdagi count / ID / checksum / maydonlar asl bilan mos.
//  4. Boshqa kolleksiyalar (users, transactions, membershipEvents, tasks) tegilmagan.
//  5. `verify` arxiv butunligini tasdiqlaydi; buzilganda xato bilan chiqadi.
//  6. `restore` jobni PENDING ga qaytaradi, arxivni SAQLAB qoladi.
//  7. Job haqiqatan yo'qolgan bo'lsa restore bekor qilinadi (jimgina "tiklandi"
//     deb aytmaydi).
//  8. Post-deploy tekshiruv skripti faqat o'qiydi.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gxb-archive-"));
const DB = path.join(tmp, "db.json");
const ARCH = path.join(tmp, "archives");
const SCRIPT = path.join("scripts", "archive-task-check-jobs.mjs");
const CHECKER = path.join("scripts", "post-deploy-check.mjs");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const canon = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
};
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const clone = (v) => JSON.parse(JSON.stringify(v));
const now = () => new Date().toISOString();

const job = (id, taskId, extra = {}) => ({
  id,
  membershipId: "",
  taskId,
  userId: "u-1",
  channelId: "ch-" + taskId,
  jobType: "TASK_CHECK",
  scheduledAt: "2026-11-15T06:10:00.000Z",
  status: "PENDING",
  attemptCount: 2,
  lastError: "429 Too Many Requests",
  lastErrorCode: 429,
  lockedAt: "",
  completedAt: "",
  idempotencyKey: `taskcheck:${taskId}:1794586200`,
  ...extra
});

const origJobs = [
  job("job-1", "t-a"),
  job("job-2", "t-b", { attemptCount: 1, lastError: "timeout", lastErrorCode: 0 }),
  job("job-3", "t-c", { attemptCount: 3, scheduledAt: "2026-11-15T09:45:00.000Z" }),
  job("job-4", "t-d", { lastErrorCode: 500, lastError: "Internal Server Error" })
];
const recheckJob = {
  id: "job-r1", membershipId: "mem-1", userId: "u-1", channelId: "ch-1", jobType: "RECHECK",
  scheduledAt: "2026-11-15T07:00:00.000Z", status: "PENDING", attemptCount: 0,
  lastError: "", lockedAt: "", completedAt: "", idempotencyKey: "verify:RECHECK:u-1:ch-1:1"
};

const seed = {
  seq: 100,
  users: {
    1: { id: "u-1", telegramId: 1, credits: { available: 300, reserved: 100, spent: 0 }, language: "uz" }
  },
  channels: [{ id: "ch-1", channelId: "-1001", title: "Alpha", ownerId: "u-1" }],
  igProfiles: [],
  orders: [{ id: "ord-1", userId: "u-1", destinationId: "ch-1", requestedQuantity: 5, status: "active" }],
  tasks: [
    { id: "t-a", assignedTo: "u-1", destinationId: "ch-a", status: "CHECK_ERROR", consecutiveCheckErrors: 2 },
    { id: "t-b", assignedTo: "u-1", destinationId: "ch-b", status: "CHECK_ERROR", consecutiveCheckErrors: 1 },
    { id: "t-c", assignedTo: "u-1", destinationId: "ch-c", status: "CHECK_ERROR", consecutiveCheckErrors: 3 },
    { id: "t-d", assignedTo: "u-1", destinationId: "ch-d", status: "RECHECK", consecutiveCheckErrors: 1 }
  ],
  transactions: [{ id: "tx-1", userId: "u-1", amount: 300, type: "reward_task", idempotencyKey: "k1" }],
  memberships: [{ id: "mem-1", userId: "u-1", channelId: "ch-1", status: "ACTIVE" }],
  membershipEvents: [
    { id: "ev-1", userId: "u-1", channelId: "ch-1", eventType: "FIRST_VERIFIED" },
    { id: "ev-2", userId: "u-1", channelId: "ch-1", eventType: "RECHECK_ACTIVE" }
  ],
  verificationJobs: [...clone(origJobs), clone(recheckJob)],
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
  settings: { bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true }] },
  lastHour: 0
};
fs.writeFileSync(DB, JSON.stringify(seed));
const readDb = () => JSON.parse(fs.readFileSync(DB, "utf8"));
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  env: { ...process.env, DATA_FILE: DB, DATABASE_URL: "" },
  encoding: "utf8"
});

/* ---- 1. dry-run hech narsani o'zgartirmaydi ---- */
const before = fs.readFileSync(DB, "utf8");
const dry = run([]);
check("dry-run: exit 0", dry.status === 0, dry.stderr);
check("dry-run: holat fayli bayt-bayt o'zgarmadi", fs.readFileSync(DB, "utf8") === before);
check("dry-run: arxiv yozuvi yaratilmadi", !fs.existsSync(ARCH));
check("dry-run: joblar PENDING holida qoldi", readDb().verificationJobs.filter((j) => j.jobType === "TASK_CHECK" && j.status === "PENDING").length === 4);

/* ---- 2. --apply: arxiv + ARCHIVED, o'chirish yo'q ---- */
const ap = run(["--apply"]);
check("apply: exit 0", ap.status === 0, ap.stderr);
const after = readDb();
const liveTc = after.verificationJobs.filter((j) => j.jobType === "TASK_CHECK");
check("apply: joblar SONI o'zgarmadi (o'chirilmadi)", liveTc.length === 4, `hozir ${liveTc.length}`);
check("apply: barchasi ARCHIVED", liveTc.every((j) => j.status === "ARCHIVED"));
check("apply: RECHECK jobi tegilmadi",
  canon(after.verificationJobs.find((j) => j.id === "job-r1")) === canon(recheckJob));
check("apply: arxiv fayli yozildi", fs.existsSync(ARCH) && fs.readdirSync(ARCH).length === 1);

const arc = JSON.parse(fs.readFileSync(path.join(ARCH, fs.readdirSync(ARCH)[0]), "utf8"));
check("arxiv: count = 4", arc.count === 4);
check("arxiv: jobIds asl tartibda", canon(arc.jobIds) === canon(origJobs.map((j) => j.id)));
check("arxiv: checksum asl nusxadan hisoblangan", arc.checksum === sha1(canon(origJobs)));
check("arxiv: nusxalar asl bilan aynan bir xil", canon(arc.jobs) === canon(origJobs));
check("arxiv: taskId saqlangan", canon(arc.jobs.map((j) => j.taskId)) === canon(["t-a", "t-b", "t-c", "t-d"]));
check("arxiv: retry vaqtlari saqlangan", canon(arc.jobs.map((j) => j.scheduledAt)) === canon(origJobs.map((j) => j.scheduledAt)));
check("arxiv: attemptCount saqlangan", canon(arc.jobs.map((j) => j.attemptCount)) === canon([2, 1, 3, 2]));
check("arxiv: xato matni/kodi saqlangan",
  canon(arc.jobs.map((j) => [j.lastError, j.lastErrorCode])) === canon(origJobs.map((j) => [j.lastError, j.lastErrorCode])));
check("arxiv: idempotencyKey saqlangan",
  canon(arc.jobs.map((j) => j.idempotencyKey)) === canon(origJobs.map((j) => j.idempotencyKey)));

// Jonli joblarda ham (statusdan tashqari) barcha maydonlar joyida.
const liveById = new Map(liveTc.map((j) => [j.id, j]));
let preserved = true;
for (const o of origJobs) {
  const l = liveById.get(o.id);
  for (const k of Object.keys(o)) {
    if (k === "status") continue;
    if (canon(o[k]) !== canon(l[k])) preserved = false;
  }
}
check("jonli joblarda barcha maydonlar saqlangan (faqat status o'zgargan)", preserved);

/* ---- 3. boshqa ma'lumotlar tegilmagan ---- */
for (const key of ["users", "transactions", "membershipEvents", "tasks", "memberships", "orders", "channels"]) {
  check(`${key} o'zgarmadi`, canon(after[key]) === canon(seed[key]));
}

/* ---- 4. verify ---- */
const v1 = run(["verify"]);
check("verify: mos holatda exit 0", v1.status === 0, v1.stdout + v1.stderr);
check("verify: 'to'liq mos' deydi", /to'liq mos/.test(v1.stdout), v1.stdout);

/* ---- 5. verify buzilishni payqaydi ---- */
const tampered = readDb();
tampered.verificationJobs.find((j) => j.id === "job-2").lastError = "o'zgartirilgan";
fs.writeFileSync(DB, JSON.stringify(tampered));
const v2 = run(["verify"]);
check("verify: o'zgargan maydonni aniqlaydi (exit 1)", v2.status === 1);
check("verify: qaysi job ekanini aytadi", /job-2/.test(v2.stdout), v2.stdout);

const gone = readDb();
gone.verificationJobs = gone.verificationJobs.filter((j) => j.id !== "job-3");
fs.writeFileSync(DB, JSON.stringify(gone));
const v3 = run(["verify"]);
check("verify: yo'qolgan jobni aniqlaydi (exit 1)", v3.status === 1);
check("verify: 'YO'QOLGAN' deb yozadi", /YO'QOLGAN/.test(v3.stdout), v3.stdout);

/* ---- 6. restore ishlamaydi, agar job yo'qolgan bo'lsa ---- */
const r0 = run(["restore", "--apply"]);
check("restore: job yo'q bo'lsa bekor qilinadi (exit 1)", r0.status === 1);
check("restore: sababni aytadi", /topilmadi/.test(r0.stderr + r0.stdout), r0.stderr);

/* ---- 7. restore: to'g'ri holatda ishlaydi, arxiv qoladi ---- */
// Arxivlangan holat asl maydonlar bilan (tamper yo'q) — restore faqat statusga
// tegishini isbotlash uchun.
const archivedState = clone(seed);
archivedState.verificationJobs = archivedState.verificationJobs.map((j) => (
  j.jobType === "TASK_CHECK" ? { ...j, status: "ARCHIVED", archivedAt: now(), archiveId: "task-check-x" } : j
));
fs.writeFileSync(DB, JSON.stringify(archivedState));
const r1 = run(["restore", "--apply"]);
check("restore: exit 0", r1.status === 0, r1.stderr);
const restoredDb = readDb();
const restoredJobs = restoredDb.verificationJobs.filter((j) => j.jobType === "TASK_CHECK");
check("restore: hammasi PENDING", restoredJobs.every((j) => j.status === "PENDING"));
check("restore: arxiv belgilari olib tashlandi", restoredJobs.every((j) => !j.archivedAt && !j.archiveId));
check("restore: arxiv yozuvi SAQLANIB qoldi", fs.readdirSync(ARCH).length === 1);
check("restore: job soni baribir 4", restoredJobs.length === 4);
check("restore: maydonlar asl holida (faqat status qaytdi)", canon(restoredJobs.map(({ status, ...r }) => r)) === canon(origJobs.map(({ status, ...o }) => o)), "maydonlar farq qildi");
const v4 = run(["verify"]);
check("verify: restore'dan keyin arxiv hanuz butun (exit 0)", v4.status === 0, v4.stdout);

/* ---- 8. post-deploy tekshiruv faqat o'qiydi ---- */
const beforeCheck = fs.readFileSync(DB, "utf8");
const pc = spawnSync(process.execPath, [CHECKER], {
  env: { ...process.env, DATA_FILE: DB, DATABASE_URL: "", RENDER_API_KEY: "", RENDER_SERVICE_ID: "" },
  encoding: "utf8"
});
check("post-deploy-check: exit 0", pc.status === 0, pc.stderr);
check("post-deploy-check: holatni o'zgartirmadi", fs.readFileSync(DB, "utf8") === beforeCheck);
check("post-deploy-check: TASK_CHECK joblarini ko'rsatadi", /RECHECK \/ CHECK_ERROR/.test(pc.stdout), pc.stdout);
check("post-deploy-check: referal 300 bo'limi", /6b\. Referal mukofoti \(300 kredit/.test(pc.stdout), pc.stdout);
check("post-deploy-check: a'zolik qayta tekshiruvi bo'limi", /6c\. A'zolik qayta tekshiruvi/.test(pc.stdout), pc.stdout);
// Noto'g'ri referal summasi → `--strict` rejimida xato (avtomatik tuzatilmaydi).
{
  const badDb = JSON.parse(fs.readFileSync(DB, "utf8"));
  badDb.transactions = [
    ...(badDb.transactions || []),
    { id: "tx-ref-bad", userId: "u-1", amount: 250, type: "REFERRAL_REWARD", idempotencyKey: "refreward:r-bad", referralId: "r-bad", createdAt: now() }
  ];
  const badFile = path.join(tmp, "bad-referral.json");
  fs.writeFileSync(badFile, JSON.stringify(badDb));
  const pcbad = spawnSync(process.execPath, [CHECKER, "--strict"], {
    env: { ...process.env, DATA_FILE: badFile, DATABASE_URL: "", RENDER_API_KEY: "", RENDER_SERVICE_ID: "" },
    encoding: "utf8"
  });
  check("post-deploy-check: 300 dan farq → exit 1", pcbad.status === 1, `status=${pcbad.status}`);
  check("post-deploy-check: sabab aniq ko'rsatilgan", /REFERRAL_REWARD summasi 300 emas/.test(pcbad.stdout), pcbad.stdout);
  check("post-deploy-check: noto'g'ri faylni o'zgartirmaydi", fs.readFileSync(badFile, "utf8") === JSON.stringify(badDb));
}
check("post-deploy-check: a'zolik voqealarini sanaydi", /membershipEvents: 2/.test(pc.stdout), pc.stdout);
check("post-deploy-check: takror joblarni tekshiradi", /takror guruhlar: 0/.test(pc.stdout), pc.stdout);

const baseFile = path.join(tmp, "baseline.json");
const pcs = spawnSync(process.execPath, [CHECKER, "--save-baseline", "--out", baseFile], {
  env: { ...process.env, DATA_FILE: DB, DATABASE_URL: "" },
  encoding: "utf8"
});
check("post-deploy-check: baseline saqlanadi", pcs.status === 0 && fs.existsSync(baseFile), pcs.stderr);
const pcb = spawnSync(process.execPath, [CHECKER, "--baseline", baseFile], {
  env: { ...process.env, DATA_FILE: DB, DATABASE_URL: "" },
  encoding: "utf8"
});
check("post-deploy-check: baseline bilan solishtiriladi", pcb.status === 0 && /membershipEvents: 2 → 2/.test(pcb.stdout), pcb.stdout);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) process.exitCode = 1;
