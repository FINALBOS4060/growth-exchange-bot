// applyVerified() — atomarlik va idempotentlik (spec §1–§2).
//
// Test HAQIQIY `server.js` manbasidan funksiyalarni oladi (vm orqali), mock
// algoritm emas: `addTx`, `calculateRefundAmount`, `applyVerified`,
// `cancelOrder`, `ensureMembership`, `scheduleMembershipCheck`,
// `checkOrderComplete` — hammasi asl kod. Faqat tashqi dunyo (Telegram send,
// notify, id generator) o'rniga stub beriladi.
import fs from "node:fs";
import vm from "node:vm";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const src = fs.readFileSync("server.js", "utf8");
function cut(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`manba bo'lagi topilmadi: ${from} → ${to}`);
  return src.slice(a, b);
}
// To'rt bo'lak: refund hisobi, ledger/applyVerified bloki, saqlash primitivlari
// (cancelOrder endi `flushOrRollback` ishlatadi), cancelOrder.
const CODE = [
  cut("function calculateRefundAmount(", "function qualifyReferral("),
  cut("function addTx(", "async function tryQualifyReferral("),
  cut("function saveNow()", "var S = () => db.settings;"),
  cut("async function cancelOrder(", "// Kanal holati bo'yicha xabar kaliti"),
  // Sandbox — fayl rejimi: instanslararo qulf yo'q, tranzaksiya darhol bajariladi.
  "\n;async function withStateTx(fn) { return { ok: true, value: await fn() }; }"
].join("\n");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
}

const ORDER = (over = {}) => ({
  id: "ord-1",
  userId: "u-1",
  destinationId: "ch-1",
  destinationTitle: "Alpha",
  platform: "telegram",
  requestedQuantity: 3,
  verifiedQuantity: 0,
  pendingQuantity: 3,
  cancelledQuantity: 0,
  unitCost: 10,
  totalCost: 30,
  freeUnits: 0,
  status: "active",
  seq: 1,
  ...over
});
const TASK = (id, over = {}) => ({
  id,
  assignedTo: "u-1",
  orderId: "ord-1",
  destinationId: "ch-1",
  destinationTitle: "Alpha",
  platform: "telegram",
  status: "PENDING",
  rewardCredits: 100,
  queueSequence: 1,
  ...over
});

// Boshlang'ich holat: 30 kredit mukofot sifatida kelgan, 30 tasi buyurtmaga
// rezerv qilingan. Σ amount = 0 → available 0; reserved = 30 − 0 − 0 = 30.
function world(over = {}) {
  const db = {
    seq: 10,
    users: {
      1: {
        id: "u-1",
        telegramId: 1,
        displayName: "U1",
        credits: { available: 0, reserved: 30, spent: 0, verifiedRewards: 0, selfReportedRewards: 0, refunded: 0 },
        completedTasksCount: 0,
        activeOrdersCount: 1
      }
    },
    channels: [{ id: "ch-1", channelId: "-1001", title: "Alpha", verifiedSubscribers: 0, activeSubscribers: 0, pendingSubscriptions: 3 }],
    igProfiles: [],
    orders: [ORDER()],
    tasks: [TASK("t-1"), TASK("t-2", { queueSequence: 2 }), TASK("t-3", { queueSequence: 3 })],
    transactions: [
      { id: "tx-seed", userId: "u-1", amount: 30, type: "reward_task", idempotencyKey: "seed:reward", createdAt: "" },
      { id: "tx-res", userId: "u-1", amount: -30, type: "order_spend", orderId: "ord-1", idempotencyKey: "reserve:ord-1", createdAt: "" }
    ],
    memberships: [],
    membershipEvents: [],
    verificationJobs: [],
    verifyLog: [],
    referrals: [],
    auditLog: [],
    settings: { creditRewardInstagramSelfConfirmed: 0 },
    ...over
  };
  const errors = [];
  const state = { seq: 100 };
  const sandbox = {
    db,
    S: () => db.settings || {},
    nid: (p) => `${p}-${++state.seq}`,
    nowStr: () => new Date().toISOString(),
    userById: (id) => db.users[id] || Object.values(db.users).find((u) => u.id === id) || null,
    notifOn: () => true,
    notify: () => {},
    esc: (s) => String(s == null ? "" : s),
    send: () => {},
    T: (u, k) => k,
    TR: (u, k) => k,
    TRV: (u, k) => k,
    menuFor: () => null,
    balanceLine: () => "",
    save: () => {},
    // Saqlash primitivlari haqiqiy — fayl I/O o'rniga bo'sh stub.
    fs: { mkdirSync: () => {}, writeFileSync: () => {}, renameSync: () => {} },
    path: { dirname: () => "" },
    DATA_FILE: "/tmp/gxb-apply-verified.json",
    dbPool: null,
    CURRENT_OP: "",
    persistNow: async () => true,
    // Sandbox: fayl rejimi — instanslararo qulf yo'q, tranzaksiya darhol bajariladi.
    withStateTx: async (fn) => ({ ok: true, value: await fn() }),
    withSaveLock: async (fn) => fn(),
    saveTimer: null,
    persist: async () => {},
    console: { log: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    CODE + "\n;globalThis.__api = { applyVerified, cancelOrder, addTx, calculateRefundAmount, ensureMembership };",
    ctx
  );
  const api = ctx.__api;
  const u = db.users[1];
  const user = () => db.users[1];
  const task = (id) => db.tasks.find((t) => t.id === id);
  const order = (id = "ord-1") => db.orders.find((o) => o.id === id);
  const parity = () => {
    const txs = db.transactions.filter((t) => t.userId === "u-1");
    const led = runtimeLedger(txs, user().credits.spent);
    return {
      ok: Math.abs(led.available - user().credits.available) < 1e-9 && Math.abs(led.reserved - user().credits.reserved) < 1e-9,
      led,
      wallet: { available: user().credits.available, reserved: user().credits.reserved, spent: user().credits.spent }
    };
  };
  return { db, api, u, user, task, order, parity, errors };
}

/* ───────────────── 1. Oddiy takroriy chaqiruv ───────────────── */
{
  const w = world();
  const r1 = w.api.applyVerified(w.u, w.task("t-1"));
  const snap = JSON.parse(JSON.stringify({ u: w.u.credits, o: w.order(), t: w.task("t-1") }));
  const r2 = w.api.applyVerified(w.u, w.task("t-1"));
  const r3 = w.api.applyVerified(w.u, w.task("t-1"));
  check("takroriy: birinchi chaqiruv mukofot berdi", r1 === 100, r1);
  check("takroriy: ikkinchi/uchinchi chaqiruv 0 qaytardi", r2 === 0 && r3 === 0, `${r2},${r3}`);
  check("takroriy: aynan 1 ta reward tranzaksiyasi",
    w.db.transactions.filter((t) => t.idempotencyKey === "reward:t-1").length === 1);
  check("takroriy: available faqat 1 marta oshdi", w.u.credits.available === 100, w.u.credits.available);
  check("takroriy: reserved faqat 1 marta kamaydi", w.u.credits.reserved === 20, w.u.credits.reserved);
  check("takroriy: spent faqat 1 marta oshdi", w.u.credits.spent === 10, w.u.credits.spent);
  check("takroriy: verifiedQuantity faqat 1 marta oshdi", w.order().verifiedQuantity === 1, w.order().verifiedQuantity);
  check("takroriy: holat VERIFIED bo'lib qoldi", w.task("t-1").status === "VERIFIED");
  const same = JSON.parse(JSON.stringify({ u: w.u.credits, o: w.order(), t: w.task("t-1") }));
  check("takroriy: ikkinchi chaqiruvdan keyin holat aynan bir xil",
    JSON.stringify(same) === JSON.stringify(snap));
  check("takroriy: ledger ↔ hamyon teng", w.parity().ok, JSON.stringify(w.parity()));
}

/* ───────────────── 2. 20 parallel chaqiruv ───────────────── */
{
  const w = world();
  const t = w.task("t-1");
  const calls = Array.from({ length: 20 }, async () => w.api.applyVerified(w.u, t));
  const res = await Promise.all(calls);
  // Sinxron ketma-ket 20 marta ham (bir tick ichida) — qo'shimcha tekshiruv.
  for (let i = 0; i < 20; i++) w.api.applyVerified(w.u, w.task("t-1"));
  check("20 parallel: aynan 1 tasi mukofot qaytardi", res.filter((x) => x > 0).length === 1, JSON.stringify(res));
  check("20 parallel: aynan 1 reward tranzaksiyasi",
    w.db.transactions.filter((x) => x.idempotencyKey === "reward:t-1").length === 1);
  check("20 parallel: available bir marta oshdi", w.u.credits.available === 100, w.u.credits.available);
  check("20 parallel: reserved bir marta kamaydi", w.u.credits.reserved === 20, w.u.credits.reserved);
  check("20 parallel: spent bir marta oshdi", w.u.credits.spent === 10, w.u.credits.spent);
  check("20 parallel: verifiedQuantity = 1", w.order().verifiedQuantity === 1, w.order().verifiedQuantity);
  check("20 parallel: ledger ↔ hamyon teng", w.parity().ok, JSON.stringify(w.parity()));
}

/* ───────────────── 3. Reward yozilgandan keyingi xatolik ───────────────── */
{
  const w = world();
  const before = JSON.parse(JSON.stringify({
    u: w.u.credits, o: w.order(), t: w.task("t-1"), tx: w.db.transactions.length,
    log: w.db.verifyLog.length, jobs: w.db.verificationJobs.length, ev: w.db.membershipEvents.length
  }));
  const real = w.db.transactions;
  // Jurnal yozuvi yiqiladi (masalan disk to'lgan) — yarimta natija qolmasligi kerak.
  w.db.transactions = new Proxy(real, {
    get(target, key, recv) {
      if (key === "push") return () => { throw new Error("yozib bo'lmadi"); };
      return Reflect.get(target, key, recv);
    }
  });
  const out = w.api.applyVerified(w.u, w.task("t-1"));
  w.db.transactions = real;
  const after = JSON.parse(JSON.stringify({
    u: w.u.credits, o: w.order(), t: w.task("t-1"), tx: w.db.transactions.length,
    log: w.db.verifyLog.length, jobs: w.db.verificationJobs.length, ev: w.db.membershipEvents.length
  }));
  check("xatolik: natija 0", out === 0, out);
  check("xatolik: hech qanday o'zgarish qolmadi", JSON.stringify(before) === JSON.stringify(after),
    JSON.stringify(after));
  check("xatolik: task VERIFIED bo'lib qolmadi", w.task("t-1").status === "PENDING", w.task("t-1").status);
  check("xatolik: logga haqiqiy sabab yozildi", w.errors.some((e) => /applyVerified qaytarildi/.test(e)), JSON.stringify(w.errors));
  const ok = w.api.applyVerified(w.u, w.task("t-1"));
  check("xatolikdan keyin normal chaqiruv ishlaydi", ok === 100, ok);
  check("xatolikdan keyin ledger ↔ hamyon teng", w.parity().ok, JSON.stringify(w.parity()));
}

/* ───────────────── 4. VERIFIED / CANCELLED dan keyin qayta chaqiruv ───────────────── */
{
  const w = world();
  w.api.applyVerified(w.u, w.task("t-1"));
  const cred = JSON.stringify(w.u.credits);
  const ov = w.order().verifiedQuantity;
  const again = w.api.applyVerified(w.u, w.task("t-1"));
  check("VERIFIED: qayta chaqiruv 0", again === 0);
  check("VERIFIED: holat o'zgarmadi (CANCELLED ga aylanmadi)", w.task("t-1").status === "VERIFIED", w.task("t-1").status);
  check("VERIFIED: balans va verifiedQuantity o'zgarmadi",
    JSON.stringify(w.u.credits) === cred && w.order().verifiedQuantity === ov);

  // Buyurtma yopilgandan keyingi chaqiruv ham hisoblagichga tegmaydi.
  const w2 = world();
  w2.order().status = "completed";
  const out = w2.api.applyVerified(w2.u, w2.task("t-1"));
  check("yopilgan buyurtma: mukofot berilmaydi", out === 0);
  check("yopilgan buyurtma: tranzaksiya yozilmaydi", w2.db.transactions.filter((t) => /reward:t-1/.test(t.idempotencyKey || "")).length === 0);
}

/* ───────────────── 5. SELF_CONFIRMED (Instagram) ───────────────── */
{
  const w = world({
    users: {
      1: {
        id: "u-1", telegramId: 1, displayName: "U1",
        credits: { available: 0, reserved: 0, spent: 0, verifiedRewards: 0, selfReportedRewards: 0, refunded: 0 },
        completedTasksCount: 0, activeOrdersCount: 1
      }
    },
    orders: [ORDER({ platform: "instagram", destinationId: "ig-1", unitCost: 0, totalCost: 0, requestedQuantity: 1, pendingQuantity: 1 })],
    tasks: [TASK("ig-t1", { platform: "instagram", destinationId: "ig-1", orderId: "ord-1", rewardCredits: 100 })],
    channels: [],
    igProfiles: [{ id: "ig-1", profileUrl: "https://instagram.com/x", selfReportedFollowers: 0, pendingFollowers: 1 }],
    transactions: []
  });
  const r = w.api.applyVerified(w.u, w.task("ig-t1"));
  const tx = w.db.transactions.find((t) => t.idempotencyKey === "reward:ig-t1");
  check("SELF_CONFIRMED: holat SELF_CONFIRMED", w.task("ig-t1").status === "SELF_CONFIRMED", w.task("ig-t1").status);
  check("SELF_CONFIRMED: tasdiqlangan mukofot berilmaydi", r === 0 && w.u.credits.available === 0, r);
  check("SELF_CONFIRMED: verifiedRewards oshmaydi", (w.u.credits.verifiedRewards || 0) === 0);
  check("SELF_CONFIRMED: tranzaksiya nonPayable", !!tx && tx.nonPayable === true && tx.amount === 0);
  const again = w.api.applyVerified(w.u, w.task("ig-t1"));
  check("SELF_CONFIRMED: qayta chaqiruv 0 va dublikat yo'q",
    again === 0 && w.db.transactions.filter((t) => t.idempotencyKey === "reward:ig-t1").length === 1);
}

/* ───────────────── 6. Ikki task bir orderga tegishli ───────────────── */
{
  const w = world();
  w.api.applyVerified(w.u, w.task("t-1"));
  w.api.applyVerified(w.u, w.task("t-2"));
  check("2 task/1 order: verifiedQuantity = 2", w.order().verifiedQuantity === 2, w.order().verifiedQuantity);
  check("2 task/1 order: available = 200", w.u.credits.available === 200, w.u.credits.available);
  check("2 task/1 order: reserved = 10", w.u.credits.reserved === 10, w.u.credits.reserved);
  check("2 task/1 order: spent = 20", w.u.credits.spent === 20, w.u.credits.spent);
  check("2 task/1 order: 2 ta tranzaksiya",
    w.db.transactions.filter((t) => /^reward:t-/.test(t.idempotencyKey || "")).length === 2);
  check("2 task/1 order: ledger ↔ hamyon teng", w.parity().ok, JSON.stringify(w.parity()));
}

/* ───────────────── 7. Refund bilan parallel / ketma-ket ───────────────── */
{
  const w = world();
  w.api.applyVerified(w.u, w.task("t-1"));
  await w.api.cancelOrder(w.u, "ord-1", "chat");
  // 3 so'ralgan, 1 tasdiqlangan → 2 birlik × 10 = 20 kredit qaytadi.
  check("refund: available = 100 + 20", w.u.credits.available === 120, w.u.credits.available);
  check("refund: reserved = 0", w.u.credits.reserved === 0, w.u.credits.reserved);
  check("refund: spent o'zgarmadi (10)", w.u.credits.spent === 10, w.u.credits.spent);
  check("refund: ledger ↔ hamyon teng", w.parity().ok, JSON.stringify(w.parity()));
  const tx = w.db.transactions.filter((t) => t.type === "order_refund");
  check("refund: aynan 1 refund tranzaksiyasi", tx.length === 1, tx.length);
  // Ikkinchi marta bekor qilish — dublikat refund yo'q.
  await w.api.cancelOrder(w.u, "ord-1", "chat");
  check("refund takrori: balans o'zgarmadi", w.u.credits.available === 120, w.u.credits.available);
  check("refund takrori: yangi tranzaksiya yo'q",
    w.db.transactions.filter((t) => t.type === "order_refund").length === 1);
  // Bekor qilingan vazifani keyin "tasdiqlash" balansni buzmaydi.
  const before = JSON.stringify(w.u.credits);
  const late = w.api.applyVerified(w.u, w.task("t-1"));
  check("refunddan keyingi kechikkan applyVerified: 0", late === 0, late);
  check("refunddan keyin balans o'zgarmadi", JSON.stringify(w.u.credits) === before);
  check("refunddan keyin ham ledger ↔ hamyon teng", w.parity().ok, JSON.stringify(w.parity()));
}

/* ───────────────── 8. Bepul birliklar ───────────────── */
{
  const w = world({
    orders: [ORDER({ unitCost: 0, totalCost: 0, freeUnits: 2, requestedQuantity: 2, pendingQuantity: 2 })],
    tasks: [TASK("t-1"), TASK("t-2", { queueSequence: 2 })],
    users: {
      1: {
        id: "u-1", telegramId: 1, displayName: "U1",
        credits: { available: 0, reserved: 0, spent: 0, verifiedRewards: 0, selfReportedRewards: 0, refunded: 0 },
        completedTasksCount: 0, activeOrdersCount: 1
      }
    },
    transactions: []
  });
  w.api.applyVerified(w.u, w.task("t-1"));
  w.api.applyVerified(w.u, w.task("t-2"));
  check("bepul birlik: reserved/spent tegilmadi", w.u.credits.reserved === 0 && w.u.credits.spent === 0,
    `${w.u.credits.reserved}/${w.u.credits.spent}`);
  check("bepul birlik: freeUnits 0 ga tushdi", w.order().freeUnits === 0, w.order().freeUnits);
  check("bepul birlik: reward 2×100", w.u.credits.available === 200, w.u.credits.available);
  check("bepul birlik: buyurtma completed", w.order().status === "completed", w.order().status);
  check("bepul birlik: ledger ↔ hamyon teng", w.parity().ok, JSON.stringify(w.parity()));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " - " + f.name).join("\n"));
  process.exit(1);
}
