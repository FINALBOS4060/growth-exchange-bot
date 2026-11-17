// Pre-deploy tuzatishlari: F1 (flushSave), F2 (order client_token),
// F5 (refund reserved), F4 (referal — yagona hamyonga 300 kredit).
//
// Test HAQIQIY `server.js` manbasidan funksiyalarni oladi (vm orqali):
//   calculateRefundAmount · qualifyReferral · addTx · adminAdjust ·
//   applyAdminAdjust · grantSignupBonus · grantChannelLinkBonus ·
//   saveNow · flushSave · creditsSnapshot · creditsRestore · flushOrRollback ·
//   auditSys · tryQualifyReferral · claimOrderToken · cancelOrderAdmin ·
//   cancelOrder
// Faqat tashqi dunyo (Telegram send/notify, id generator) stub. Fayl yozish —
// boshqariladigan stub: `failWrites` bilan disk xatosini simulyatsiya qilamiz.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const src = fs.readFileSync("server.js", "utf8");
function cut(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`manba bo'lagi topilmadi: ${from} → ${to}`);
  return src.slice(a, b);
}
const CODE = [
  cut("function calculateRefundAmount(", "function qualifyReferral("),
  cut("function qualifyReferral(", "function generateControllerCode("),
  cut("function addTx(", "async function tryQualifyReferral("),
  cut("function saveNow()", "var S = () => db.settings;"),
  cut("async function tryQualifyReferral(", "// Referal bonusini tanlangan kanalga"),
  cut("function claimOrderToken(", "async function createOrderConfirmed("),
  cut("async function cancelOrderAdmin(", "// --- Moderatsiya skaneri"),
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

function seed(over = {}) {
  return {
    seq: 10,
    users: {
      1: {
        id: "u-1",
        telegramId: 1,
        displayName: "U1",
        status: "active",
        credits: { available: 1000, reserved: 30, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
        completedTasksCount: 0,
        activeOrdersCount: 1
      },
      2: {
        id: "u-2",
        telegramId: 2,
        displayName: "U2",
        status: "active",
        credits: { available: 0, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
        completedTasksCount: 0,
        activeOrdersCount: 0
      }
    },
    channels: [{ id: "ch-1", channelId: "-1001", title: "Alpha", verifiedSubscribers: 0, activeSubscribers: 0, pendingSubscriptions: 3 }],
    igProfiles: [],
    orders: [ORDER()],
    tasks: [TASK("t-1"), TASK("t-2", { queueSequence: 2 }), TASK("t-3", { queueSequence: 3 })],
    transactions: [
      { id: "tx-seed", userId: "u-1", amount: 1030, type: "reward_task", idempotencyKey: "seed:in" },
      { id: "tx-res", userId: "u-1", amount: -30, type: "order_spend", orderId: "ord-1", idempotencyKey: "reserve:ord-1" }
    ],
    memberships: [],
    membershipEvents: [],
    verificationJobs: [],
    verifyLog: [],
    referrals: [],
    auditLog: [],
    orderTokens: {},
    settings: {
      creditRewardSignup: 0,
      creditRewardChannelLink: 0,
      creditRewardReferral: 300,
      creditRewardInstagramSelfConfirmed: 0,
      creditPerSubscriber: 1
    },
    ...over
  };
}

// Bitta "jarayon": haqiqiy funksiyalar + boshqariladigan fayl yozuvchi.
function world(db = seed(), opts = {}) {
  const state = { seq: 100, failWrites: !!opts.failWrites, writes: [] };
  const sent = [];
  const notifies = [];
  const errors = [];
  const fsStub = {
    mkdirSync: () => {},
    writeFileSync: (p, s) => {
      if (state.failWrites) throw new Error("ENOSPC: disk to'ldi");
      state.writes.push({ p: String(p), s: String(s) });
    },
    renameSync: () => {}
  };
  const sandbox = {
    db,
    DATA_FILE: path.join("/tmp", "gxb-fix-db.json"),
    dbPool: null,
    CURRENT_OP: "",
    INSTANCE_ID: "test-instance",
    persistNow: async () => true,
    // Sandbox: fayl rejimi — instanslararo qulf yo'q, tranzaksiya darhol bajariladi.
    withStateTx: async (fn) => ({ ok: true, value: await fn() }),
    withSaveLock: async (fn) => fn(),
    saveTimer: null,
    fs: fsStub,
    path,
    persist: async () => {},
    setTimeout: (fn) => ({ fn }),
    clearTimeout: () => {},
    S: () => db.settings,
    nid: (p) => `${p}-${++state.seq}`,
    nowStr: () => new Date().toISOString(),
    userById: (id) => db.users[id] || Object.values(db.users).find((u) => u.id === id) || null,
    channelsOf: (u) => db.channels.filter((c) => c.ownerId === u.id),
    destOf: (id) => db.channels.find((c) => c.id === id) || db.igProfiles.find((p) => p.id === id) || null,
    OPEN: new Set(["PENDING", "CHECK_ERROR"]),
    notifOn: () => true,
    notify: (u, text) => notifies.push({ user: u && u.id, text: String(text) }),
    esc: (s) => String(s == null ? "" : s),
    send: (chat, text) => { sent.push({ chat, text: String(text) }); return {}; },
    T: (u, k) => k,
    TR: (u, k) => k,
    TRV: (u, k) => k,
    menuFor: () => null,
    balanceLine: () => "",
    console: { log: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    CODE +
      "\n;globalThis.__api = { addTx, adminAdjust, applyAdminAdjust, grantSignupBonus, grantChannelLinkBonus, save, flushSave, saveNow, creditsSnapshot, creditsRestore, flushOrRollback, auditSys, qualifyReferral, tryQualifyReferral, claimOrderToken, cancelOrderAdmin, cancelOrder, calculateRefundAmount };",
    ctx
  );
  const api = ctx.__api;
  const u = () => db.users[1];
  const parity = (id = "u-1") => {
    const user = Object.values(db.users).find((x) => x.id === id);
    const led = runtimeLedger(db.transactions.filter((t) => t.userId === id), user.credits.spent);
    return {
      ok: Math.abs(led.available - user.credits.available) < 1e-6 && Math.abs(led.reserved - user.credits.reserved) < 1e-6,
      led,
      wallet: { available: user.credits.available, reserved: user.credits.reserved, spent: user.credits.spent }
    };
  };
  return { db, api, u, parity, sent, notifies, errors, state };
}

/* ═══════════ A. F1 — flushSave: darhol saqlash + xato = rollback ═══════════ */
{
  // A1. admin tuzatish: saqlash muvaffaqiyatli → balans va jurnal birga.
  const w = world();
  const r = await w.api.applyAdminAdjust(w.u(), 50, "Admin panel", "adminadj:panel:root:tok-1");
  check("A1 applyAdminAdjust: +50 qo'llandi", r.ok === true && w.u().credits.available === 1050, JSON.stringify(r));
  check("A1 yozuv darhol saqlandi (debounce emas)", w.state.writes.length === 1);
  check("A1 bitta jurnal yozuvi", w.db.transactions.filter((t) => t.type === "admin_adjustment").length === 1);
  check("A1 ledger ↔ hamyon farqi 0", w.parity().ok, JSON.stringify(w.parity()));

  // A2. takroriy kalit.
  const r2 = await w.api.applyAdminAdjust(w.u(), 50, "Admin panel", "adminadj:panel:root:tok-1");
  check("A2 takroriy kalit: go'llanmadi", r2.ok === false && r2.reason === "duplicate");
  check("A2 balans o'zgarmadi", w.u().credits.available === 1050);
  check("A2 jurnal takrorlanmadi", w.db.transactions.filter((t) => t.type === "admin_adjustment").length === 1);

  // A3. manfiy qoldiq.
  const r3 = await w.api.applyAdminAdjust(w.u(), -5000, "Admin", "tok-neg");
  check("A3 manfiy qoldiq rad etildi", r3.ok === false && r3.reason === "insufficient");
  check("A3 balans saqlanib qoldi", w.u().credits.available === 1050 && w.parity().ok);
}
{
  // A4. saqlash xatosi → tuzatish qaytariladi, muvaffaqiyat YO'Q.
  const w = world(seed(), { failWrites: true });
  const r = await w.api.applyAdminAdjust(w.u(), 50, "Admin", "tok-x");
  check("A4 save xatosi: save_failed", r.ok === false && r.reason === "save_failed", JSON.stringify(r));
  check("A4 balans qaytarildi", w.u().credits.available === 1000, String(w.u().credits.available));
  check("A4 jurnal yozilmadi (rollback)", w.db.transactions.filter((t) => t.type === "admin_adjustment").length === 0);
  check("A4 notify yuborilmadi", w.notifies.length === 0);
  check("A4 ledger farqi 0", w.parity().ok);
}
{
  // A5. signup bonus — darhol saqlanadi.
  const w = world(seed({ settings: { ...seed().settings, creditRewardSignup: 100 } }));
  // `getUser()` yangi foydalanuvchida shu bayroqni qo'yadi; sovg'a async beriladi.
  w.db.users[2].signupPending = true;
  const got = await w.api.grantSignupBonus(w.db.users[2]);
  check("A5 signup bonus +100", got === 100 && w.db.users[2].credits.available === 100, String(got));
  check("A5 signup yozuvi darhol saqlandi", w.state.writes.length === 1);
  check("A5 signup jurnali va balanceAfter", w.db.transactions.some((t) => t.type === "signup_bonus" && t.amount === 100 && t.balanceAfter === 100));
  check("A5 ledger farqi 0", w.parity("u-2").ok, JSON.stringify(w.parity("u-2")));
}
{
  // A6. signup bonus saqlanmasa — berilmaydi.
  const w = world(seed({ settings: { ...seed().settings, creditRewardSignup: 100 } }), { failWrites: true });
  w.db.users[2].signupPending = true;
  const got = await w.api.grantSignupBonus(w.db.users[2]);
  check("A6 signup save xatosi: -1", got === -1, String(got));
  check("A6 balans 0, jurnal 0", w.db.users[2].credits.available === 0 && w.db.transactions.filter((t) => t.userId === "u-2").length === 0);
}
{
  // A7. kanal ulash sovg'asi — bir marta, darhol saqlanadi.
  const w = world(seed({ settings: { ...seed().settings, creditRewardChannelLink: 10 } }));
  const ch = { id: "ch-1", title: "Alpha" };
  const got = await w.api.grantChannelLinkBonus(w.u(), ch);
  check("A7 kanal sovg'asi +10", got === 10 && w.u().credits.available === 1010, String(got));
  check("A7 birinchi chaqiruvda saqlandi", w.state.writes.length === 1);
  check("A7 chlink idempotency kaliti", w.db.transactions.some((t) => t.idempotencyKey === "chlink:ch-1"));
  const again = await w.api.grantChannelLinkBonus(w.u(), ch);
  check("A7 takroriy chaqiruv 0", again === 0 && w.u().credits.available === 1010);
  check("A7 ledger farqi 0", w.parity().ok);
}
{
  // A8. kanal sovg'asi saqlanmasa — qaytariladi.
  const w = world(seed({ settings: { ...seed().settings, creditRewardChannelLink: 10 } }), { failWrites: true });
  const got = await w.api.grantChannelLinkBonus(w.u(), { id: "ch-1", title: "Alpha" });
  check("A8 kanal sovg'asi save xatosi: -1", got === -1, String(got));
  check("A8 balans qaytarildi, flag yopildi", w.u().credits.available === 1000 && w.u().channelBonusGiven === false);
  check("A8 jurnal 0", w.db.transactions.filter((t) => t.type === "channel_link_bonus").length === 0);
}

/* ═══════════ B. F5 — refund reserved tekshiruvi ═══════════ */
{
  const w = world();
  const res = await w.api.cancelOrderAdmin(w.db.orders[0]);
  check("B1 admin bekor qilish: ok", res.ok === true && res.refundCredits === 30, JSON.stringify(res));
  check("B1 reserved 0, available +30", w.u().credits.reserved === 0 && w.u().credits.available === 1030,
    JSON.stringify(w.u().credits));
  check("B1 bitta refund yozuvi", w.db.transactions.filter((t) => t.type === "order_refund").length === 1);
  check("B1 vazifalar CANCELLED", w.db.tasks.every((t) => t.status === "CANCELLED"));
  check("B1 muvaffaqiyat xabari saqlangandan keyin", w.notifies.length === 1);
  check("B1 ledger farqi 0", w.parity().ok, JSON.stringify(w.parity()));

  const again = await w.api.cancelOrderAdmin(w.db.orders[0]);
  check("B1 takroriy bekor qilish rad etildi", again.ok === false && again.reason === "already_closed");
  check("B1 takrorda balans o'zgarmadi", w.u().credits.available === 1030 && w.u().credits.reserved === 0);
}
{
  // B2. jurnalda refund bor, buyurtma esa hali active → dublikat to'lov yo'q.
  const db = seed();
  db.transactions.push({ id: "tx-ref", userId: "u-1", amount: 30, type: "order_refund", orderId: "ord-1", idempotencyKey: "refund:ord-1" });
  const w = world(db);
  const res = await w.api.cancelOrderAdmin(w.db.orders[0]);
  check("B2 dublikat qaytim rad etildi", res.ok === false && res.reason === "duplicate", JSON.stringify(res));
  check("B2 balans o'zgarmadi", w.u().credits.available === 1000 && w.u().credits.reserved === 30);
  check("B2 audit yozuvi", w.db.auditLog.some((l) => l.action === "refund_rejected" && /already_refunded/.test(l.meta)));
}
{
  // B3. reserved yetmaydi → rad, hech narsa o'zgarmaydi.
  const db = seed();
  db.users[1].credits.reserved = 5;
  const w = world(db);
  const res = await w.api.cancelOrderAdmin(w.db.orders[0]);
  check("B3 reserved yetmasa rad etildi", res.ok === false && res.reason === "reserved_insufficient", JSON.stringify(res));
  check("B3 balans/jurnal o'zgarmadi", w.u().credits.available === 1000 && w.u().credits.reserved === 5 && w.db.transactions.length === 2);
  check("B3 buyurtma active qoldi", w.db.orders[0].status === "active");
  check("B3 audit diagnostikasi", w.db.auditLog.some((l) => l.action === "refund_rejected" && /reserved_insufficient/.test(l.meta)));
}
{
  // B4. 20 parallel admin bekor qilish → bitta qaytim.
  const w = world();
  for (let i = 0; i < 20; i++) await w.api.cancelOrderAdmin(w.db.orders[0]);
  check("B4 20 parallel: bitta refund yozuvi", w.db.transactions.filter((t) => t.type === "order_refund").length === 1);
  check("B4 20 parallel: balans bir marta o'zgardi", w.u().credits.available === 1030 && w.u().credits.reserved === 0);
  check("B4 20 parallel: bitta xabar", w.notifies.length === 1);
  check("B4 ledger farqi 0", w.parity().ok);
}
{
  // B5. saqlash xatosi → buyurtma va balans qaytariladi, xabar yo'q.
  const w = world(seed(), { failWrites: true });
  const res = await w.api.cancelOrderAdmin(w.db.orders[0]);
  check("B5 save xatosi: save_failed", res.ok === false && res.reason === "save_failed", JSON.stringify(res));
  check("B5 buyurtma active, reserved 30", w.db.orders[0].status === "active" && w.u().credits.reserved === 30,
    JSON.stringify({ o: w.db.orders[0].status, reserved: w.u().credits.reserved }));
  check("B5 jurnal 0, vazifalar PENDING", w.db.transactions.filter((t) => t.type === "order_refund").length === 0 && w.db.tasks.every((t) => t.status === "PENDING"));
  check("B5 notify yuborilmadi", w.notifies.length === 0);
  check("B5 ledger farqi 0", w.parity().ok);
}
{
  // B6. foydalanuvchi bekor qilishi: reserved yetmasa rad etiladi.
  const db = seed();
  db.users[1].credits.reserved = 5;
  const w = world(db);
  await w.api.cancelOrder(w.u(), "ord-1", 1);
  const msg = w.sent.slice(-1)[0].text;
  check("B6 foydalanuvchi refund: reserved yetmasa rad", /nomuvofiqlik/.test(msg), msg);
  check("B6 balans o'zgarmadi", w.u().credits.available === 1000 && w.u().credits.reserved === 5);
  check("B6 audit yozuvi", w.db.auditLog.some((l) => l.action === "refund_rejected"));
}
{
  // B7. foydalanuvchi bekor qilishi: normal va takroriy.
  const w = world();
  await w.api.cancelOrder(w.u(), "ord-1", 1);
  check("B7 normal refund: 30 qaytdi", w.u().credits.available === 1030 && w.u().credits.reserved === 0);
  check("B7 bitta yozuv", w.db.transactions.filter((t) => t.type === "order_refund").length === 1);
  check("B7 xabar", /Buyurtma bekor qilindi/.test(w.sent.slice(-1)[0].text));
  check("B7 ledger farqi 0", w.parity().ok);
  await w.api.cancelOrder(w.u(), "ord-1", 1);
  check("B7 takroriy bekor qilish: hech narsa o'zgarmadi", w.u().credits.available === 1030 && w.db.transactions.filter((t) => t.type === "order_refund").length === 1);
}

/* ═══════════ C. F2 — order client_token ═══════════ */
{
  const w = world();
  const tok = "a1b2c3d4e5f60708";
  w.db.orderTokens[tok] = { token: tok, userId: "u-1", destId: "ch-1", qty: 50, platform: "telegram", inflight: false, orderId: "" };
  const claims = [];
  for (let i = 0; i < 20; i++) claims.push(w.api.claimOrderToken(w.u(), "ch-1", 50, tok));
  const okClaims = claims.filter((c) => c.ok && !c.order);
  const inflight = claims.filter((c) => !c.ok && c.text === "ord_inflight");
  check("C1 20 parallel da'vo: faqat bittasi egalik oldi", okClaims.length === 1, `ok=${okClaims.length}`);
  check("C1 qolgan 19 tasi 'yaratilmoqda'", inflight.length === 19, `inflight=${inflight.length}`);
  check("C1 token band qilindi", w.db.orderTokens[tok].inflight === true);

  const other = w.api.claimOrderToken(w.db.users[2], "ch-1", 50, tok);
  check("C2 boshqa foydalanuvchi tokenini ishlata olmaydi", other.ok === false);
  const mismatch = w.api.claimOrderToken(w.u(), "ch-1", 10, tok);
  check("C2 miqdor/manzil mos kelmasa rad", mismatch.ok === false);
  const missing = w.api.claimOrderToken(w.u(), "ch-1", 50, "");
  check("C2 tokensiz so'rov rad etiladi", missing.ok === false && missing.text === "ord_token_missing");
  const unknown = w.api.claimOrderToken(w.u(), "ch-1", 50, "0011223344556677");
  check("C2 noma'lum token rad etiladi", unknown.ok === false);

  // Muvaffaqiyatli yaratilgandan keyin: takroriy so'rov mavjud buyurtmani qaytaradi.
  w.db.orderTokens[tok].orderId = "ord-1";
  w.db.orderTokens[tok].inflight = false;
  const replay = w.api.claimOrderToken(w.u(), "ch-1", 50, tok);
  check("C3 takroriy so'rov mavjud buyurtmani qaytaradi", replay.ok === true && replay.order && replay.order.id === "ord-1");
  check("C3 yangi da'vo yaratilmadi (inflight false)", w.db.orderTokens[tok].inflight === false);
  check("C3 buyurtmalar soni o'zgarmadi", w.db.orders.length === 1);
}

/* ═══════════ D. F4 — referal: yagona hamyonga 300 kredit ═══════════ */
{
  const db = seed();
  db.referrals.push({
    id: "ref-1", referrerId: "u-1", referrerName: "U1", referredUserId: "u-2", referredUserName: "U2",
    isRegistered: true, hasCompletedTask: false, isVerified: false, bonusIssued: false, bonusAmount: 0
  });
  const w = world(db);
  await w.api.tryQualifyReferral(w.db.users[2]);
  const tx = w.db.transactions.filter((t) => t.type === "REFERRAL_REWARD");
  check("D1 REFERRAL_REWARD yozuvi +300", tx.length === 1 && tx[0].amount === 300, JSON.stringify(tx));
  check("D1 balans +300 (yagona hamyon)", w.u().credits.available === 1300, String(w.u().credits.available));
  check("D1 ledger farqi 0", w.parity().ok, JSON.stringify(w.parity()));
  check("D1 bepul birlik buyurtmasi YARATILMADI", w.db.orders.length === 1 && !w.db.orders.some((o) => o.source === "referral_bonus"));
  check("D1 pendingRefBonus ishlatilmadi", w.u().pendingRefBonus === void 0);
  check("D1 bonus bir marta deb belgilandi", w.db.referrals[0].bonusIssued === true && w.db.referrals[0].bonusAmount === 300);
  check("D1 idempotency kaliti", tx.length === 1 && tx[0].idempotencyKey === "refreward:ref-1");
  check("D1 darhol saqlandi", w.state.writes.length === 1);
  check("D1 bildirishnoma bitta", w.notifies.length === 1);

  await w.api.tryQualifyReferral(w.db.users[2]);
  check("D2 takroriy chaqiruv qo'shmaydi", w.db.transactions.filter((t) => t.type === "REFERRAL_REWARD").length === 1 && w.u().credits.available === 1300);
}
{
  // D3. o'zini referal qilish.
  const db = seed();
  db.referrals.push({ id: "ref-self", referrerId: "u-1", referredUserId: "u-1", isRegistered: true, bonusIssued: false, bonusAmount: 0 });
  const w = world(db);
  await w.api.tryQualifyReferral(w.db.users[1]);
  check("D3 o'zini referal qilish bonus bermaydi", w.db.transactions.filter((t) => t.type === "REFERRAL_REWARD").length === 0 && w.u().credits.available === 1000);
}
{
  // D4. bloklangan referrer.
  const db = seed();
  db.users[1].status = "blocked";
  db.referrals.push({ id: "ref-b", referrerId: "u-1", referredUserId: "u-2", isRegistered: true, bonusIssued: false, bonusAmount: 0 });
  const w = world(db);
  await w.api.tryQualifyReferral(w.db.users[2]);
  check("D4 bloklangan referrerga bonus berilmaydi", w.db.transactions.filter((t) => t.type === "REFERRAL_REWARD").length === 0);
}
{
  // D5. saqlash xatosi → bonus qaytariladi, bildirishnoma yo'q.
  const db = seed();
  db.referrals.push({ id: "ref-2", referrerId: "u-1", referredUserId: "u-2", isRegistered: true, bonusIssued: false, bonusAmount: 0 });
  const w = world(db, { failWrites: true });
  await w.api.tryQualifyReferral(w.db.users[2]);
  check("D5 save xatosi: bonus qaytarildi", w.u().credits.available === 1000 && w.db.transactions.filter((t) => t.type === "REFERRAL_REWARD").length === 0);
  check("D5 bonusIssued qaytarildi", w.db.referrals[0].bonusIssued === false);
  check("D5 notify yuborilmadi", w.notifies.length === 0);
  check("D5 ledger farqi 0", w.parity().ok, JSON.stringify(w.parity()));
}
{
  // D6. standart qiymat 200 (manba bo'yicha).
  check("D6 defaultSettings: creditRewardReferral = 300", /creditRewardReferral: 300/.test(src));
  // D7. ishlatilgan barcha ledger yozuvlari idempotencyKey bilan.
  const w = world();
  await w.api.applyAdminAdjust(w.u(), 5, "a", "k1");
  await w.api.tryQualifyReferral(w.db.users[2]);
  const noKey = w.db.transactions.filter((t) => !t.idempotencyKey && t.id !== "tx-seed" && t.id !== "tx-res");
  check("D7 yangi yozuvlarning hammasida idempotencyKey", noKey.length === 0, JSON.stringify(noKey));
  // D8. Malaka faqat haqiqiy `getChatMember` tasdig'idan: `firstTg` faqat
  // Telegram platformasida o'rnatiladi va faqat u referalni malakalantiradi.
  const vStart = src.indexOf("async function verifyBatch(");
  const vBody = src.slice(vStart, src.indexOf("async function", vStart + 10));
  check("D8 referal faqat Telegram tasdiqdan chaqiriladi",
    /if \(firstTg\) await tryQualifyReferral\(u, \{ defer: refNotices, noSave: true \}\);/.test(vBody) && /if \(platform === "telegram"\) firstTg = true;/.test(vBody));
  check("D8 Instagram/SELF_CONFIRMED yo'lida referal chaqiruvi yo'q", !/tryQualifyReferral/.test(src.slice(src.indexOf("async function applyVerified("), src.indexOf("async function tryQualifyReferral("))));
  // D9. TASK_CHECK job yo'lida ham (haqiqiy getChatMember) malaka beriladi.
  const jStart = src.indexOf("async function runTaskCheckJob(");
  const jBody = src.slice(jStart, src.indexOf("\nfunction ", src.indexOf("checkMemberInfo", jStart) + 10));
  check("D9 job yo'lida referal malakasi (telegram, reward>0)",
    /if \(got > 0 && t\.platform === "telegram"\) await tryQualifyReferral\(u, \{ defer: notices, noSave: true \}\);/.test(src));
  check("D9 job yo'li ham checkMemberInfo ishlatadi", /checkMemberInfo\(dest\.channelId/.test(jBody));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed ? 1 : 0);
