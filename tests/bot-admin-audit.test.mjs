// P1 (freshness, auditi) + P2 (panel STALE) — HAQIQIY `server.js` manbasidan
// olingan funksiyalar bilan (vm), tashqi dunyo stub.
//
//  1. 60 s dan eski natija `durableNeg` qaroriga kirmaydi.
//  2. Yangi natijalar avvalgidek ishlaydi (#10 qoidasi saqlanadi).
//  3. Eski VERIFIED_ADMIN "ok" hisoblanmaydi; vaqtsiz natija ishonchsiz.
//  4. `botAdminSummary` eskirgan natijani `adminStale` deb belgilaydi va
//     `checkedAt` ni qaytaradi.
//  5. Statik audit: sweep alohida advisory qulf ostida; permission-lost
//     auditida reason + checkedAt; panelda STALE va tekshirilgan vaqt.
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync("server.js", "utf8");
function cut(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`manba bo'lagi topilmadi: ${from} → ${to}`);
  return src.slice(a, b);
}

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
}

const CODE = [
  cut("var CHK = {", "// Telegram xatosini"),
  cut("var BOT_ADMIN_MAX_AGE_MS", "// «BITTA BOT YETARLI»"),
  cut("function pickAdminBot(", "// Kanalni qo'shayotgan"),
  cut("function botAdminSummary(", "function botView(")
].join("\n");

const sandbox = {
  Date,
  Number,
  console,
  CH_ADMIN_SWEEP_HOURS: 6,
  curBot: () => ({ id: "bot-main" }),
  db: { channels: [] }
};
vm.createContext(sandbox);
vm.runInContext(CODE + "\n;globalThis.__api = { botAdminVerdict, pickAdminBot, botAdminSummary, CHK, BOT_ADMIN_MAX_AGE_MS };", sandbox);
const { botAdminVerdict, botAdminSummary, CHK, BOT_ADMIN_MAX_AGE_MS } = sandbox.__api;

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const res = (botDbId, status, opts = {}) => ({
  botDbId,
  botLabel: "@" + botDbId,
  botId: 777000,
  role: botDbId === "bot-main" ? "main" : "worker",
  status,
  ok: opts.ok !== void 0 ? opts.ok : ["ok", "missing_permissions"].includes(status),
  limited: status === "missing_permissions",
  transient: !!opts.transient,
  checkedAt: opts.at || new Date(NOW).toISOString()
});
const old = new Date(NOW - 120_000).toISOString();
const fresh = new Date(NOW - 5_000).toISOString();
// Panel STALE chegarasi — 2 ta sweep oynasi (12 soat).
const oldLong = new Date(Date.now() - 13 * 3600e3).toISOString();

/* ---------- 1. Freshness guard ---------- */
check("default maxAge 60 s", BOT_ADMIN_MAX_AGE_MS === 60_000, String(BOT_ADMIN_MAX_AGE_MS));

const v1 = botAdminVerdict([
  res("bot-main", "api_error", { transient: true, at: fresh }),
  res("bot-worker1", "bot_not_admin", { at: old })
], { now: NOW });
check("eski NOT_ADMIN durableNeg qaroriga kirmaydi", v1.durableNeg === false, JSON.stringify(v1));
check("eski natija `stale` deb sanaldi", v1.stale === 1, String(v1.stale));
check("faqat yangi natijalar `fresh` ro'yxatida", (v1.fresh || []).length === 1, String((v1.fresh || []).length));

const v2 = botAdminVerdict([
  res("bot-main", "api_error", { transient: true, at: fresh }),
  res("bot-worker1", "bot_not_admin", { at: fresh })
], { now: NOW });
check("yangi NOT_ADMIN + API_ERROR → durableNeg (mavjud #10 qoidasi)", v2.durableNeg === true, JSON.stringify(v2));

const v3 = botAdminVerdict([res("bot-main", "ok", { at: old })], { now: NOW });
check("eski VERIFIED_ADMIN ok hisoblanmaydi", v3.ok === false && v3.bot === null, JSON.stringify(v3));

const v4 = botAdminVerdict([res("bot-main", "ok", { at: fresh })], { now: NOW });
check("yangi VERIFIED_ADMIN ok", v4.ok === true && !!v4.bot && v4.bot.botDbId === "bot-main", JSON.stringify(v4));

const noTs = res("bot-main", "ok");
delete noTs.checkedAt;
const v5 = botAdminVerdict([noTs], { now: NOW });
check("checkedAt yo'q natija ishonchsiz (stale)", v5.ok === false && v5.stale === 1, JSON.stringify(v5));

const v6 = botAdminVerdict([res("bot-main", "bot_not_admin", { at: old })], { now: NOW, maxAgeMs: 180_000 });
check("maxAgeMs sozlanadi (180 s → natija yangi)", v6.durableNeg === true, JSON.stringify(v6));

/* ---------- 2. Panel: checkedAt + STALE ---------- */
sandbox.db.channels = [{
  id: "ch-1",
  botAdmins: {
    "bot-main": { status: "ok", ok: true, checkedAt: oldLong },
    "bot-worker1": { status: "bot_not_admin", ok: false, checkedAt: fresh }
  }
}];
const sum = botAdminSummary("bot-main");
check("panel: adminLastCheckAt qaytadi", sum.adminLastCheckAt === oldLong, sum.adminLastCheckAt);
check("panel: 12 soatdan eski natija → adminStale", sum.adminStale === true, JSON.stringify(sum));
check("panel: adminChannels sanaldi", sum.adminChannels === 1 && sum.adminCheckedChannels === 1, JSON.stringify(sum));

sandbox.db.channels = [{ id: "ch-2", botAdmins: { "bot-main": { status: "ok", ok: true, checkedAt: fresh } } }];
check("panel: yangi natija STALE emas", botAdminSummary("bot-main").adminStale === false);
sandbox.db.channels = [{ id: "ch-3", botAdmins: {} }];
const empty = botAdminSummary("bot-main");
check("panel: tekshirilmagan bot STALE emas", empty.adminCheckedChannels === 0 && empty.adminStale === false, JSON.stringify(empty));

/* ---------- 3. Statik audit ---------- */
const sweep = cut("async function channelHealthSweep(", "async function maintenance(");
check("sweep alohida `sweep` qulfini oladi", /tryLock\("sweep"\)/.test(sweep));
check("sweep qulfni finally da bo'shatadi", /finally\s*\{[\s\S]*releaseLock\("sweep"\)/.test(sweep));
check("sweep fresh verdictdan foydalanadi", /botAdminVerdict\(bots\)/.test(sweep) && /verdict\.bot/.test(sweep));
check("sweep: invalid_token holati yoziladi", /CHK\.TOKEN/.test(sweep));

const lost = cut("function markChannelPermissionLost(", "// Kanal huquqlarini davriy tekshirish");
check("permission-lost: reason saqlanadi", /permissionLostReason/.test(lost));
check("permission-lost: checkedAt saqlanadi", /permissionLostCheckedAt/.test(lost));
check("permission-lost: audit yozuvi", /auditSys\("channel_permission_lost"/.test(lost));

const order = cut("async function createOrderConfirmedInner(", "async function cancelOrder(");
check("order: fresh verdictdan foydalanadi", /botAdminVerdict\(perms\)/.test(order) && /verdict\.bot/.test(order));
check("order: invalid_token texnik sabab bilan bloklanadi", /CHK\.TOKEN/.test(order) && /ch_err_api/.test(order));
check("order: permission_lost FAQAT durableNeg da", /else if \(verdict\.durableNeg\)/.test(order));

const panel = fs.readFileSync("panel.html", "utf8");
check("panel: STALE belgisi", /STALE/.test(panel));
check("panel: tekshirilgan vaqt ko'rsatiladi", /tekshirildi:/.test(panel));
check("panel: adminStale maydonidan foydalanadi", /b\.adminStale/.test(panel));

const del = cut('if (action === "delete") {', 'if (action === "restart") {');
check("bot o'chirilganda snapshot tozalanadi", /delete c\.botAdmins\[bot\.id\]/.test(del));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed ? 1 : 0);
