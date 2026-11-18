// Panel «Operatsiyalar» bo'limi: terminaldan qilinadigan texnik ishlar
// (navbat, TASK_CHECK tiklanishi, admin sweep, soatlik hisobot, ledger audit)
// va eksport xavfsizligi (tokenlar/parol xeshlari chiqmasligi).
//
// 1. Server: `ops` route + ruxsat xaritasi + HAQIQIY funksiyalarga ulanish.
// 2. `sanitizeForExport()` HAQIQIY kodi vm orqali tekshiriladi.
// 3. Ops bloki balans/jurnalga tegmasligi (statik).
// 4. Panel: tab, tugmalar va handlerlar.
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync("server.js", "utf8");
const panel = fs.readFileSync("panel.html", "utf8");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
}
function cut(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`manba bo'lagi topilmadi: ${from} → ${to}`);
  return src.slice(a, b);
}

const opsStart = src.indexOf('case "ops": {');
const opsEnd = src.indexOf('case "backup": {', opsStart);
const ops = opsStart >= 0 && opsEnd > opsStart ? src.slice(opsStart, opsEnd) : "";

/* 1. Route va ruxsatlar */
check("`ops` route mavjud", ops.length > 0);
check("`ops` ruxsati `health` ga bog'langan", /ops: "health"/.test(src));
check("`ops` GET holat qaytaradi", /polling: botsList\(\)\.map/.test(ops) && /jobs: opsJobStats\(\)/.test(ops));
check("`ops` hamyonlar hisobini ko'rsatadi", /ledgerReport\(\)/.test(ops));

/* 2. Amallar HAQIQIY funksiyalarni chaqiradi */
check("`run_jobs` → processVerificationJobs()", /await processVerificationJobs\(limit\)/.test(ops));
check("`run_jobs` limitni cheklaydi", /Math\.min\(500, Math\.max\(1,/.test(ops));
check("`repair_task_checks` → repairTaskChecks()", /await withStateTx\(async \(\) => repairTaskChecks\(\)\)/.test(ops));
check("`repair_task_checks` yozuvni KUTADI", /const saved = await flushSaveAwaited\(\);/.test(ops));
check("`repair_task_checks` saqlamasa xato beradi", /if \(!saved\) throw new Error/.test(ops));
check("`sweep` → channelHealthSweep()", /await channelHealthSweep\(\{ force, channelId \}\)/.test(ops));
check("`sweep` majburiy rejimni uzatadi", /const force = !!b\.force;/.test(ops) && /const n = await channelHealthSweep\(\{ force, channelId \}\)/.test(ops));
check("`hourly` → hourlyReport()", /await hourlyReport\(\)/.test(ops));
check("`ledger` faqat o'qish", /if \(action === "ledger"\) return \{ ledger: ledgerReport\(\) \};/.test(ops));

/* 3. Ops hech qanday pul amalini bajarmaydi */
check("ops: addTx chaqirilmaydi", !/addTx\(/.test(ops));
check("ops: adminAdjust/applyVerified chaqirilmaydi", !/adminAdjust\(|applyVerified\(/.test(ops));
check("ops: `credits.` mutatsiyasi yo'q", !/credits\.\w+\s*[-+*/]?=(?!=)/.test(ops));
check("ops: tranzaksiya yozilmaydi", !/transactions\.push\(/.test(ops));
check("ops: `flushSave()` (kutmaydigan) ishlatilmaydi", !/(^|[^d])flushSave\(\)/.test(ops));

/* 4. sanitizeForExport — HAQIQIY kod */
const code = cut("function sanitizeForExport(", "function opsJobStats(");
const ctx = vm.createContext({ console });
vm.runInContext(code + "\n;globalThis.__sanitize = sanitizeForExport;", ctx);
const raw = {
  users: { 1: { id: "u-1", credits: { available: 5, reserved: 0, spent: 0 } } },
  orders: [{ id: "o-1" }],
  transactions: [{ id: "t-1", amount: 5 }],
  settings: {
    telegramBotToken: "8716237015:AAF-secret",
    bots: [{ id: "bot-main", token: "123:AAA", role: "main" }, { id: "bot-w", token: "456:BBB", role: "worker" }],
    news: { apiKey: "gemini-secret", channel: "@x" },
    creditRewardReferral: 300
  },
  adminUsers: [{ id: "a-1", username: "root", passHash: "salt:hash", role: "owner" }]
};
const before = JSON.stringify(raw);
const { state, removed } = ctx.__sanitize(raw);
check("sanitize: bot tokeni olib tashlandi", state.settings.telegramBotToken === "");
check("sanitize: ishchi bot tokenlari olib tashlandi", state.settings.bots.every((b) => b.token === ""));
check("sanitize: Gemini kaliti olib tashlandi", state.settings.news.apiKey === "");
check("sanitize: parol xeshi olib tashlandi", !("passHash" in state.adminUsers[0]));
check("sanitize: admin username/rol saqlanadi", state.adminUsers[0].username === "root" && state.adminUsers[0].role === "owner");
check("sanitize: biznes maydonlari saqlanadi", state.settings.creditRewardReferral === 300);
check("sanitize: foydalanuvchi/buyurtma/jurnal nusxasi saqlanadi",
  state.users["1"].credits.available === 5 && state.orders.length === 1 && state.transactions.length === 1);
check("sanitize: olib tashlanganlar ro'yxati", removed.includes("settings.telegramBotToken") &&
  removed.includes("settings.bots[].token") && removed.includes("settings.news.apiKey") &&
  removed.includes("adminUsers[].passHash"));
check("sanitize: asl obyekt o'zgarmaydi", JSON.stringify(raw) === before);

/* 5. Eksport tozalangan nusxani beradi */
check("export: sanitizeForExport ishlatiladi", /case "export": \{[\s\S]*?sanitizeForExport\(db\)/.test(src));
check("export: audit yozuvi `export_sanitized`", /audit\(req, "export_sanitized"/.test(src));
check("export: xom `state: db` qolmagan", !/return \{ at: nowStr\(\), state: db \};/.test(src));

/* 6. Panel */
check("panel: nav tugmasi", /<button data-tab="ops">/.test(panel));
check("panel: tab bo'limi", /id="tab-ops"/.test(panel));
for (const a of ["run_jobs", "repair_task_checks", "sweep", "hourly", "ledger"]) {
  check(`panel: amal tugmasi ${a}`, panel.includes(`data-ops="${a}"`));
}
check("panel: loadOps ro'yxatga ulangan", /ops: loadOps/.test(panel));
check("panel: handler POST yuboradi", /api\('\/api\/admin\/ops', force \?/.test(panel));
check("panel: majburiy tekshirish tugmasi", /data-ops="sweep_force"/.test(panel) && /force \? \{ action: 'sweep', force: true \}/.test(panel));
check("panel: `ops` ruxsati `health`", /ops: 'health'/.test(panel));
check("panel: bot qulfi ko'rsatiladi", /b\.pollLock/.test(panel));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " - " + f.name).join("\n"));
  process.exit(1);
}
