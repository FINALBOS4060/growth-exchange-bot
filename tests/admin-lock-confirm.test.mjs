// IKKI MARTA TASDIQLASH: bitta salbiy adminlik natijasi kanalni qulflamaydi.
// Haqiqiy `server.js` manbasidan `markChannelPermissionLost()` olinadi (vm).
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync("server.js", "utf8");
function cut(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`manba bo'lagi topilmadi: ${from} → ${to}`);
  return src.slice(a, b);
}
const CODE = cut("function markChannelPermissionLost(", "// Kanal huquqlarini davriy tekshirish");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
}

function makeSandbox(confirmMs) {
  const dest = { id: "ch-1", channelId: "-100123", status: "active", botHasAdminRights: true, title: "Test kanal" };
  const db = { channels: [dest], tasks: [], audit: [] };
  const sb = {
    db,
    Number,
    Math,
    Date,
    console,
    OPEN: new Set(["PENDING"]),
    CHK: { OK: "ok", NO_RIGHTS: "no_rights", NOT_FOUND: "bot_not_found", NO_BOT: "bot_not_admin" },
    ADMIN_LOCK_CONFIRM_MS: confirmMs,
    nowStr: () => "2026-11-22T00:00:00.000Z",
    auditSys: (action, id, note) => db.audit.push({ action, id, note }),
    userById: () => null,
    notifOn: () => true,
    T: () => "",
    esc: (s) => String(s),
    notify: () => {},
    save: () => {}
  };
  vm.createContext(sb);
  vm.runInContext(CODE + "\n;globalThis.__lock = markChannelPermissionLost;", sb);
  return { sb, dest, db, lock: sb.__lock };
}

const T0 = "2026-11-22T10:00:00.000Z";
const at = (sec) => new Date(Date.parse(T0) + sec * 1e3).toISOString();

/* ---------- 1. Birinchi salbiy natija — hali qulf emas ---------- */
{
  const w = makeSandbox(45e3);
  const r1 = w.lock(w.dest, "no_admin", at(0));
  check("1-natija: qulf qo'yilmadi", r1 === false && w.dest.status === "active", JSON.stringify({ r1, s: w.dest.status }));
  check("1-natija: pending belgisi yozildi", w.dest.adminLockPending && w.dest.adminLockPending.reason === "no_admin",
    JSON.stringify(w.dest.adminLockPending));
  check("1-natija: huquq holati o'zgarmadi", w.dest.botHasAdminRights === true);
  check("1-natija: audit `channel_admin_negative`",
    w.db.audit.some((a) => a.action === "channel_admin_negative" && /stage=pending/.test(a.note)),
    JSON.stringify(w.db.audit));

  const r2 = w.lock(w.dest, "no_admin", at(90));
  check("2-natija (90 s keyin): kanal qulflandi", r2 === true && w.dest.status === "permission_lost",
    JSON.stringify({ r2, s: w.dest.status }));
  check("2-natija: pending tozalandi", !w.dest.adminLockPending);
  check("2-natija: permissionLostReason saqlandi",
    w.dest.permissionLostReason === "no_admin" && !!w.dest.permissionLostCheckedAt, JSON.stringify(w.dest.permissionLostCheckedAt));
  check("2-natija: `channel_permission_lost` auditi",
    w.db.audit.some((a) => a.action === "channel_permission_lost"), JSON.stringify(w.db.audit));
}

/* ---------- 2. Oyna ichidagi ikkinchi natija ham qulf qo'ymaydi ---------- */
{
  const w = makeSandbox(45e3);
  w.lock(w.dest, "no_admin", at(0));
  const r = w.lock(w.dest, "no_admin", at(10));
  check("10 s keyingi takror: qulf yo'q", r === false && w.dest.status === "active", JSON.stringify(w.dest.status));
  check("10 s keyingi takror: checks sanaldi", (w.dest.adminLockPending || {}).checks === 2,
    JSON.stringify(w.dest.adminLockPending));
}

/* ---------- 3. Sabab o'zgarsa — yangi tasdiqlash oynasi ---------- */
{
  const w = makeSandbox(45e3);
  w.lock(w.dest, "no_admin", at(0));
  const r = w.lock(w.dest, "bot_not_found", at(120));
  check("sabab o'zgardi: yana pending (tasdiq kerak)", r === false && w.dest.status === "active",
    JSON.stringify({ r, pending: w.dest.adminLockPending }));
}

/* ---------- 4. ADMIN_LOCK_CONFIRM_SEC=0 → eski xatti-harakat ---------- */
{
  const w = makeSandbox(0);
  const r = w.lock(w.dest, "no_admin", at(0));
  check("confirm=0: bitta natija bilan qulf", r === true && w.dest.status === "permission_lost",
    JSON.stringify({ r, s: w.dest.status }));
  check("confirm=0: pending qolmadi", !w.dest.adminLockPending);
}

/* ---------- 5. Ochiq vazifalar bekor qilinadi ---------- */
{
  const w = makeSandbox(0);
  w.db.tasks.push({ id: "t1", destinationId: "ch-1", status: "PENDING" });
  w.db.tasks.push({ id: "t2", destinationId: "ch-2", status: "PENDING" });
  w.lock(w.dest, "no_admin", at(0));
  check("qulfda kanal vazifalari CANCELLED", w.db.tasks[0].status === "CANCELLED" && w.db.tasks[1].status === "PENDING",
    JSON.stringify(w.db.tasks.map((t) => t.status)));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed ? 1 : 0);
