// `admin_adjustment` — admin qo'lda tuzatishining idempotentligi va ledger
// izchilligi. HAQIQIY `server.js` funksiyalari (`addTx`, `adminAdjust`) vm
// orqali olinadi.
//
// Tekshiriladi:
//  1. Bir xil idempotency kalit bilan takroriy so'rov ikkinchi marta
//     qo'llanmaydi (double-click/retry).
//  2. Kalitsiz so'rov at-least-once bo'lib qoladi (hujjatlashtirilgan cheklov).
//  3. Manfiy qoldiqqa olib keladigan tuzatish rad etiladi — eski
//     `Math.max(0, ...)` klampi jurnal bilan farq qilardi, endi farq yo'q.
//  4. Har bir amaldan keyin ledger ↔ hamyon mos.
//  5. Panel va bot buyrug'i `client_token` / kalitni uzatishi (manba tekshiruvi).
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
const CODE = cut("function addTx(", "async function tryQualifyReferral(");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
}

function world(credits = 100) {
  const db = {
    seq: 5,
    users: { 1: { id: "u-1", telegramId: 1, displayName: "U1", credits: { available: credits, reserved: 0, spent: 0, verifiedRewards: 0, selfReportedRewards: 0, refunded: 0 } } },
    channels: [], igProfiles: [], orders: [], tasks: [],
    transactions: [{ id: "tx-seed", userId: "u-1", amount: credits, type: "reward_task", idempotencyKey: "seed:reward" }],
    memberships: [], membershipEvents: [], verificationJobs: [], verifyLog: [], referrals: [],
    settings: {}
  };
  let seq = 100;
  const ctx = vm.createContext({
    CURRENT_OP: "",
    db, S: () => db.settings, nid: (p) => `${p}-${++seq}`, nowStr: () => new Date().toISOString(),
    userById: (id) => db.users[id] || null, notifOn: () => true, notify: () => {}, esc: (s) => String(s),
    console: { log: () => {}, warn: () => {}, error: () => {} }
  });
  vm.runInContext(CODE + "\n;globalThis.__api = { addTx, adminAdjust };", ctx);
  return { db, api: ctx.__api, u: db.users[1] };
}
function parity(db) {
  const u = db.users[1];
  const led = runtimeLedger(db.transactions.filter((t) => t.userId === "u-1"), u.credits.spent);
  return { ok: Math.abs(led.available - u.credits.available) < 1e-9, led, available: u.credits.available };
}

/* 1. Bir xil kalit — bir marta */
{
  const w = world(100);
  const a = w.api.adminAdjust(w.u, 50, "Admin panel", "adminadj:panel:root:tok-1");
  const beforeTx = w.db.transactions.length;
  const b = w.api.adminAdjust(w.u, 50, "Admin panel", "adminadj:panel:root:tok-1");
  const c = w.api.adminAdjust(w.u, 50, "Admin panel", "adminadj:panel:root:tok-1");
  check("kalitli: birinchi so'rov qo'llandi", a.ok && a.balance === 150, JSON.stringify(a));
  check("kalitli: takroriy so'rovlar rad etildi", !b.ok && !c.ok && b.reason === "duplicate", JSON.stringify(b));
  check("kalitli: global +50 faqat bir marta", w.u.credits.available === 150, w.u.credits.available);
  check("kalitli: aynan 1 ta yangi tranzaksiya", w.db.transactions.length === beforeTx, `${beforeTx} → ${w.db.transactions.length}`);
  check("kalitli: ledger ↔ hamyon mos", parity(w.db).ok, JSON.stringify(parity(w.db)));
  const tx = w.db.transactions.find((t) => t.idempotencyKey === "adminadj:panel:root:tok-1");
  check("kalitli: balanceAfter yangilangan", tx.balanceAfter === 150, tx.balanceAfter);
}

/* 2. Kalitsiz — at-least-once (cheklov) */
{
  const w = world(100);
  w.api.adminAdjust(w.u, 10, "Admin panel", "");
  w.api.adminAdjust(w.u, 10, "Admin panel", "");
  check("kalitsiz: ikki so'rov ikki marta qo'llanadi (cheklov)", w.u.credits.available === 120, w.u.credits.available);
  check("kalitsiz: 2 ta tranzaksiya", w.db.transactions.filter((t) => t.type === "admin_adjustment").length === 2);
  check("kalitsiz: ledger baribir mos", parity(w.db).ok, JSON.stringify(parity(w.db)));
}

/* 3. Manfiy qoldiq — rad etiladi, drift yo'q */
{
  const w = world(30);
  const r = w.api.adminAdjust(w.u, -50, "Admin panel", "tok-neg");
  check("manfiy: rad etildi", !r.ok && r.reason === "insufficient", JSON.stringify(r));
  check("manfiy: balans o'zgarmadi", w.u.credits.available === 30, w.u.credits.available);
  check("manfiy: tranzaksiya yozilmadi", w.db.transactions.filter((t) => t.type === "admin_adjustment").length === 0);
  check("manfiy: ledger ↔ hamyon mos (eski klamp drift bermaydi)", parity(w.db).ok, JSON.stringify(parity(w.db)));
}

/* 4. Ayirish (reversal) — izchil */
{
  const w = world(100);
  const r = w.api.adminAdjust(w.u, -40, "Reversal", "rev-1");
  check("reversal: qo'llandi", r.ok && w.u.credits.available === 60, JSON.stringify(r));
  check("reversal: tranzaksiya -40", w.db.transactions.some((t) => t.amount === -40 && t.type === "admin_adjustment"));
  check("reversal: ledger ↔ hamyon mos", parity(w.db).ok, JSON.stringify(parity(w.db)));
}

/* 5. Panel/bot kalitni uzatadi (manba tekshiruvi) */
{
  check("panel `client_token` yuboradi", /client_token: newToken\(\)/.test(fs.readFileSync("panel.html", "utf8")));
  check("server panel kalitini qabul qiladi", /adminadj:panel:/.test(src));
  check("bot buyrug'i kalitni qabul qiladi", /adminadj:tg:/.test(src));
  check("eski `Math.max(0, ... + n)` klampi admin yo'llarida qolmagan",
    !/credits\.available = Math\.max\(0, t\.credits\.available \+ n\)/.test(src));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " - " + f.name).join("\n"));
  process.exit(1);
}
