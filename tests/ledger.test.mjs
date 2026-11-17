// §2.5 (A band) — ledger matematikasi spetsifikatsiya testi.
// Bu test production kodini emas, HUJJATDAGI formulalarni qulflaydi:
// available = Σ available_delta, reserved = Σ reserved_delta,
// total = Σ (available_delta + reserved_delta).
import assert from "node:assert/strict";

let pass = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    results.push({ name, ok: true });
    console.log("PASS  " + name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL  " + name + "  — " + e.message);
  }
}

/* ---- hujjatdagi sof funksiyalar ---- */

function applyTx(wallet, tx) {
  const available = wallet.available + tx.available_delta;
  const reserved = wallet.reserved + tx.reserved_delta;
  // Bazadagi CHECK (available >= 0) / CHECK (reserved >= 0) ekvivalenti.
  if (available < 0) throw new Error("NEGATIVE_AVAILABLE");
  if (reserved < 0) throw new Error("NEGATIVE_RESERVED");
  if (tx.available_delta === 0 && tx.reserved_delta === 0) throw new Error("EMPTY_TX");
  return { available, reserved };
}

function reconcile(txs) {
  const s = { available: 0, reserved: 0 };
  for (const tx of txs) {
    s.available += tx.available_delta;
    s.reserved += tx.reserved_delta;
  }
  return { ...s, total: s.available + s.reserved };
}

function orderReserved(order, txs) {
  return txs
    .filter((t) => t.related_order_id === order.id)
    .reduce((a, t) => a + t.reserved_delta, 0);
}

function expectedOrderReserved(order) {
  return (order.requested - order.verified - order.free_units) * order.unit_cost;
}

const tx = (type, available_delta, reserved_delta, extra = {}) => ({
  type,
  available_delta,
  reserved_delta,
  ...extra
});

/* ---- 1. Buyurtma yaratish: total o'zgarmaydi ---- */
check("RESERVATION available -600 / reserved +600, total o'zgarmaydi", () => {
  const w0 = { available: 1000, reserved: 0 };
  const w1 = applyTx(w0, tx("ORDER_RESERVATION", -600, 600, { related_order_id: "o1" }));
  assert.deepEqual(w1, { available: 400, reserved: 600 });
  assert.equal(w1.available + w1.reserved, 1000);
});

/* ---- 2. Birlik yetkazildi: reserved kamayadi, total bittaga tushadi ---- */
check("ORDER_FULFILL 2 birlik: reserved 600→598, total 1000→998", () => {
  let w = { available: 400, reserved: 600 };
  w = applyTx(w, tx("ORDER_FULFILL", 0, -1, { related_order_id: "o1" }));
  w = applyTx(w, tx("ORDER_FULFILL", 0, -1, { related_order_id: "o1" }));
  assert.deepEqual(w, { available: 400, reserved: 598 });
  assert.equal(w.available + w.reserved, 998);
});

/* ---- 3. Mukofot ---- */
check("TASK_REWARD +100 available, reserved o'zgarmaydi", () => {
  const w = applyTx({ available: 400, reserved: 598 }, tx("TASK_REWARD", 100, 0));
  assert.deepEqual(w, { available: 500, reserved: 598 });
});

/* ---- 4. Bekor qilish: qaytim 598, yakuniy 1098 / 0 ---- */
check("ORDER_REFUND 598: available 1098, reserved 0, spent 2", () => {
  const w = applyTx({ available: 500, reserved: 598 }, tx("ORDER_REFUND", 598, -598, { related_order_id: "o1" }));
  assert.deepEqual(w, { available: 1098, reserved: 0 });
  // 1000 (boshlang'ich) - 2 (spent) + 100 (reward) = 1098
  assert.equal(w.available, 1000 - 2 + 100);
});

/* ---- 5. REVERSAL xatoni qaytaradi, manfiyga tushirmaydi ---- */
check("REVERSAL -100, keyin takroriy REVERSAL manfiyga tushirmaydi", () => {
  const w1 = applyTx({ available: 500, reserved: 598 }, tx("REVERSAL", -100, 0));
  assert.equal(w1.available, 400);
  assert.throws(
    () => applyTx({ available: 50, reserved: 0 }, tx("REVERSAL", -100, 0)),
    /NEGATIVE_AVAILABLE/
  );
});

/* ---- 6. To'liq oqim rekonciliatsiyasi ---- */
check("5 amal: rekonciliatsiya hamyon bilan aynan mos", () => {
  const txs = [
    tx("ORDER_RESERVATION", -600, 600, { related_order_id: "o1" }),
    tx("ORDER_FULFILL", 0, -1, { related_order_id: "o1" }),
    tx("ORDER_FULFILL", 0, -1, { related_order_id: "o1" }),
    tx("TASK_REWARD", 100, 0),
    tx("ORDER_REFUND", 598, -598, { related_order_id: "o1" })
  ];
  let w = { available: 1000, reserved: 0 };
  for (const t of txs) w = applyTx(w, t);
  const r = reconcile(txs);
  const start = { available: 1000, reserved: 0 };
  assert.equal(w.available, start.available + r.available);
  assert.equal(w.reserved, start.reserved + r.reserved);
  assert.equal(w.available + w.reserved, start.available + start.reserved + r.total);
  assert.deepEqual(w, { available: 1098, reserved: 0 });
});

/* ---- 7. Buyurtma darajasidagi bandlik ---- */
check("order_reserved = (requested - verified - free_units) × unit_cost", () => {
  const txs = [
    tx("ORDER_RESERVATION", -600, 600, { related_order_id: "o1" }),
    tx("ORDER_FULFILL", 0, -1, { related_order_id: "o1" }),
    tx("ORDER_FULFILL", 0, -1, { related_order_id: "o1" })
  ];
  const order = { id: "o1", requested: 600, verified: 2, free_units: 0, unit_cost: 1 };
  assert.equal(orderReserved(order, txs), 598);
  assert.equal(expectedOrderReserved(order), 598);

  // Bepul birliklar BIRINCHI sarflanadi: tasdiqlangan birlik `free_units` dan
  // ayriladi va ledger yozuvi bo'lmaydi. Shuning uchun 2 ta tasdiqlangan
  // birlikdan keyin ham bandlik 210 bo'lib qoladi (free_units 50 → 48).
  const granted = { id: "o2", requested: 260, verified: 2, free_units: 48, unit_cost: 1 };
  const gtx = [tx("ORDER_RESERVATION", -210, 210, { related_order_id: "o2" })];
  assert.equal(orderReserved(granted, gtx), 210);
  assert.equal(expectedOrderReserved(granted), 210);
  // 50 ta bepul birlik tugagach (verified=50, free=0) bandlik hali 210 —
  // pullik birliklar hali yetkazilmagan.
  const exhausted = { id: "o2", requested: 260, verified: 50, free_units: 0, unit_cost: 1 };
  assert.equal(orderReserved(exhausted, gtx), 210);
  assert.equal(expectedOrderReserved(exhausted), 210);
  // Endi har bir tasdiqlash `ORDER_FULFILL` yozadi: 10 ta → 200.
  const gtx2 = [...gtx];
  for (let i = 0; i < 10; i++) gtx2.push(tx("ORDER_FULFILL", 0, -1, { related_order_id: "o2" }));
  const after10 = { id: "o2", requested: 260, verified: 60, free_units: 0, unit_cost: 1 };
  assert.equal(orderReserved(after10, gtx2), 200);
  assert.equal(expectedOrderReserved(after10), 200);
});

/* ---- 8. Eski bir ishorali model izchil emas (A bandning sababi) ---- */
check("bitta ishorali amount modeli totalni buzadi (eski xato)", () => {
  const badTotal = -600; // ORDER_RESERVATION amount = -cost
  assert.notEqual(badTotal, 0, "eski model total o'zgarishini 0 bermaydi");
  const good = tx("ORDER_RESERVATION", -600, 600);
  assert.equal(good.available_delta + good.reserved_delta, 0);
});

/* ---- 9. Idempotent buyurtma qarori (B band) ---- */
function createOrderDecision({ inserted, existing, canAfford }) {
  if (!inserted) {
    if (!existing) throw new Error("CONFLICT_WITHOUT_ROW");
    return { created: false, duplicate: true, orderId: existing.id, status: existing.status, reserveAgain: false };
  }
  if (!canAfford) return { created: false, rollback: true, reason: "INSUFFICIENT" };
  return { created: true, reserveAgain: true };
}
check("mavjud client_token: yangi order yo'q, kredit qayta band qilinmaydi", () => {
  const d = createOrderDecision({ inserted: false, existing: { id: "ord-1", status: "active" }, canAfford: true });
  assert.deepEqual(d, { created: false, duplicate: true, orderId: "ord-1", status: "active", reserveAgain: false });
});
check("kredit yetmasa: butun tranzaksiya rollback (order ham yo'q)", () => {
  const d = createOrderDecision({ inserted: true, existing: null, canAfford: false });
  assert.equal(d.rollback, true);
  assert.equal(d.created, false);
});
check("yangi token + yetarli kredit: bitta band qilish", () => {
  const d = createOrderDecision({ inserted: true, existing: null, canAfford: true });
  assert.deepEqual(d, { created: true, reserveAgain: true });
});

/* ---- 10. Bepul birliklar pul harakati qilmaydi ---- */
check("free_units uchun ledger yozuvi yo'q, bandlikda ayiriladi", () => {
  const order = { id: "o2", requested: 260, verified: 2, free_units: 48, unit_cost: 1 };
  const txs = [tx("ORDER_RESERVATION", -210, 210, { related_order_id: "o2" })];
  assert.equal(orderReserved(order, txs), 210);
  assert.equal(expectedOrderReserved(order), 210);
});

/* ═══════════════ Amaldagi (amount) sxema — rekonciliatsiya ═══════════════ */
// server.js semantikasi: reservation available−C/reserved+C va tx −C;
// ORDER_FULFILL reserved−u/spent+u, JURNAL YOZILMAYDI; refund +X/−X.
import { runtimeLedger, reconcileUser, summarizeRuntime, probeKey, isProductionPollKey, probeLockMechanism, freeUnitsPending, splitAdvisoryKey } from "../scripts/lib/ledger-reconcile.mjs";

function simRuntime(start, events) {
  const w = { available: start.available, reserved: start.reserved, spent: start.spent || 0 };
  const txs = [];
  for (const e of events) {
    if (e.op === "inflow") {
      w.available += e.amount;
      txs.push({ type: e.txType || "reward_task", amount: e.amount, idempotencyKey: e.key });
    } else if (e.op === "reserve") {
      w.available -= e.cost;
      w.reserved += e.cost;
      txs.push({ type: "order_spend", amount: -e.cost, orderId: e.orderId, idempotencyKey: `reserve:${e.orderId}` });
    } else if (e.op === "fulfill") {
      // Bepul birlik birinchi sarflanadi — u holda reserved kamaymaydi.
      if (e.free) e.free.units -= 1;
      else {
        w.reserved -= e.unitCost;
        w.spent += e.unitCost;
      }
    } else if (e.op === "refund") {
      w.available += e.amount;
      w.reserved -= e.amount;
      txs.push({ type: "order_refund", amount: e.amount, orderId: e.orderId, idempotencyKey: `refund:${e.orderId}` });
    }
  }
  return { w, txs };
}

function one(events, start = { available: 0, reserved: 0, spent: 0 }) {
  const { w, txs } = simRuntime(start, events);
  const calc = runtimeLedger(txs, w.spent);
  const user = { id: "u-1", credits: { available: w.available, reserved: w.reserved, spent: w.spent } };
  return { w, txs, calc, rec: reconcileUser(user, txs) };
}

check("runtime 1: boshlang'ich balans — available = Σ amount", () => {
  const r = one([
    { op: "inflow", amount: 100, txType: "signup_bonus", key: "signup:u-1" },
    { op: "inflow", amount: 1000, key: "reward:t1" }
  ]);
  assert.deepEqual(r.w, { available: 1100, reserved: 0, spent: 0 });
  assert.equal(r.calc.available, 1100);
  assert.equal(r.calc.reserved, 0);
  assert.equal(r.calc.total, 1100);
  assert.equal(r.rec.ok, true);
});

check("runtime 2: reservation available→reserved, TOTAL O'ZGARMAYDI", () => {
  const r = one([
    { op: "inflow", amount: 1000, key: "reward:t1" },
    { op: "reserve", cost: 600, orderId: "o1" }
  ]);
  assert.deepEqual(r.w, { available: 400, reserved: 600, spent: 0 });
  assert.equal(r.calc.available, 400);
  assert.equal(r.calc.reserved, 600);
  assert.equal(r.calc.total, 1000);
  assert.equal(r.rec.ok, true);
  // Eski (noto'g'ri) taxmin: total = Σ amount. Bu yerda 400 ≠ 1000.
  assert.notEqual(r.calc.sumAmounts, r.calc.total);
  assert.equal(r.calc.sumAmounts, r.calc.available);
});

check("runtime 3: TASK_REWARD +100 — available/total +100, reserved tegilmagan", () => {
  const r = one([
    { op: "inflow", amount: 1000, key: "reward:t1" },
    { op: "reserve", cost: 600, orderId: "o1" },
    { op: "inflow", amount: 100, key: "reward:t2" }
  ]);
  assert.deepEqual(r.w, { available: 500, reserved: 600, spent: 0 });
  assert.equal(r.calc.total, 1100);
  assert.equal(r.rec.ok, true);
});

check("runtime 4: 2 birlik yetkazildi + bekor qilish (qaytim 598)", () => {
  const r = one([
    { op: "inflow", amount: 1000, key: "reward:t1" },
    { op: "reserve", cost: 600, orderId: "o1" },
    { op: "fulfill", unitCost: 1 },
    { op: "fulfill", unitCost: 1 },
    { op: "refund", amount: 598, orderId: "o1" }
  ]);
  assert.deepEqual(r.w, { available: 998, reserved: 0, spent: 2 });
  assert.equal(r.calc.available, 998);
  // reserved = Σ|order_spend| − Σ order_refund − spent = 600 − 598 − 2
  assert.equal(r.calc.reserved, 0);
  assert.equal(r.calc.total, 998);
  assert.equal(r.rec.ok, true);
});

check("runtime 5: REVERSAL (admin_adjustment −100) hisobga olinadi", () => {
  const r = one([
    { op: "inflow", amount: 500, key: "reward:t1" },
    { op: "inflow", amount: -100, txType: "admin_adjustment", key: "reversal:tx-9" }
  ]);
  assert.deepEqual(r.w, { available: 400, reserved: 0, spent: 0 });
  assert.equal(r.calc.available, 400);
  assert.equal(r.rec.ok, true);
});

check("runtime: bepul birliklar — reserved kamaymaydi, formula buni hisobga oladi", () => {
  const free = { units: 2 };
  const r = one([
    { op: "inflow", amount: 1000, key: "reward:t1" },
    { op: "reserve", cost: 600, orderId: "o1" },
    { op: "fulfill", unitCost: 1, free },
    { op: "fulfill", unitCost: 1, free }
  ]);
  assert.deepEqual(r.w, { available: 400, reserved: 600, spent: 0 });
  assert.equal(r.calc.reserved, 600);
  assert.equal(r.rec.ok, true);
});

check("runtime: legacy farq aniqlanadi, AVTOMATIK tuzatilmaydi (faqat sabab)", () => {
  const user = { id: "u-legacy", credits: { available: 350, reserved: 0, spent: 0, signupBonus: 100 } };
  const txs = [{ id: "tx-1", userId: "u-legacy", type: "reward_task", amount: 250 }];
  const rec = reconcileUser(user, txs);
  assert.equal(rec.ok, false);
  assert.equal(rec.delta.available, 100);
  assert.ok(rec.causes.length > 0);
  assert.equal(user.credits.available, 350, "reconcile foydalanuvchi balansini o'zgartirmaydi");
  assert.equal(txs.length, 1, "ledger o'zgarmaydi");
});

check("runtime: bepul birliklar hamyon formulasini buzmaydi, alohida eslatma beriladi", () => {
  const user = { id: "u-2", credits: { available: 0, reserved: 100, spent: 0 } };
  const txs = [
    { type: "reward_task", amount: 100, idempotencyKey: "reward:t1" },
    { type: "order_spend", amount: -100, orderId: "o9", idempotencyKey: "reserve:o9" }
  ];
  const orders = [{ id: "o9", userId: "u-2", status: "active", freeUnits: 5 }];
  const rec = reconcileUser(user, txs, orders);
  assert.equal(rec.ok, true);
  const pend = freeUnitsPending(orders);
  assert.deepEqual(pend, { orders: 1, units: 5 });
  assert.equal(user.credits.reserved, 100);
});

check("runtime: reserved farqi `spent` ziddiyati sifatida tushuntiriladi", () => {
  const user = { id: "u-3", credits: { available: 0, reserved: 90, spent: 0 } };
  const txs = [{ type: "order_spend", amount: -100, orderId: "o9", idempotencyKey: "reserve:o9" }];
  const rec = reconcileUser(user, txs, [{ id: "o9", userId: "u-3", status: "active" }]);
  assert.equal(rec.ok, false);
  assert.ok(rec.causes.some((c) => /spent/.test(c)));
});

check("runtime: yig'ma hisobot barcha foydalanuvchilarni qamraydi", () => {
  const users = {
    1: { id: "u-1", credits: { available: 400, reserved: 600, spent: 0 } },
    2: { id: "u-2", credits: { available: 100, reserved: 0, spent: 0 } }
  };
  const txs = [
    { userId: "u-1", type: "reward_task", amount: 1000, idempotencyKey: "reward:t1" },
    { userId: "u-1", type: "order_spend", amount: -600, idempotencyKey: "reserve:o1" },
    { userId: "u-2", type: "reward_task", amount: 100, idempotencyKey: "reward:t2" }
  ];
  const s = summarizeRuntime(users, txs, []);
  assert.equal(s.users, 2);
  assert.equal(s.mismatched, 0);
  assert.equal(s.totals.stored.total, s.totals.calc.total);
  assert.equal(s.totals.calc.total, 1100);
});

/* ═════════════════════ Probe qulfi xavfsizligi (A/B band) ════════════════════ */

check("probe kaliti `probe:` prefiksli va tasodifiy", () => {
  const a = probeKey("a1b2c3d4e5f60718293a4b5c6d7e8f90");
  const b = probeKey("ffeeddccbbaa99887766554433221100");
  assert.ok(a.startsWith("probe:"));
  assert.notEqual(a, b);
  assert.equal(isProductionPollKey(a), false);
  assert.equal(isProductionPollKey("poll:abc"), true);
});

function fakePool({ unlockFails = false } = {}) {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/hashtextextended/.test(sql)) return { rows: [{ k: "5577006791947779410" }] };
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }] };
      if (/advisory_unlock_all/.test(sql)) return { rows: [{}] };
      if (/advisory_unlock/.test(sql)) {
        if (unlockFails) throw new Error("unlock failed");
        return { rows: [{ ok: true }] };
      }
      return { rows: [{}] };
    },
    release: () => calls.push({ release: true })
  };
  return { pool: { connect: async () => client }, calls, client };
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    results.push({ name, ok: true });
    console.log("PASS  " + name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL  " + name + "  — " + e.message);
  }
}

check("pg_locks kalit ajratishi (classid/objid) qaytariladi", () => {
  for (const key of ["5577006791947779410", "-1234567890123", "0", "9223372036854775807"]) {
    const { classid, objid } = splitAdvisoryKey(key);
    assert.ok(classid >= 0n && classid <= 4294967295n);
    assert.ok(objid >= 0n && objid <= 4294967295n);
    // Postgres 64-bit kalitni shu juftlikdan tiklaydi.
    const rebuilt = (classid << 32n) | objid;
    assert.equal(rebuilt, BigInt.asUintN(64, BigInt(key)));
  }
});

await checkAsync("probe: production kalitini OLMAYDI va qulfni bo'shatadi", async () => {
  const { pool, calls } = fakePool();
  const res = await probeLockMechanism(pool);
  assert.equal(res.acquired, true);
  assert.equal(res.released, true);
  assert.ok(res.key.startsWith("probe:"));
  const keys = calls.filter((c) => c.params && c.params.length).map((c) => String(c.params[0]));
  assert.ok(keys.every((k) => !k.startsWith("poll:")), "production polling kaliti ishlatilmasligi kerak");
  assert.ok(calls.some((c) => /advisory_unlock\(/.test(c.sql || "")));
  assert.ok(calls.some((c) => c.release), "klient har doim release qilinadi");
});

await checkAsync("probe: unlock yiqilsa ham qulf bo'shatiladi (unlock_all zaxira)", async () => {
  const { pool, calls } = fakePool({ unlockFails: true });
  const res = await probeLockMechanism(pool);
  assert.equal(res.released, true);
  assert.ok(calls.some((c) => /advisory_unlock_all/.test(c.sql || "")));
  assert.ok(calls.some((c) => c.release));
});

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${pass}/${results.length} PASS ===`);
if (failed.length) process.exitCode = 1;
