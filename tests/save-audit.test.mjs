// Async saqlash zanjiri auditi (statik): pul amallari HAQIQIY yozuvni kutadimi?
//
// `await` ni sinxron bo'lmagan funksiyada ishlatib bo'lmaydi — Node sintaksis
// xatosi beradi, shuning uchun fayl parse bo'lishi o'zi "await faqat async
// funksiyada" kafolatini beradi. Bu test qolgan qismini tekshiradi:
//   1. Money funksiyalar `async` va yozuvni await qiladi.
//   2. `flushOrRollback()` har bir chaqiruvi `await` bilan.
//   3. `flushSave()` (natijani kutmaydigan sinxron variant) faqat login
//      guard'ida qoladi — pul yo'lida ishlatilmaydi.
//   4. `persist()` xatoni yutmaydi (rejection handler `false` qaytaradi).
//   5. verifyBatch / runTaskCheckJob saqlash yiqilganda rollback qiladi.
import fs from "node:fs";

const src = fs.readFileSync("server.js", "utf8");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}

// Top-level funksiya tanasi (keyingi top-level `function`/`async function` gacha).
function body(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const after = src.indexOf("\nfunction ", start + 1);
  const afterAsync = src.indexOf("\nasync function ", start + 1);
  const ends = [after, afterAsync].filter((x) => x > 0);
  const end = ends.length ? Math.min(...ends) : src.length;
  return src.slice(start, end);
}
function isAsync(name) {
  return new RegExp(`async function ${name}\\(`).test(src);
}
const lines = src.split("\n");
const offsets = [];
for (let i = 0, off = 0; i < lines.length; i++) {
  offsets.push(off);
  off += lines[i].length + 1;
}
const isComment = (l) => /^\s*\/\//.test(l);
function rangeOf(name) {
  const s = src.indexOf(`function ${name}(`);
  return [s, s + body(name).length];
}

/* 1. Money funksiyalar async */
const MONEY = [
  "applyAdminAdjust",
  "grantSignupBonus",
  "grantChannelLinkBonus",
  "tryQualifyReferral",
  "cancelOrder",
  "cancelOrderAdmin",
  "createOrderConfirmed",
  "verifyBatch",
  "runTaskCheckJob"
];
for (const f of MONEY) check(`async: ${f}()`, isAsync(f));
check("async: flushOrRollback()", isAsync("flushOrRollback"));
check("async: flushSaveAwaited()", isAsync("flushSaveAwaited"));
check("sync: applyVerified() (atayin sinxron, await yo'q)",
  !isAsync("applyVerified") && !/\bawait\b/.test(body("applyVerified")));

/* 2. flushOrRollback chaqiruvlari await bilan */
const froCalls = lines
  .map((l, i) => ({ l, i }))
  .filter((x) => x.l.includes("flushOrRollback(") && !/async function flushOrRollback/.test(x.l) && !isComment(x.l));
const notAwaited = froCalls.filter((x) => !/await\s+flushOrRollback\(/.test(x.l) && !/!\(await\s+flushOrRollback\(/.test(x.l));
check("flushOrRollback: barcha chaqiruvlar await bilan", notAwaited.length === 0,
  JSON.stringify(notAwaited.map((x) => `${x.i + 1}: ${x.l.trim()}`)));
check("flushOrRollback: kamida 6 chaqiruv joyi", froCalls.length >= 6, String(froCalls.length));

/* 3. flushSaveAwaited chaqiruvlari await bilan */
const fsaCalls = lines
  .map((l, i) => ({ l, i }))
  .filter((x) => x.l.includes("flushSaveAwaited(") && !/async function flushSaveAwaited/.test(x.l) && !/return persist\(\)/.test(x.l) && !isComment(x.l));
const fsaBad = fsaCalls.filter((x) => !/await\s+flushSaveAwaited\(/.test(x.l));
check("flushSaveAwaited: barcha chaqiruvlar await bilan", fsaBad.length === 0,
  JSON.stringify(fsaBad.map((x) => `${x.i + 1}: ${x.l.trim()}`)));

/* 4. Sinxron flushSave() faqat login guard'ida */
const syncCalls = lines
  .map((l, i) => ({ l, i }))
  .filter((x) => /(^|[^d])flushSave\(\)/.test(x.l) && !/function flushSave\(\)/.test(x.l) && !isComment(x.l));
const loginRanges = [rangeOf("loginFail"), rangeOf("loginOk")];
const allowed = (idx) => loginRanges.some(([a, b]) => offsets[idx] >= a && offsets[idx] < b);
const badSync = syncCalls.filter((x) => !allowed(x.i));
check("flushSave(): pul yo'lida ishlatilmaydi (faqat login guard)", badSync.length === 0,
  JSON.stringify(badSync.map((x) => `${x.i + 1}: ${x.l.trim()}`)));
for (const f of MONEY) check(`flushSave() yo'q: ${f}()`, !/flushSave\(\)/.test(body(f)));

/* 5. persist() xatoni yutmaydi */
const pBody = body("persistNow");
check("persistNow(): xato yutilmaydi (rad etish false qaytaradi)", /\(e\) => \{/.test(pBody) && /"Postgres saqlash xatosi:"/.test(pBody) && /return false;/.test(pBody));
check("persist(): zanjir rad etilmaydi (dbChain)", /dbChain = p\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(pBody));
check("persist(): eski `.catch` yutilishi yo'q", !/\.catch\(\(e\) => \{\s*console\.error\("Postgres saqlash xatosi/.test(pBody));

/* 6. flushSaveAwaited PG'da persist natijasini qaytaradi */
const fsaBody = body("flushSaveAwaited");
check("flushSaveAwaited(): dbPool bo'lsa holat tranzaksiyasi orqali", /if \(!dbPool\) return saveNow\(\);/.test(fsaBody) && /withStateTx\(\(\) => persistNow\(\)\)/.test(fsaBody));
check("flushSaveAwaited(): qulfni qayta olmaydi (persist emas)", !/return persist\(\)/.test(fsaBody));

/* 5b. Pul yozuvlari va rollback — bitta qulf ostida */
check("withSaveLock mavjud", /var SAVE_LOCK = Promise\.resolve\(\);/.test(src) && /async function withSaveLock\(fn\)/.test(src));
check("persist() holat tranzaksiyasi orqali", /function persist\(\) \{\s*\n?\s+return withStateTx\(async \(\) => persistNow\(\)\)/.test(src));
check("flushOrRollback: saqlash+rollback qulf ichida",
  /return withSaveLock\(async \(\) => \{/.test(body("flushOrRollback")) && /if \(await flushSaveAwaited\(\)\) return true;/.test(body("flushOrRollback")));

/* 7. verifyBatch / runTaskCheckJob rollback */
const vBody = body("verifyBatch");
check("verifyBatch: snapshot oladi", /verifyRollbackSnapshot\(u, batch, opV\)/.test(vBody));
check("verifyBatch: await flushSaveAwaited()", /await flushSaveAwaited\(\)/.test(vBody));
check("verifyBatch: yiqilganda verifyRollbackApply", /verifyRollbackApply\(snapV, u\)/.test(vBody));
check("verifyBatch: referal bildirishnomasi kechiktirilgan (noSave)", /tryQualifyReferral\(u, \{ defer: refNotices, noSave: true \}\)/.test(vBody));
check("verifyBatch: muvaffaqiyatdan keyin notices", /for \(const n of refNotices\) n\(\);/.test(vBody));

const jBody = body("runTaskCheckJob");
check("runTaskCheckJob: snapshot oladi", /verifyRollbackSnapshot\(u, \[t\]\)/.test(jBody));
check("runTaskCheckJob: await flushSaveAwaited()", /await flushSaveAwaited\(\)/.test(jBody));
check("runTaskCheckJob: yiqilganda rollback + job retry", /verifyRollbackApply\(snapJ, u\)/.test(jBody) && /job\.lastError = "save_failed"/.test(jBody));
check("runTaskCheckJob: referal kechiktirilgan (noSave)", /tryQualifyReferral\(u, \{ defer: notices, noSave: true \}\)/.test(jBody));

/* 8. signup bonus saqlanmasa bayroq qayta qo'yiladi */
check("grantSignupBonus: saqlanmasa retry bayrog'i", /u\.signupPending = true;/.test(body("grantSignupBonus")));
check("getUser: sovg'a berilmaydi, faqat bayroq", !/grantSignupBonus\(/.test(body("getUser")));
const hmBody = body("handleMessage");
check("handleMessage: await grantSignupBonus", /await grantSignupBonus\(u\)/.test(hmBody));

/* 9. Money funksiyalar save() bilan cheklanmaydi — flushOrRollback bor */
for (const f of ["applyAdminAdjust", "grantChannelLinkBonus", "qualifyReferralCore", "cancelOrder", "cancelOrderAdmin"]) {
  check(`${f}: flushOrRollback bilan saqlanadi`, /await flushOrRollback\(/.test(body(f)));
}

/* 9b. INSTANSLARARO tranzaksiya (ko'p instans) */
const sBody = body("withStateTx");
check("withStateTx: advisory lock oladi", /await acquireStateLock\(\)/.test(sBody) && /releaseStateLock\(acq\.client\)/.test(sBody));
check("withStateTx: mutatsiyadan oldin holat qayta o'qiladi", /const sync = await syncDown\(\);/.test(sBody));
check("withStateTx: qulf olinmasa ok:false", /return \{ ok: false, reason: acq\.reason \}/.test(sBody));
check("withStateTx: reentrant (shu tranzaksiya ichida qayta qulf olinmaydi, konvert saqlanadi)", /if \(st && st\.state\) return \{ ok: true, value: await fn\(\) \};/.test(sBody));
check("withStateTx: in-process save qulfi bilan", /return withSaveLock\(run\)/.test(sBody));
const pnBody = body("persistNow");
check("persistNow: rev bo'yicha CAS (WHERE id = 1 AND rev = $2)", /WHERE id = 1 AND rev = \$2 RETURNING rev/.test(pnBody));
check("persistNow: CAS konfliktida false", /if \(!r\.rows \|\| !r\.rows\.length\)/.test(pnBody) && /CAS konflikti/.test(pnBody));
const sdBody = body("syncDown");
check("syncDown: uch tomonlama merge", /mergeTop\(base, ours, row\.data\)/.test(sdBody) && /liveSync\(merged\)/.test(sdBody));
const lsBody = body("liveSync");
check("liveSync: obyekt identifikligi saqlanadi (restoreInto)", /restoreInto\(hit, x\)/.test(lsBody) && /restoreInto\(y, x\)/.test(lsBody));
check("state lock kaliti polling kalitlaridan alohida", /var STATE_LOCK_KEY = "gxb:state"/.test(src) && !/STATE_LOCK_KEY = .*poll:/.test(src));
for (const f of ["applyAdminAdjust", "grantSignupBonus", "grantChannelLinkBonus", "tryQualifyReferral", "cancelOrder", "cancelOrderAdmin", "createOrderConfirmed", "verifyBatch", "runTaskCheckJob"]) {
  check(`${f}: instanslararo tranzaksiya ichida`, /await withStateTx\(/.test(body(f)));
}

/* 10. Rollback snapshot referensni saqlaydi (obyekt almashtirilmaydi) */
check("verifyRollbackApply: restoreInto ishlatadi", /restoreInto\(u, snap\.user\)/.test(body("verifyRollbackApply")));
const rBody = body("verifyRollbackApply");
check("verifyRollbackApply: faqat op yozuvlari olib tashlanadi (opId)",
  /db\.orders = dropOpRows\(db\.orders, snap, 0\)/.test(rBody) &&
  /db\.verificationJobs = dropOpRows\(db\.verificationJobs, snap, 0\)/.test(rBody) &&
  /db\.memberships = dropOpRows\(db\.memberships, snap, 0\)/.test(rBody) &&
  /db\.transactions = dropOpRows\(db\.transactions, snap, snap\.len\.tx\)/.test(rBody) &&
  /db\.membershipEvents = dropOpRows\(db\.membershipEvents, snap, snap\.len\.ev\)/.test(rBody) &&
  /db\.verifyLog = dropOpRows\(db\.verifyLog, snap, snap\.len\.log\)/.test(rBody));
check("verifyRollbackApply: length bo'yicha qisqartirish YO'Q", !/\.length = Math\.min/.test(rBody));
check("verifyRollbackApply: joblar obyekt sifatida tiklanadi", /if \(snap\.jobs\)/.test(rBody));

/* 11. Operatsiya ID har bir yozuvga qo'yiladi (ID bo'yicha rollback) */
check("addTx: opId belgisi", /opId: CURRENT_OP/.test(body("addTx")));
check("membershipEvent: opId belgisi", /opId: CURRENT_OP/.test(body("membershipEvent")));
check("ensureMembership: opId belgisi", /opId: CURRENT_OP/.test(body("ensureMembership")));
check("scheduleMembershipCheck: opId belgisi", /opId: CURRENT_OP/.test(body("scheduleMembershipCheck")));
check("scheduleTaskCheck: opId belgisi", /opId: CURRENT_OP/.test(body("scheduleTaskCheck")));
check("autoOrderFromBalance: opId belgisi", /opId: CURRENT_OP/.test(body("autoOrderFromBalance")));
check("applyVerified: verifyLog opId belgisi", /opId: CURRENT_OP/.test(body("applyVerified")));
check("creditsSnapshot: op saqlanadi", /op: CURRENT_OP/.test(body("creditsSnapshot")));
check("creditsRestore: dropOpRows ishlatadi", /dropOpRows\(db\.transactions, snap, snap\.txLen\)/.test(body("creditsRestore")));
check("dropOpRows: op bo'lmasa uzunlik fallback", /arr\.slice\(0, fallbackLen \|\| 0\)/.test(body("dropOpRows")));
check("verifyBatch: op tarmoq fazasidan keyin SET qilinadi", /const endOp = opSet\(opV\)/.test(vBody) && /const opV = newOpId\("vb"\)/.test(vBody));

check("verifyBatch: flush+rollback qulf ichida",
  /const saved = await withSaveLock\(async \(\) => \{/.test(vBody) && /verifyRollbackApply\(snapV, u\);/.test(vBody));
check("runTaskCheckJob: flush+rollback qulf ichida",
  /const saved = await withSaveLock\(async \(\) => \{/.test(jBody) && /verifyRollbackApply\(snapJ, u\);/.test(jBody));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed ? 1 : 0);
