// Kredit rekonciliatsiyasi — SOF funksiyalar (I/O yo'q, test qilinadi).
//
// Ikki xil sxema mavjud:
//
//  1) AMALDAGI (runtime) sxema — `app_state` JSON ichidagi `transactions[]`.
//     Har bir yozuvda faqat `amount` bor va u FAQAT `available` ni o'zgartiradi.
//     `reserved` alohida maydon bo'lib, u quyidagicha yuritiladi:
//       - buyurtma yaratish : available -= C, reserved += C, tx amount = -C
//       - birlik yetkazildi : reserved -= u, spent += u, TX YOZILMAYDI
//       - bekor qilish      : available += X, reserved -= X, tx amount = +X
//     Shu sababli `Σ amount` = available, LEKIN total ham, reserved ham
//     `Σ amount` ga teng emas. To'g'ri formulalar:
//
//       available = Σ amount
//       reserved  = Σ|order_spend| − Σ(order_refund) − spent
//       total     = available + reserved
//
//     Tekshiruv: available va total mustaqil; reserved esa `spent` hisobiga
//     tayanadi (chunki ORDER_FULFILL uchun yozuv yo'q).
//
//  2) MAQSADLI (delta) sxema — `credit_transactions.available_delta /
//     reserved_delta`. Bu yerda:
//
//       available = opening_available + Σ available_delta
//       reserved  = opening_reserved  + Σ reserved_delta
//       total     = available + reserved
//
//     Ya'ni reservation `(-C, +C)` yozadi va totalni o'zgartirmaydi.

import crypto from "node:crypto";

export const RUNTIME_RESERVE_TYPES = new Set(["order_spend"]);
export const RUNTIME_REFUND_TYPES = new Set(["order_refund"]);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const near = (a, b) => Math.abs(a - b) < 1e-6;

/* ───────────────────────── 1. Amaldagi (amount) sxema ───────────────────────── */

/**
 * Bitta foydalanuvchining tranzaksiyalaridan kutilgan hamyon holati.
 * @param {Array<{amount:number,type:string}>} txs
 * @param {number} spent `credits.spent` (yetkazilgan PULLIK birliklar summasi)
 */
export function runtimeLedger(txs, spent) {
  let sumAmounts = 0;
  let reservedByOrders = 0;
  let refundedFromOrders = 0;
  let rewards = 0;
  for (const t of txs) {
    const a = num(t.amount);
    sumAmounts += a;
    if (RUNTIME_RESERVE_TYPES.has(t.type)) reservedByOrders += -a;
    if (RUNTIME_REFUND_TYPES.has(t.type)) refundedFromOrders += a;
    if (t.type === "reward_task" || t.type === "referral_reward" || t.type === "REFERRAL_REWARD") rewards += Math.max(0, a);
  }
  const available = sumAmounts;
  const reserved = reservedByOrders - refundedFromOrders - num(spent);
  return {
    available,
    reserved,
    total: available + reserved,
    sumAmounts,
    reservedByOrders,
    refundedFromOrders,
    fulfilledPaid: num(spent),
    rewards,
    txCount: txs.length
  };
}

/**
 * Bitta foydalanuvchi: saqlangan holat ↔ ledger.
 * `causes` — farqning ehtimoliy sabablari (avtomatik tuzatish YO'Q).
 */
export function reconcileUser(user, txs, orders = []) {
  const c = (user && user.credits) || {};
  const calc = runtimeLedger(txs, c.spent);
  const stored = {
    available: num(c.available),
    reserved: num(c.reserved),
    total: num(c.available) + num(c.reserved)
  };
  const delta = {
    available: stored.available - calc.available,
    reserved: stored.reserved - calc.reserved,
    total: stored.total - calc.total
  };
  const causes = [];
  if (!near(delta.available, 0)) {
    // `available` faqat `amount` bilan o'zgaradi; farq = yozilmagan harakat.
    const noKey = txs.filter((t) => !t.idempotencyKey).length;
    if (noKey) causes.push(`ledger yozuvlarida idempotencyKey yo'q (${noKey} ta) — eski/legacy yozuv`);
    if (user && user.credits && num(user.credits.signupBonus) > 0 && !txs.some((t) => t.type === "signup_bonus"))
      causes.push("signup_bonus hisobda bor, jurnalda yo'q");
    causes.push("jurnalsiz qo'lda o'zgartirish (eski admin amali yoki addTx dan oldingi kod)");
  }
  if (!near(delta.reserved, 0)) {
    const freeUnits = orders.filter((o) => num(o.freeUnits) > 0);
    if (freeUnits.length)
      causes.push(`bepul birliklar berilgan buyurtmalar (${freeUnits.length} ta): ular uchun bandlik kamaymaydi`);
    const active = orders.filter((o) => o.status === "active");
    if (active.length) causes.push("ochiq buyurtmalar bor — bekor qilishda faqat pullik birliklar qaytariladi");
    causes.push("`spent` hisoblagichi bilan ziddiyat (ORDER_FULFILL uchun jurnal yozuvi yo'q)");
  }
  return {
    userId: (user && user.id) || "",
    stored,
    calc,
    delta,
    ok: near(delta.available, 0) && near(delta.reserved, 0) && near(delta.total, 0),
    causes
  };
}

/** Butun baza bo'yicha yig'ma rekonciliatsiya. */
export function summarizeRuntime(users, transactions, orders = []) {
  const byUser = new Map();
  for (const t of transactions || []) {
    const k = t.userId;
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(t);
  }
  const ordersByUser = new Map();
  for (const o of orders || []) {
    if (!ordersByUser.has(o.userId)) ordersByUser.set(o.userId, []);
    ordersByUser.get(o.userId).push(o);
  }
  const perUser = [];
  for (const [key, u] of Object.entries(users || {})) {
    if (!u || typeof u !== "object" || !u.id) continue;
    const txs = byUser.get(u.id) || byUser.get(key) || [];
    perUser.push(reconcileUser(u, txs, ordersByUser.get(u.id) || []));
  }
  // Jurnalda foydalanuvchisi topilmaydigan yozuvlar (o'chirilgan hisob) — hisobotga tushadi.
  const known = new Set(perUser.map((p) => p.userId));
  const orphanUsers = new Set();
  for (const [k, list] of byUser) {
    if (known.has(k)) continue;
    if (list.some((t) => t && t.userId)) orphanUsers.add(list[0].userId || k);
  }
  const orphans = [...orphanUsers];
  const sums = perUser.reduce(
    (a, p) => {
      a.storedAvailable += p.stored.available;
      a.storedReserved += p.stored.reserved;
      a.calcAvailable += p.calc.available;
      a.calcReserved += p.calc.reserved;
      if (!p.ok) a.mismatched++;
      if (p.stored.available < 0) a.negative++;
      return a;
    },
    { storedAvailable: 0, storedReserved: 0, calcAvailable: 0, calcReserved: 0, mismatched: 0, negative: 0 }
  );
  return {
    model: "amount",
    done: "`Σ amount` = available; total = available + reserved",
    users: perUser.length,
    matched: perUser.filter((p) => p.ok).length,
    mismatched: sums.mismatched,
    negative: sums.negative,
    orphanTxUsers: orphans,
    totals: {
      stored: { available: sums.storedAvailable, reserved: sums.storedReserved, total: sums.storedAvailable + sums.storedReserved },
      calc: { available: sums.calcAvailable, reserved: sums.calcReserved, total: sums.calcAvailable + sums.calcReserved }
    },
    perUser
  };
}

/* ───────────────────────── 2. Maqsadli (delta) sxema ───────────────────────── */

export function deltaLedger(txs, opening = { available: 0, reserved: 0 }) {
  let da = num(opening.available);
  let dr = num(opening.reserved);
  for (const t of txs) {
    da += num(t.available_delta);
    dr += num(t.reserved_delta);
  }
  return { available: da, reserved: dr, total: da + dr };
}

export function reconcileDeltaUser(wallet, txs) {
  const stored = {
    available: num(wallet.available),
    reserved: num(wallet.reserved),
    total: num(wallet.available) + num(wallet.reserved)
  };
  const calc = deltaLedger(txs);
  const delta = {
    available: stored.available - calc.available,
    reserved: stored.reserved - calc.reserved,
    total: stored.total - calc.total
  };
  return { stored, calc, delta, ok: near(delta.available, 0) && near(delta.reserved, 0) && near(delta.total, 0) };
}

/* ───────────────────────── 3. Qulf probe kaliti ───────────────────────── */

/**
 * Probe uchun ALOHIDA, tasodifiy kalit. Production polling kaliti
 * (`poll:<sha1(token)>`) hech qachon olinmaydi — faqat o'qiladi.
 */
export function probeKey(randomHex) {
  return "probe:" + String(randomHex || "").slice(0, 32);
}

export function isProductionPollKey(key) {
  return String(key || "").startsWith("poll:");
}

/**
 * `pg_locks` advisory (int8) kalitini classid/objid juftligiga ajratadi.
 * Postgres 64-bit kalitni shunday saqlaydi — SQL ham AYNAN shu formuladan
 * foydalanadi (o'qish-only, qulf olinmaydi).
 */
export function splitAdvisoryKey(key) {
  const k = BigInt(key);
  const mask = 4294967295n;
  return { classid: (k >> 32n) & mask, objid: k & mask };
}

/** Faol buyurtmalarda qolgan bepul birliklar — reserved ularni ham qamraydi. */
export function freeUnitsPending(orders = []) {
  const list = (orders || []).filter((o) => o && o.status === "active" && num(o.freeUnits) > 0);
  return { orders: list.length, units: list.reduce((a, o) => a + num(o.freeUnits), 0) };
}

export function randomProbeKey() {
  return probeKey(crypto.randomBytes(16).toString("hex"));
}

/**
 * Qulf MEXANIZMI probe'i. Production polling kalitini hech qachon olmaydi.
 * Advisory lock sessiyaga bog'liq → olish/bo'shatish bitta ajratilgan klientda.
 * Qulf HAR QANDAY holatda bo'shatiladi.
 */
export async function probeLockMechanism(pool, key = randomProbeKey()) {
  if (isProductionPollKey(key)) throw new Error("probe kaliti production kaliti bo'lishi mumkin emas");
  const client = await pool.connect();
  let acquired = false;
  let released = false;
  try {
    const k = String((await client.query("SELECT hashtextextended($1, 0) AS k", [key])).rows[0].k);
    acquired = (await client.query("SELECT pg_try_advisory_lock($1::bigint) AS ok", [k])).rows[0].ok === true;
    if (acquired) {
      try {
        released = (await client.query("SELECT pg_advisory_unlock($1::bigint) AS ok", [k])).rows[0].ok === true;
      } catch {
        released = false; // quyidagi `finally` zaxira yo'li bo'shatadi
      }
    }
  } finally {
    if (acquired && !released) {
      try {
        await client.query("SELECT pg_advisory_unlock_all()");
        released = true;
      } catch {}
    }
    client.release();
  }
  // Natija `finally` dan KEYIN quriladi — aks holda zaxira bo'shatish
  // `released: false` bo'lib qaytardi.
  return { key, acquired, released };
}
