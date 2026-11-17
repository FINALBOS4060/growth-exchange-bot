// Crash-safety: `addTx()` + `save()` mexanizmi va `applyVerified()` atomarligi.
//
// Bu test HAQIQIY `server.js` manbasidan funksiyalarni oladi (vm):
//   calculateRefundAmount · addTx · applyVerified · saveNow · save · flushSave
// Tashqi dunyo (Telegram, notify, id generator) stub, lekin FAYL yozish —
// haqiqiy `fs` (tmp + rename), `setTimeout` esa boshqariladigan (qo'lda
// "otiladigan") taymer.
//
// Tekshiriladi:
//  1. Operatsiya ichida `save()` chaqirilmaydi (sinxron, atomar) — taymer
//     o'rtada otilmaydi.
//  2. Har bir crash nuqtasida qayta ishga tushirilgan holat izchil: drift yo'q.
//  3. Crash nuqtalari orasida "agar shu holat saqlanib qolsa" drift qayerda
//     paydo bo'lishi ko'rsatiladi (nega o'rtada saqlash taqiqlangani).
//  4. To'liq operatsiya + `save()` dan keyingi qayta ishga tushirish: barcha
//     qiymatlar joyida va qayta tasdiqlash mukofotni takrorlamaydi.
//  5. Fayl yozish yarim yo'lda yiqilsa — asosiy fayl buzilmaydi (tmp+rename).
//  6. `flushSave()` yozuvni darhol va atomar qiladi (debounce oynasi yopiladi).
import fs from "node:fs";
import os from "node:os";
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
const note = (msg) => console.log(`NOTE  ${msg}`);

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gxb-crash-"));
const DBFILE = path.join(tmpdir, "db.json");

const ORDER = (over = {}) => ({
  id: "ord-1", userId: "u-1", destinationId: "ch-1", destinationTitle: "Alpha",
  platform: "telegram", requestedQuantity: 3, verifiedQuantity: 0, pendingQuantity: 3,
  cancelledQuantity: 0, unitCost: 10, totalCost: 30, freeUnits: 0, status: "active", seq: 1, ...over
});
const TASK = (id, over = {}) => ({
  id, assignedTo: "u-1", orderId: "ord-1", destinationId: "ch-1", destinationTitle: "Alpha",
  platform: "telegram", status: "PENDING", rewardCredits: 100, queueSequence: 1, ...over
});

function seedDb() {
  return {
    seq: 10,
    users: {
      1: {
        id: "u-1", telegramId: 1, displayName: "U1",
        credits: { available: 0, reserved: 30, spent: 0, verifiedRewards: 0, selfReportedRewards: 0, refunded: 0 },
        completedTasksCount: 0, activeOrdersCount: 1
      }
    },
    channels: [{ id: "ch-1", channelId: "-1001", title: "Alpha", verifiedSubscribers: 0, activeSubscribers: 0, pendingSubscriptions: 3 }],
    igProfiles: [],
    orders: [ORDER()],
    tasks: [TASK("t-1"), TASK("t-2", { queueSequence: 2 }), TASK("t-3", { queueSequence: 3 })],
    transactions: [
      { id: "tx-seed", userId: "u-1", amount: 30, type: "reward_task", idempotencyKey: "seed:reward" },
      { id: "tx-res", userId: "u-1", amount: -30, type: "order_spend", orderId: "ord-1", idempotencyKey: "reserve:ord-1" }
    ],
    memberships: [], membershipEvents: [], verificationJobs: [], verifyLog: [], referrals: [],
    settings: { creditRewardInstagramSelfConfirmed: 0 }
  };
}

// Bitta "jarayon": db, boshqariladigan taymer, haqiqiy fayl saqlash.
function boot(initialDb = seedDb()) {
  const db = initialDb;
  const timers = [];
  const log = { saveCalls: 0, pointSaves: [] };
  const sandbox = {
    db,
    DATA_FILE: DBFILE,
    dbPool: null,
    CURRENT_OP: "",
    persistNow: async () => true,
    // Sandbox: fayl rejimi — instanslararo qulf yo'q, tranzaksiya darhol bajariladi.
    withStateTx: async (fn) => ({ ok: true, value: await fn() }),
    withSaveLock: async (fn) => fn(),
    saveTimer: null,
    fs,
    path,
    persist: async () => {},
    setTimeout: (fn, ms) => { const t = { fn, ms, alive: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t && typeof t === "object") t.alive = false; },
    S: () => db.settings,
    nid: (p) => `${p}-${Math.floor(Math.random() * 1e6)}`,
    nowStr: () => new Date().toISOString(),
    userById: (id) => db.users[id] || Object.values(db.users).find((u) => u.id === id) || null,
    notifOn: () => true,
    notify: () => {},
    esc: (s) => String(s == null ? "" : s),
    send: () => {},
    T: (u, k) => k, TR: (u, k) => k, TRV: (u, k) => k,
    menuFor: () => null, balanceLine: () => "",
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    CODE + "\n;globalThis.__api = { applyVerified, addTx, cancelOrder, save, flushSave, saveNow };",
    ctx
  );
  const api = ctx.__api;
  sandbox.ctx = ctx;
  // `save()` chaqiruvlarini sanaymiz (haqiqiy funksiya ustidan o'ramcha).
  const realSave = api.save;
  api.save = () => { log.saveCalls++; return realSave(); };
  const fireTimers = () => {
    for (const t of timers.splice(0)) if (t.alive) t.fn();
  };
  return { db, api, ctx, sandbox, timers, fireTimers, log };
}

const ledgerOf = (db, userId = "u-1") => {
  const u = Object.values(db.users).find((x) => x.id === userId);
  const led = runtimeLedger(db.transactions.filter((t) => t.userId === userId), u.credits.spent);
  return {
    led,
    wallet: { available: u.credits.available, reserved: u.credits.reserved, spent: u.credits.spent },
    drift: u.credits.available - led.available,
    reservedDrift: u.credits.reserved - led.reserved
  };
};
const consistent = (db) => {
  const l = ledgerOf(db);
  const t = db.tasks.find((x) => x.id === "t-1");
  const o = db.orders.find((x) => x.id === "ord-1");
  const tx = db.transactions.filter((x) => x.idempotencyKey === "reward:t-1");
  return {
    ok: Math.abs(l.drift) < 1e-9 && Math.abs(l.reservedDrift) < 1e-9,
    l, t, o,
    tx: tx.length,
    // Holat va jurnal mos: VERIFIED bo'lsa aynan 1 ta reward yozuvi bo'lishi shart.
    statusLedgerOk: (t.status === "VERIFIED") === (tx.length === 1)
  };
};
const durable = () => JSON.parse(fs.readFileSync(DBFILE, "utf8"));
const writeDurable = (db) => fs.writeFileSync(DBFILE, JSON.stringify(db));

/* ═══ 1. Operatsiya ichida save() yo'q ═══ */
{
  const w = boot();
  const body = cut("function applyVerified(", "async function qualifyReferralCore(");
  check("applyVerified ichida `await` yo'q (sinxron)", !/\bawait\b/.test(body));
  check("applyVerified ichida `save(` chaqirilmaydi", !/\bsave\(\)/.test(body));
  w.api.applyVerified(w.db.users[1], w.db.tasks[0]);
  check("operatsiya davomida save() chaqirilmadi", w.log.saveCalls === 0, `saveCalls=${w.log.saveCalls}`);
  check("debounce taymeri ham otilmadi (o'rtada saqlash yo'q)", w.timers.length === 0, `timers=${w.timers.length}`);
}

/* ═══ 2. Har bir crash nuqtasida qayta ishga tushirish izchil ═══ */
{
  // Nuqtalarni yozib boruvchi o'ramchalar: har bir mutatsiyadan keyin holat.
  const w = boot();
  writeDurable(seedDb()); // durable = operatsiyadan oldingi holat
  const db = w.db;
  const points = [];
  const snapshot = (label) => {
    const s = consistent(db);
    points.push({
      label,
      s: { ok: s.ok, drift: s.l.drift, reservedDrift: s.l.reservedDrift, status: s.t.status, vq: s.o.verifiedQuantity, tx: s.tx }
    });
  };
  // 1) addTx dan keyin — GLOBAL `addTx` o'raladi (funksiya ichida o'sha nom
  //    ishlatiladi, shuning uchun api nusxasini almashtirish yetarli emas).
  w.sandbox.__onAddTx = () => snapshot("addTx (jurnal yozildi)");
  vm.runInContext(
    "globalThis.__realAddTx = addTx; globalThis.addTx = function (...a) { const r = __realAddTx(...a); __onAddTx(); return r; };",
    w.ctx
  );
  // 2–5) maydon mutatsiyalari (proxy orqali)
  const track = (obj, label) => new Proxy(obj, {
    set(target, key, value) {
      const r = Reflect.set(target, key, value);
      snapshot(`${label}.${String(key)}`);
      return r;
    }
  });
  db.users[1].credits = track(db.users[1].credits, "credits");
  db.tasks[0] = track(db.tasks[0], "task");
  db.orders[0] = track(db.orders[0], "order");
  db.channels[0] = track(db.channels[0], "channel");

  w.api.applyVerified(db.users[1], db.tasks[0]);

  const labels = points.map((p) => p.label);
  check("crash nuqtalari qayd etildi (≥5 ta)", points.length >= 5, labels.join(" | "));
  for (const need of ["addTx", "credits.available", "credits.reserved", "task.status", "order.verifiedQuantity"]) {
    check(`nuqta mavjud: ${need}`, labels.some((l) => l.startsWith(need)), labels.join(" | "));
  }

  // Har bir nuqta uchun: qayta ishga tushirish = durable fayldan yuklash.
  const pre = durable();
  check("durable holat operatsiyadan oldingi (crash oldin saqlanmagan)", pre.users[1].credits.available === 0);
  for (const p of points) {
    const rest = consistent(pre);
    check(`crash@${p.label}: qayta ishga tushirish izchil (drift 0)`,
      rest.ok && rest.statusLedgerOk && rest.t.status === "PENDING" && rest.tx === 0,
      JSON.stringify({ drift: rest.l.drift, reserved: rest.l.reservedDrift, status: rest.t.status, tx: rest.tx }));
  }
  // Ma'lumot uchun: o'sha lahzadagi xotira holati saqlanib qolsa, drift qayerda.
  const drifting = points.filter((p) => !p.s.ok).map((p) => `${p.label} (available drift ${p.s.drift})`);
  note(`agar o'rtada saqlansa drift bo'lardi: ${drifting.length ? drifting.join(", ") : "yo'q"}`);
  check("o'rtadagi holatlarning bir qismi haqiqatan nomuvofiq (saqlash taqiqlangani sababli)",
    drifting.length > 0, drifting.join(", "));
}

/* ═══ 3. To'liq operatsiya + save → restart ═══ */
{
  const w = boot();
  writeDurable(seedDb());
  w.api.applyVerified(w.db.users[1], w.db.tasks[0]);
  w.api.save();
  w.fireTimers(); // debounce 500 ms o'tdi
  const onDisk = durable();
  const s = consistent(onDisk);
  check("save() dan keyin fayl yozildi", s.t.status === "VERIFIED", s.t.status);
  check("restart: available = 100", onDisk.users[1].credits.available === 100, onDisk.users[1].credits.available);
  check("restart: reserved = 20", onDisk.users[1].credits.reserved === 20, onDisk.users[1].credits.reserved);
  check("restart: spent = 10", onDisk.users[1].credits.spent === 10, onDisk.users[1].credits.spent);
  check("restart: verifiedQuantity = 1", s.o.verifiedQuantity === 1, s.o.verifiedQuantity);
  check("restart: reward:t-1 aynan 1 ta", s.tx === 1, s.tx);
  check("restart: ledger ↔ hamyon mos (drift 0)", s.ok && Math.abs(s.l.drift) < 1e-9, JSON.stringify(s.l));

  // Qayta ishga tushgan jarayon o'sha vazifani yana tasdiqlasa — mukofot yo'q.
  const fresh = boot(durable()); // restart: holat fayldan yuklandi
  const before = JSON.stringify(fresh.db.users[1].credits);
  const res = fresh.api.applyVerified(fresh.db.users[1], fresh.db.tasks[0]);
  check("restartdan keyin qayta tasdiqlash 0 qaytardi", res === 0, res);
  check("restartdan keyin balans o'zgarmadi", JSON.stringify(fresh.db.users[1].credits) === before);
  check("restartdan keyin tranzaksiya takrorlanmadi",
    fresh.db.transactions.filter((t) => t.idempotencyKey === "reward:t-1").length === 1);
}

/* ═══ 4. Fayl yozish yarim yo'lda yiqilsa ═══ */
{
  const w = boot();
  writeDurable(seedDb());
  const good = fs.readFileSync(DBFILE, "utf8");
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...rest) => {
    if (String(file).endsWith(".tmp")) {
      realWrite(file, String(data).slice(0, 20)); // yarim yozildi
      throw new Error("disk to'ldi");
    }
    return realWrite(file, data, ...rest);
  };
  w.api.applyVerified(w.db.users[1], w.db.tasks[0]);
  w.api.save();
  w.fireTimers();
  fs.writeFileSync = realWrite;
  const after = fs.readFileSync(DBFILE, "utf8");
  check("yarim yozilgan tmp asosiy faylni buzmaydi", after === good);
  check("asosiy fayl hali ham yaroqli JSON", (() => { try { JSON.parse(after); return true; } catch { return false; } })());
  // Eslatma: bu holatda operatsiya faylga tushmadi, lekin xotirada qoladi va
  // keyingi save() uni qayta yozadi — drift paydo bo'lmaydi.
  const s = consistent(w.db);
  check("yarim yozuvdan keyin xotira izchil", s.ok, JSON.stringify(s.l));
}

/* ═══ 5. flushSave: darhol va atomar ═══ */
{
  const w = boot();
  writeDurable(seedDb());
  w.api.applyVerified(w.db.users[1], w.db.tasks[0]);
  check("flushSave oldin fayl hali eski", durable().users[1].credits.available === 0);
  w.api.flushSave();
  const d = durable();
  const s = consistent(d);
  check("flushSave darhol yozdi", d.users[1].credits.available === 100 && s.t.status === "VERIFIED");
  check("flushSave natijasi izchil", s.ok && s.tx === 1, JSON.stringify(s.l));
  check("flushSave qolgan debounce taymerini tozaladi", w.timers.every((t) => !t.alive));
}

/* ═══ 6. Debounce oynasi: crash → tugallangan operatsiya yo'qoladi ═══ */
{
  const w = boot();
  writeDurable(seedDb());
  w.api.applyVerified(w.db.users[1], w.db.tasks[0]); // foydalanuvchiga "+100" ko'rsatildi
  // 500 ms tugamasdan jarayon o'ldi (timer otilmadi)
  const d = durable();
  const s = consistent(d);
  check("debounce oynasida crash: drift yo'q", s.ok, JSON.stringify(s.l));
  check("debounce oynasida crash: operatsiya saqlanmagan (yozuv yo'q)", s.tx === 0 && s.t.status === "PENDING");
  note("bu holat drift emas, lekin DURABILITY oynasi: xabar yuborilgandan keyin 500 ms ichida crash bo'lsa, tasdiqlangan operatsiya yo'qoladi");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
fs.rmSync(tmpdir, { recursive: true, force: true });
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " - " + f.name).join("\n"));
  process.exit(1);
}
