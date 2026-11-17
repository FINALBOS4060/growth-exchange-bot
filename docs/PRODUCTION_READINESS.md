# Production Readiness — arxitektura, tranzaksiyalar va migratsiya rejasi

Holat: **reja + spetsifikatsiya testlari**. Kod (ledger, session, export,
guard) hali yozilmagan. Hech qanday production cutover, kredensial aylantirish,
ma'lumot o'chirish yoki qaytarib bo'lmaydigan amal bajarilmaydi.

Versiya: 2 — A–E bandlari bo'yicha qayta ishlangan.

---

## 0. Audit natijalari (o'lchangan)

| Topilma | Ahamiyati |
|---|---|
| `git log --all` da `server.js` ning eski commitida haqiqiy `NEWS_BOT_TOKEN` (commit `922f7f2`) | **BAJARILDI** — aylantirildi, eskisi `401 Unauthorized`; yangisi `.env` + Render env; tarixni qayta yozish ochiq masala |
| Lokal `data/db.json` ichida haqiqiy asosiy bot tokeni (46 belgi) | **Kritik** — E2E paytida production bot polling boshlangan edi |
| `POST /api/admin/export` butun `state`ni qaytaradi (`bots[].token`, `adminUsers[].passHash`) | **Kritik** |
| Sessiyalar `Map` da, restartda o'ladi | O'rta |
| `membershipEvents` 50 000 tadan keyin `splice(0, 1e4)` | O'rta |
| Kredit band qilish atomar emas (xotirada o'qib-yozish) | **Kritik** |
| Testlar `data/` ichida, `.gitignore` bilan yashirilgan | O'rta |
| Ma'lumot bitta `app_state` JSONB qatorida | O'rta |

---

## 1. Joriy arxitektura

```
Telegram Bot API ──long polling──▶ server.js (bitta Node jarayoni)
panel.html ────HTTP──────────────▶ HTTP server
                                     ├── xotiradagi `db` (users, channels, orders,
                                     │    tasks, memberships, jobs, transactions…)
                                     ├── SESSIONS: in-memory Map ← restartda o'ladi
                                     └── save() 500 ms debounce
                                            ├── app_state (id=1, data jsonb)
                                            ├── app_backup (kunlik nusxa)
                                            └── data/db.json (lokal fayl)
```

### Maqsadli arxitektura

```
users ─┬─< telegram_channels ─┬─< channel_controllers
       │                       └─< orders ─< tasks
       ├─< instagram_profiles ─< orders
       ├─< memberships ─< membership_events
       ├─< verification_jobs
       ├─< credit_wallets (1:1) ─< credit_transactions (append-only)
       ├─< referrals / complaints / sessions
       └─< sponsor_memberships >─ sponsor_channels
admin_users ─< audit_log
```

`app_state` o'chirilmaydi: cutoverdan keyin read-only `app_state_legacy`
rollback nuqtasi sifatida qoladi.

---

## 2. Kredit ledger — matematik izchil model (A band)

### 2.1 Muammo

Avvalgi taklif `ORDER_RESERVATION` ni `amount = -cost` deb yozardi. Lekin bu
amal **sarflash emas**, balki `available → reserved` ko'chirish:

```
amount = -cost          →  available + reserved  = -cost  ❌ (haqiqatda 0)
```

Shuning uchun bitta ishorali `amount` modeli qaytim, bekor qilish va
to'ldirishni to'g'ri ifodalay olmaydi. **Ikki mustaqil delta** kerak.

### 2.2 Sxema

```sql
CREATE TABLE credit_wallets (
  user_id      text PRIMARY KEY REFERENCES users(id),
  available    bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved     bigint NOT NULL DEFAULT 0 CHECK (reserved  >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_transactions (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id),
  transaction_type text NOT NULL,
  available_delta  bigint NOT NULL,
  reserved_delta   bigint NOT NULL,
  related_order_id text,
  related_task_id  text,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (available_delta <> 0 OR reserved_delta <> 0)
);
CREATE UNIQUE INDEX credit_tx_idem ON credit_transactions (idempotency_key);
CREATE INDEX credit_tx_user ON credit_transactions (user_id, created_at DESC);
CREATE INDEX credit_tx_order ON credit_transactions (related_order_id);
```

`credit_transactions` — **faqat INSERT**. UPDATE/DELETE yo'q; xato faqat
`REVERSAL` bilan tuzatiladi.

### 2.3 Tranzaksiya turlari

| `transaction_type` | `available_delta` | `reserved_delta` | Ma'nosi |
|---|---|---|---|
| `TASK_REWARD` | `+R` | `0` | tasdiqlangan Telegram obunasi |
| `REFERRAL_REWARD` | `+R` | `0` | malakali referal |
| `ORDER_RESERVATION` | `-C` | `+C` | buyurtma yaratildi: kredit band qilindi (sarflash EMAS) |
| `ORDER_FULFILL` | `0` | `-u` | bitta **pullik** birlik yetkazildi (`free_units = 0` bo'lganda) |
| `ORDER_REFUND` | `+X` | `-X` | bekor qilish: bajarilmagan qism qaytarildi |
| `ADMIN_ADJUSTMENT` | `±A` | `0` | qo'lda tuzatish (audit bilan) |
| `REVERSAL` | `-orig_available` | `-orig_reserved` | xato tranzaksiyani qaytarish |

> `ORDER_FULFILL` — minimal ro'yxatga qo'shilgan yagona tur. Sabab: kredit
> buyurtma yaratilganda to'liq band qilinadi, shuning uchun birlik haqiqatda
> yetkazilganda bandlik **kamayishi** shart; aks holda `reserved` hech qachon
> tushmaydi va bekor qilishda qaytim ikki marta hisoblanadi.

### 2.4 Rekonciliatsiya formulalari

```
available(w) = Σ available_delta        (barcha tranzaksiyalar bo'yicha)
reserved(w)  = Σ reserved_delta
total(w)     = available(w) + reserved(w) = Σ (available_delta + reserved_delta)
earned(w)    = Σ available_delta  WHERE transaction_type IN
                 ('TASK_REWARD','REFERRAL_REWARD')
                 + Σ available_delta WHERE transaction_type='ADMIN_ADJUSTMENT'
                   AND available_delta > 0
spent(w)     = Σ -reserved_delta WHERE transaction_type = 'ORDER_FULFILL'
```

Buyurtma darajasida:

```
order_reserved(o) = Σ reserved_delta  (shu order_id bo'yicha)
                  = (requested - verified - free_units) × unit_cost
```

Kunlik tekshiruv SQL:

```sql
-- 1) hamyon ↔ ledger
SELECT w.user_id,
       w.available, SUM(t.available_delta) AS calc_available,
       w.reserved,  SUM(t.reserved_delta)  AS calc_reserved,
       w.available + w.reserved            AS stored_total,
       SUM(t.available_delta + t.reserved_delta) AS calc_total
FROM credit_wallets w LEFT JOIN credit_transactions t ON t.user_id = w.user_id
GROUP BY w.user_id, w.available, w.reserved
HAVING w.available <> COALESCE(SUM(t.available_delta),0)
    OR w.reserved  <> COALESCE(SUM(t.reserved_delta),0);

-- 2) buyurtma bandligi
SELECT o.id, SUM(t.reserved_delta) AS order_reserved,
       (o.requested_quantity - o.verified_quantity - o.free_units) * o.unit_cost AS expected
FROM orders o LEFT JOIN credit_transactions t ON t.related_order_id = o.id
WHERE o.status = 'active'
GROUP BY o.id, o.requested_quantity, o.verified_quantity, o.free_units, o.unit_cost
HAVING SUM(t.reserved_delta) IS DISTINCT FROM
       (o.requested_quantity - o.verified_quantity - o.free_units) * o.unit_cost;
```

Ikkala so'rov ham **bo'sh** qaytishi shart. Aks holda: `health` ogohlantirishi,
admin panelda banner, `audit_log` yozuvi, yangi yechish bloklanadi.

### 2.5 Ishlangan misollar

Boshlang'ich: `available = 1000`, `reserved = 0`.

**(1) Buyurtma yaratish — 600 birlik × 1 kredit**
```
ORDER_RESERVATION  available -600  reserved +600
→ available 400 · reserved 600 · total 1000   (total o'zgarmadi ✔)
```

**(2) 2 ta obuna tasdiqlandi — har biri 1 kredit**
```
ORDER_FULFILL (×2)  available 0    reserved -1   (har biri)
→ available 400 · reserved 598 · total 998    (2 kredit sarflandi)
```

**(3) Vazifa mukofoti — 100 kredit**
```
TASK_REWARD  available +100  reserved 0
→ available 500 · reserved 598 · total 1098
```

**(4) 600 talik buyurtma bekor qilindi (2 ta bajarilgan)**
```
qaytim = (600 - 2 - 0) × 1 = 598
ORDER_REFUND  available +598  reserved -598
→ available 1098 · reserved 0 · total 1098
   earned 100 · spent 2 · yakuniy mantiq: 1000 - 2 + 100 = 1098 ✔
```

**(5) Xato mukofotni qaytarish (`REVERSAL`)**
```
TASK_REWARD (xato)   available +100  reserved 0      → 500 / 598
REVERSAL             available -100  reserved 0      → 400 / 598
idempotency_key = 'reverses:<tx_id>'  (bir marta)
```
Agar `available` 100 dan kam bo'lsa, REVERSAL rad etiladi (manfiy balans
taqiqlangan) — admin `ADMIN_ADJUSTMENT` bilan hal qiladi va audit yoziladi.

**Bepul birliklar** (`free_units`, `unit_cost = 0`): hech qanday pul harakati
yo'q — ledger yozuvi yaratilmaydi, faqat vazifa holati va statistika yangilanadi.
Shuning uchun ular `expected` formulasida ayiriladi.

**Sarflash tartibi:** tasdiqlangan birlik avval `free_units` dan ayiriladi
(`free_units -= 1`), va faqat `free_units = 0` bo'lganda `ORDER_FULFILL`
yoziladi. Aks holda `reserved` bepul birliklar hisobiga tushib ketardi.

Misol: 260 birlik = 210 pullik + 50 bepul.

| Hodisa | verified | free_units | ledger `reserved` | expected formula |
|---|---|---|---|---|
| yaratish | 0 | 50 | 210 | (260-0-50)×1 = 210 ✔ |
| 2 ta bepul birlik | 2 | 48 | 210 (yozuv yo'q) | (260-2-48)×1 = 210 ✔ |
| 50 ta bepul tugadi | 50 | 0 | 210 | (260-50-0)×1 = 210 ✔ |
| +10 pullik birlik | 60 | 0 | 200 (10 × −1) | (260-60-0)×1 = 200 ✔ |

### 2.6 Tranzaksiya ichidagi qulf

```sql
BEGIN;
  UPDATE credit_wallets
     SET available = available - $cost, reserved = reserved + $cost
   WHERE user_id = $uid AND available >= $cost
  RETURNING available, reserved;          -- 0 qator → yetmadi → ROLLBACK
  INSERT INTO credit_transactions (…);
  INSERT INTO orders (…);
COMMIT;
```

`UPDATE … WHERE available >= $cost` qatorni joriy tranzaksiya oxirigacha
qulflaydi (`FOR UPDATE` semantikasi). Ikkinchi parallel tranzaksiya kutadi va
qulf ochilgach **yangi** qiymatni ko'radi — shuning uchun manfiy balans ham,
ikki marta band qilish ham mumkin emas. Qo'shimcha: `CHECK (available >= 0)`
bazaviy kafolat.

---

## 3. Idempotent buyurtma yaratish (B band)

Klient (`u.state` / panel formasi) tasdiqlash ekranida `client_token`
(UUID) yaratadi va qayta yuborishda **o'sha tokenni** ishlatadi.

```sql
-- 1) buyurtma (yoki mavjudi)
INSERT INTO orders (id, user_id, destination_id, platform, requested_quantity,
                    unit_cost, total_cost, status, client_token)
VALUES ($id,$uid,$dest,$plat,$qty,$unit,$cost,'active',$token)
ON CONFLICT (user_id, client_token) DO NOTHING
RETURNING id;
```

- **1 qator qaytdi** → yangi buyurtma; davom etamiz (2-qadam).
- **0 qator** → bu token bilan buyurtma bor:
  ```sql
  SELECT id, status, requested_quantity, verified_quantity, reserved_credits
    FROM orders WHERE user_id=$uid AND client_token=$token;
  ```
  `COMMIT`, javob: `{ created:false, orderId, status, reserved }`.
  **Kredit qayta band qilinmaydi, yangi order yaratilmaydi.**

```sql
-- 2) atomar band qilish
UPDATE credit_wallets
   SET available = available - $cost, reserved = reserved + $cost
 WHERE user_id = $uid AND available >= $cost
RETURNING available, reserved;
```

`0 qator` → **ROLLBACK**: 1-qadamda kiritilgan buyurtma ham yo'qoladi (atomar
tranzaksiya), javob `{ ok:false, reason:"INSUFFICIENT", shortage }`. Bazada
yarim holat qolmaydi.

```sql
-- 3) ledger
INSERT INTO credit_transactions (…,'ORDER_RESERVATION',-cost,+cost,'reserve:'||$id)
ON CONFLICT (idempotency_key) DO NOTHING;
COMMIT;
```

Konkurensiya tafsiloti: bir vaqtda ikkita bir xil `client_token` kelsa,
ikkinchi `INSERT` birinchisining tranzaksiyasi tugashini kutadi, keyin
`DO NOTHING` bilan 0 qator oladi va mavjud buyurtmani qaytaradi. Nexthop:
`UNIQUE (user_id, client_token)`.

### Javob shakli (bot va panel bir xil)

```json
{ "created": true,  "orderId": "ord-…", "status": "active",    "available": 400, "reserved": 600 }
{ "created": false, "orderId": "ord-…", "status": "active",    "available": 400, "reserved": 600, "duplicate": true }
{ "created": false, "reason": "INSUFFICIENT", "shortage": 120 }
```

---

## 4. Dual-write xavfsizligi (C band)

### 4.1 Asosiy kafolat: bitta tranzaksiya

`app_state` ham, normallashtirilgan jadvallar ham **bitta Postgres bazasida**
joylashgan. Shuning uchun Faza 4 (dual-write) da ikkala yozuv **bitta SQL
tranzaksiyasi** ichida bajariladi:

```sql
BEGIN;
  -- 1) normallashtirilgan yozuvlar (order, task, wallet, tx …)
  UPDATE credit_wallets …;
  INSERT INTO credit_transactions …;
  INSERT INTO orders …;
  -- 2) JSON hujjatning yangi ko'rinishi
  UPDATE app_state SET data = $newJson::jsonb, updated_at = now() WHERE id = 1;
COMMIT;
```

Bu **outbox talab qilmaydi**: ikki yozuv atomar. Yoki ikkalasi, yoki hech biri.
Outbox faqat ikki xil tizim (masalan, fayl + SQL) bo'lganda kerak — bizda
bunday holat yo'q.

### 4.2 Nega bu "dual-write muammosi" emas

Klassik dual-write muammosi ikki **mustaqil** commit bo'lganda paydo bo'ladi.
Bu yerda commit bitta. Shuning uchun:

| Nosozlik nuqtasi | Natija |
|---|---|
| `COMMIT` dan oldin jarayon o'ldi | ikkala yozuv ham yo'q; qayta urinish xavfsiz (idempotency) |
| `COMMIT` dan keyin, javobdan oldin o'ldi | ikkalasi ham bor; klient `client_token` bilan qayta yuboradi → `duplicate:true`, dublikat yo'q |
| JSON yozuvi xato berdi (hajm/constraint) | butun tranzaksiya `ROLLBACK` |
| normallashtirilgan yozuv xato berdi | butun tranzaksiya `ROLLBACK` |
| tarmoq uzildi | Postgres `ROLLBACK` |
| `UPDATE app_state` juda sekin | tranzaksiya davom etadi; timeout bo'lsa rollback (izchillik saqlanadi) |

### 4.3 Fayl rejimi (lokal/test)

Fayl rejimida ikkinchi nishon yo'q — `STORE_BACKEND=json`, dual-write
**yoqilmaydi**. Agar kelajakda fayl → SQL ko'chirish kerak bo'lsa, outbox
qo'llanadi:

```
data/outbox.ndjson   {"seq":123,"op":"order.reserve","payload":{...},"at":"…"}
```
Tartib: (1) `seq` bilan qator yoziladi va `fsync`; (2) xotira/fayl holati
yangilanadi; (3) `last_applied_seq` yoziladi. Restartda `last_applied_seq` dan
katta barcha yozuvlar idempotent qayta qo'llanadi (`idempotency_key` bo'yicha
`ON CONFLICT DO NOTHING`). Kompaktizatsiya: `last_applied_seq` gacha bo'lgan
qatorlar o'chiriladi, lekin faqat qo'llanganligi tasdiqlangandan keyin.

### 4.4 Shadow tekshiruv (Faza 4)

- `GET /api/admin/health/diff` — normallashtirilgan proyeksiya bilan JSON'dan
  hisoblangan proyeksiyani solishtiradi (users/channels/orders/tasks/wallets/
  memberships/events/jobs sonlari + kredit yig'indilari).
- Har 10 daqiqada `shadowDiff()` job; farq > 0 bo'lsa:
  `audit_log` + `health.lastShadowMismatch` + cutover **avtomatik to'xtaydi**.
- Farq bo'lsa tuzatish: JSON manba hisoblanadi (cutovergacha), farq qilgan
  yozuvlar qayta proyeksiya qilinadi; hech qachon "ikkalasini o'chirish" yo'li
  ishlatilmaydi.

### 4.5 Cutover sharti

Faza 5 faqat quyidagilar bajarilganda: 72 soat ketma-ket `shadowDiff == 0`,
rekonciliatsiya so'rovlari bo'sh, T1–T22 yashil, qo'lda `pg_dump` nusxasi bor.
Cutover — `STORE_BACKEND=sql`; `app_state` read-only. Rollback —
`STORE_BACKEND=json` (hujjat hali ham to'liq yangilanib turgan).

---

## 5. Production / test izolyatsiyasi (D band)

```
production: APP_ENV=production · TELEGRAM_API_BASE yo'q (api.telegram.org)
test:       APP_ENV=test · TELEGRAM_API_BASE=http://127.0.0.1:3997
            TELEGRAM_BOT_TOKEN=TESTTOKEN · DATA_FILE=data/test-db.json
```

### 5.1 Ikki qavatli himoya

**Qavat 1 — `assertEnvSafe()` (startup, jarayon ishga tushmaydi):**

| Shart | Natija |
|---|---|
| `APP_ENV=test` va `TELEGRAM_API_BASE` yo'q yoki `api.telegram.org` | `exit 1` |
| `APP_ENV=test` va token `TESTTOKEN` emas | `exit 1` |
| `APP_ENV=test` va token `sha256` bo'yicha production tokeniga mos | `exit 1` |
| `APP_ENV=production` va `TELEGRAM_API_BASE` loopback/mock | `exit 1` |
| `APP_ENV=test` va `DATABASE_URL` = production bazasi | `exit 1` |
| `APP_ENV` yo'q | `test` deb hisoblanadi (xavfsiz default) |

**Qavat 2 — transport allowlist (`lib/tg-transport.js`):**
barcha Telegram so'rovlari bitta funksiyadan o'tadi:

```js
function tgUrl(method) {
  const base = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
  if (APP_ENV === "test" && !isLoopback(base)) throw new Error("TEST_EGRESS_BLOCKED");
  return `${base}/bot${token}/${method}`;
}
```

Test rejimida `globalThis.fetch` o'raladi: ruxsat etilgan origin — faqat
`TELEGRAM_API_BASE`; boshqa har qanday host (`api.telegram.org` ham) →
`ERR_TG_TEST_EGRESS` va `tests/artifacts/blocked-egress.jsonl` ga yoziladi.
Barcha o'tgan so'rovlar `tests/artifacts/tg-calls.jsonl` ga yoziladi.

**Qavat 3 (ixtiyoriy, CI):** test jarayoni `HTTP_PROXY=http://127.0.0.1:1`
bilan ishga tushiriladi — tashqi tarmoq umuman yo'q; mock esa loopback.

### 5.2 Isbot (T20, T21)

- `tg-calls.jsonl` bo'sh emas (so'rovlar haqiqatan bo'lgan);
- har bir yozuvdagi host **faqat** `127.0.0.1:<mock port>`;
- `api.telegram.org` ga birorta yozuv yo'q;
- `fetch("https://api.telegram.org/bot.../getMe")` test rejimida **throw** qiladi;
- `APP_ENV=test` + real token bilan jarayon ishga tushmaydi (exit 1).

### 5.3 Sirlar

- Test/test-fixture'larda haqiqiy token yo'q (faqat `TESTTOKEN`).
- `data/db.json` dagi haqiqiy token **o'chiriladi**; test seed'lari toza.
- Productionda panel orqali qo'shilgan ishchi bot tokenlari `app_secrets`
  jadvalida AES-256-GCM (`SECRETS_KEY`) bilan shifrlanadi; `app_state`ga
  yozilmaydi.
- Eksport hech qachon token/parol/hash qaytarmaydi (§6).

---

## 6. `membershipEvents` — saqlash siyosati

1. `splice(0, 1e4)` **olib tashlanadi**.
2. Oylik `RANGE` partition (`event_time`); indekslar
   `(user_id, channel_id, event_time DESC)`, `(event_type, event_time)`.
3. Hajm o'ssa `DETACH PARTITION` → `membership_events_archive` (ma'lumot
   qoladi, birlashma orqali o'qiladi). O'chirish faqat owner buyrug'i + audit.
4. Statistika shu jadvaldan — tarix qisqarmagani uchun raqamlar barqaror.
5. Hajmni cheklashning to'g'ri yo'li — yozishni kamaytirish (holat o'zgarmasa
   yozmaslik, allaqachon qilingan), o'chirish emas.

---

## 7. Xavfsiz eksport va sessiyalar

| Endpoint | Mazmun | Ruxsat | Audit |
|---|---|---|---|
| `POST /api/admin/export` (standart `mode=sanitized`) | barcha biznes ma'lumot, `token/pass/password/secret/hash/sid/cookie` → `"[REDACTED]"` (rekursiv) | owner, superadmin | `export_sanitized` |
| `POST /api/admin/secrets-backup` | AES-256-GCM shifrlangan fayl (`SECRETS_BACKUP_KEY`), faqat owner, javobda hash | owner | `secrets_backup` |

`mode=raw` **mavjud bo'lmaydi**. Test T11: eksportda `\d{8,10}:[A-Za-z0-9_-]{30,}`
naqshi ham, `scrypt` hash formati ham topilmaydi.

Sessiyalar:

```sql
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,          -- sha256(xom token)
  username text NOT NULL, role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip text, user_agent text
);
CREATE INDEX sessions_exp ON sessions (expires_at);
```

Cookie'da xom token, bazada faqat hash. Restartdan keyin sessiya saqlanadi.
Logout → qator o'chiriladi; parol o'zgarsa — barcha sessiyalar o'chiriladi.

---

## 8. Migratsiya rejasi (ma'lumot yo'qolmaydi)

| Faza | Amal | Buzuvchimi |
|---|---|---|
| 0 | `pg_dump` + `app_backup` nusxasi; `schema.sql` | yo'q |
| 1 | `CREATE TABLE IF NOT EXISTS` — yangi jadvallar | yo'q (qo'shadi) |
| 2 | Backfill: `app_state.data` → jadvallar, `legacy_id` + `ON CONFLICT DO NOTHING` | yo'q (faqat INSERT) |
| 3 | `verify-migration.mjs`: har jadval COUNT/SUM, kredit yig'indilari, holatlar; farq 0 bo'lmaguncha to'xtash | yo'q (o'qish) |
| 4 | Dual-write (bitta tranzaksiya) + `shadowDiff()` 72 soat | yo'q (JSON manba qoladi) |
| 5 | Cutover `STORE_BACKEND=sql`; `app_state` read-only | **ha** — sizning tasdiqingiz |
| 6 | `app_state_legacy` arxivlash / o'chirish | **ha** — sizning tasdiqingiz |

Kreditlar: `credit_wallets` hujjatdagi `credits.available/reserved` dan
boshlanadi, `credit_transactions` esa mavjud `transactions` dan `legacy_id`
bilan ko'chiriladi (ishorali `amount` → `available_delta = amount`,
`reserved_delta = 0`, `ORDER_RESERVATION` uchun `available_delta = -cost`,
`reserved_delta = +cost`). Backfill oxirida rekonciliatsiya so'rovlari bo'sh
bo'lishi shart.

---

## 9. O'zgaradigan fayllar

| Fayl | O'zgarish |
|---|---|
| `server.js` | store/session/export/guard chaqiruvlari; ledger va jobs |
| `lib/store/pg.js` (yangi) | `reserveCredits`, `fulfillUnit`, `refundOrder`, `rewardTask`, `reconcile` |
| `lib/store/json.js` (yangi) | hozirgi xatti-harakat (lokal/test/rollback) |
| `lib/tg-transport.js` (yangi) | URL allowlist, test egress guard, call log |
| `lib/env-guard.js` (yangi) | `assertEnvSafe()` |
| `lib/export.js` (yangi) | sanitizatsiya + shifrlangan secrets backup |
| `lib/session.js` (yangi) | hash tokenli persistent sessiya |
| `schema.sql` (yangi) | jadvallar, cheklovlar, indekslar, partitionlar |
| `scripts/migrate-to-sql.mjs`, `scripts/verify-migration.mjs`, `scripts/reconcile-credits.mjs` (yangi) | Faza 2/3 + rekonciliatsiya |
| `tests/*` (yangi) | quyidagi matritsa |
| `panel.html` | rekonciliatsiya holati, sessiya/eksport xabarlari |
| `package.json` | `"test": "node tests/run.mjs"`, `"test:pg"` |

---

## 10. Test matritsasi

| # | Test | Isbotlaydi | Holat |
|---|---|---|---|
| T1 | `credit-concurrency` — 20 parallel reserve (1000 balans, 100 so'rov) | 10 o'tadi, `available >= 0`, 10 tx, `reserved = 1000` | yozilishi kerak (PG) |
| T2 | `credit-negative` — 50 bor, 100 so'rov | rad, balans o'zgarmaydi, tx yo'q | ⏳ |
| T3 | `duplicate-submit` — bir `client_token` 5 parallel | 1 buyurtma, 1 reservation, `duplicate:true` | ⏳ |
| T4 | `duplicate-reward` — bir task 5 parallel | 1 `TASK_REWARD` | ⏳ |
| T5 | `duplicate-refund` — bir order 5 parallel bekor | 1 `ORDER_REFUND`, formula to'g'ri | ⏳ |
| T6 | `fifo` | bajarilmaganlar navbat oxiri, tartib | mavjud (membership suite) |
| T7 | `batch-ten` | 10 talik partiya, bitta tugma | mavjud |
| T8 | `recheck-24h` | +24h job, holat o'tishlari | mavjud |
| T9 | `api-error` | `CHECK_ERROR`, backoff | mavjud |
| T10 | `restart-recovery` | `RUNNING` job tiklanadi | mavjud |
| T11 | `export-security` | token/hash yo'q, audit bor | ⏳ |
| T12 | `env-guard` | test+real token → exit 1 | ⏳ |
| T13 | `events-retention` — 60k voqea | hech biri o'chmaydi | ⏳ |
| T14 | `sessions-persist` | restartdan keyin ishlaydi, bazada hash | ⏳ |
| T15 | `business-invariants` (§11) | 12 qoida buzilmagan | ⏳ |
| T16 | `ledger-reconcile` | §2.5 beshta misol, ikkala rekonciliatsiya so'rovi bo'sh | **spec test yozildi** |
| T17 | `order-idempotent-rollback` | yetmagan kreditda buyurtma ham, reservation ham yo'q | ⏳ (PG) |
| T18 | `order-duplicate-response` | mavjud order id + status qaytadi, qayta band qilinmaydi | ⏳ (PG) |
| T19 | `dualwrite-atomicity` — `FAULT_POINT=after_commit` bilan SIGKILL | JSON va jadvallar izchil; qayta urinish dublikat yaratmaydi | ⏳ |
| T20 | `egress-guard` | real API'ga so'rov throw; barcha so'rovlar mock'da | ⏳ |
| T21 | `egress-log` | `tg-calls.jsonl` faqat loopback host | ⏳ |
| T22 | `shadow-diff` | `POST /api/admin/health/diff` farqni topadi | ⏳ |

`tests/` ga ko'chiriladi: mavjud 32 ta a'zolik testi (`tests/membership.test.mjs`).
Hozir `tests/ledger.test.mjs` — §2.5 matematikasini qulflaydi (ishlaydi).

---

## 11. Biznes qoidalari — o'zgarmaydi

1. Telegram va Instagram uchun **bitta** umumiy kredit hamyoni.
2. Platformalar uchun **alohida** vazifa navbatlari.
3. Bir partiyada **10 ta** vazifa.
4. Bitta «✅ Obuna bo'ldim» tugmasi 10 tasini **alohida-alohida** tekshiradi.
5. Bajarilmagan vazifalar FIFO oxiriga qaytadi, eskilar yangilardan oldin.
6. API xatosi obunadan chiqish deb hisoblanmaydi.
7. Tasdiqlangan a'zolik har **24 soatda** qayta tekshiriladi.
8. Soatlik xabarnoma faqat yozilgan voqealarni o'qiydi, skan qilmaydi.
9. Buyurtmani foydalanuvchi o'zi yaratadi (`autoOrderCredits` — mavjud sozlama).
10. Referal bonusi faqat **haqiqiy tasdiqlangan** vazifadan keyin.
11. 1 kredit = 1 obunachi; kanal ulash bonusi 10; Telegram obuna 100; referal 300.
12. Instagram `SELF_CONFIRMED` — kredit yo'q, `VERIFIED` deb ko'rsatilmaydi.

---

## 12. Amal chegarasi (E band)

Bu bosqichda **ruxsat yo'q**: production cutover, kredensial aylantirish,
ma'lumot o'chirish, `git filter-repo`, sxemani productionda qo'llash.

Ruxsat kerak bo'ladigan qadamlar: Faza 5 (cutover), Faza 6 (arxivlash),
`NEWS_BOT_TOKEN` ni yana aylantirish, git tarixini tozalash, asosiy bot
tokenini almashtirish.

Avval hujjat + testlar ko'rib chiqiladi; keyin implementatsiya.
