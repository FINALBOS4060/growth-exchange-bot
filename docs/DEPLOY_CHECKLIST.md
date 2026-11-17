# Yakuniy deploy rejasi va ro'yxat (production)

> **Holat: deploy QILINMAGAN.** Bu hujjat faqat tayyorlangan ketma-ketlik va
> buyruqlar. Deploy, migratsiya, arxivlash yoki production yozuvi — alohida
> tasdiqdan keyin bajariladi.
>
> Bog'liq hujjatlar: [VERIFICATION.md](VERIFICATION.md) (testlar va kod
> dalillari), [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) (me'moriy
> cheklovlar), [DATA_PRESERVATION.md](DATA_PRESERVATION.md).

## 0. Deployoldi audit natijalari

| # | Tekshiruv | Natija | Dalil |
|---|---|---|---|
| 1 | Ikki instansda bir xil `client_token` bilan buyurtma (E2E) | **PASS** | `tests/pg-order-token-multi.test.mjs` 22/22 |
| 2 | PostgreSQL mosligi (production versiyasi) | **NOT TESTED** (production bazasi yo'q) / **PASS** (skript, embedded PG 18) | `scripts/pg-compat-check.mjs`, `tests/pg-compat.test.mjs` 19/19 |
| 3 | Render konfiguratsiyasi (instans, health, env, baza, qulflar) | **PASS** | `tests/render-config.test.mjs` 26/26 |
| 4 | Backup va rollback (tiklash alohida test muhitida) | **PASS** | `tests/backup-restore.test.mjs` 28/28 |
| 5 | Deploydan keyingi read-only tekshiruvlar | **PASS** | `scripts/post-deploy-check.mjs`, `tests/rollback-archive.test.mjs` 53/53 |

### 1. Bir xil `client_token` — ikki instans (E2E)

Ikkita mustaqil `server.js` jarayoni (5641 / 5642), bitta PG 18 va bitta mock
Telegram. Har instans **o'z bot tokenini** poll qiladi (advisory lock har
tokenga bitta polling jarayoni beradi), shuning uchun bir xil
`ordok:<token>` callback'i **ikkala jarayonga ham** yetib boradi.

Natija: **bitta buyurtma, bitta `reserve:` yozuvi, balans bir marta band
qilinadi (−50), `reserved=50`, `orderTokens[token].orderId` bitta, ledger ↔
hamyon farqi 0**. Kechikkan replay ham qo'shimcha buyurtma yaratmaydi.

Bu himoya `withStateTx()` (advisory lock + eng so'nggi holatni o'qish) va
`rec.claimBy` + 60 s lease orqali ishlaydi — ikkinchi instans `rec.orderId` ni
ko'radi va yangi reservation yaratmaydi.

### 2. PostgreSQL versiyasi

`scripts/pg-compat-check.mjs` production versiyasini va ilova tayanadigan
imkoniyatlarni **faqat o'qiydi**:

- `server_version` ≥ 11 (`hashtextextended` uchun);
- `jsonb`, `hashtextextended` deterministikligi, `pg_try_advisory_lock` /
  `pg_advisory_unlock` (TASODIFIY probe kaliti — production polling kaliti
  hech qachon olinmaydi), `to_regclass`;
- `app_state` jadvali va `rev` ustuni (yo'q bo'lsa — xato emas, birinchi deploy
  `ADD COLUMN IF NOT EXISTS` bilan qo'shadi);
- probe yakunida hech qanday yozuv va ortda qolgan qulf yo'qligi (test bilan
  isbotlangan).

Production bazasida hali ishga tushirilmagan (ulanish ruxsati yo'q):
**NOT TESTED**.

### 3. Render konfiguratsiyasi

- `numInstances: 1` — aniq belgilangan. Ko'paytirish xavfsiz, **lekin faqat
  `DATABASE_URL` berilgan bo'lsa** (polling/scheduler/holat qulflari PG
  advisory lock'lariga tayanadi; fayl rejimida ikki instans "Conflict" beradi).
- `healthCheckPath: /healthz` — autentifikatsiyasiz, `/api/` darvozasidan
  oldin ishlaydi, botlar `online` holatini qaytaradi.
- `maxShutdownDelaySeconds: 30` — `shutdown()` ketma-ketligi (abort → tsikl
  tugashini kutish → unlock) uchun oyna.
- Env: `TELEGRAM_BOT_TOKEN`, `ADMIN_IDS`, `NEWS_BOT_TOKEN`, `GEMINI_API_KEY`,
  `DATABASE_URL` (`sync: false`), `ADMIN_PASSWORD` (`generateValue`),
  `KEEP_ALIVE=1`, `KEEP_ALIVE_SEC=600`. Kod ishlatadigan barcha majburiy
  o'zgaruvchilar e'lon qilingan; haqiqiy token qiymati repoda yo'q.
- Doimiy baza: free planda disk yo'q → **`DATABASE_URL` majburiy**. Usiz
  har restart/deploy ma'lumotni yo'qotadi (kod buni logda ogohlantiradi).
- Polling qulfi: `pg_try_advisory_lock(hashtextextended('gxb:poll:<sha1>',0))`,
  alohida ulanish, SIGTERM tartibi bilan bo'shatiladi.
- Scheduler qulfi: `gxb:scheduler` (bir vaqtda bitta jarayon joblarni oladi).
- Holat qulfi: `gxb:state` (barcha pul yo'llari).

## 4. Backup va rollback

**Zaxira (avtomatik):** `startBackupJob()` har soatda tekshiradi va kuniga bir
marta `app_backup` jadvaliga yozadi (14 kun saqlanadi). Qo'lda:
`POST /api/admin/backup`.

**Tiklash:** `scripts/restore-backup.mjs`

```bash
# 1) Mavjud zaxiralar (faqat SELECT)
DATABASE_URL=... node scripts/restore-backup.mjs --list

# 2) Farqni ko'rish (yozmaydi)
DATABASE_URL=... node scripts/restore-backup.mjs --dry-run --id 42

# 3) Tiklash — FAQAT ilova to'xtatilganda
DATABASE_URL=... node scripts/restore-backup.mjs --apply --id 42 --confirm
```

Tiklashdan **oldin** hozirgi holat `app_backup` ga `pre-restore (#42)` sababi
bilan yoziladi (orqaga qaytish yo'li ochiq), keyin `app_state` almashtiriladi
va `rev` +1 bo'ladi (CAS oynasi buzilmaydi). `--apply` `--confirm`siz va
mavjud bo'lmagan `--id` bilan **rad etiladi (exit 2)** — test bilan
isbotlangan. Fayl rejimida `--file <nom>` ishlatiladi.

**Rollback (kod):** oldingi build'ni qaytarish (Render → Deploys → Rollback).
`TASK_CHECK` joblari oldingi build'da notanish bo'lsa, ular **o'chirilmaydi**:
`scripts/archive-task-check-jobs.mjs` arxivlaydi (`verification_job_archive`),
`restore` ularni qaytaradi ([VERIFICATION.md §8.3](VERIFICATION.md)).

**Ma'lumot kafolati:** deploy ham, migratsiya ham, rollback ham
foydalanuvchi balansini, buyurtmalarni, a'zolik voqealarini yoki vazifa
tarixini **o'chirmaydi**. Yagona sxema o'zgarishi —
`ALTER TABLE app_state ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 0`
(mavjud qatorlarga `0` qo'shadi, ma'lumotni qayta yozmaydi).

## 5. Deploy ketma-ketligi (tasdiqdan keyin)

```bash
cd growth-exchange-bot

# ── 0) Testlar (production'ga ta'sir qilmaydi) ──
npm test                       # 23 fayl, hammasi PASS bo'lishi shart

# ── 1) Production holatini o'qish (yozuvsiz) ──
export DATABASE_URL='postgres://…'      # env'dan, chatga yozilmaydi
node scripts/pg-compat-check.mjs        # versiya + imkoniyatlar + probe
node scripts/post-deploy-check.mjs --save-baseline --out data/baseline-pre.json

# ── 2) Zaxira ──
node -e "…POST /api/admin/backup…"      # yoki panel → Health → Zaxira
# yoki: SELECT id, created_at FROM app_backup ORDER BY id DESC LIMIT 3;

# ── 3) Deploy (Render) ──
git push origin master                  # avtomatik deploy (yoki Dashboard → Manual Deploy)
# Deploy oynasida: eski instans SIGTERM oladi → polling to'xtaydi → qulf
# bo'shaydi → yangi instans qulfni oladi (maxShutdownDelaySeconds=30).

# ── 4) Deploydan keyingi tekshiruv (faqat o'qiydi) ──
node scripts/post-deploy-check.mjs \
  --url https://<servis>.onrender.com \
  --baseline data/baseline-pre.json --strict
```

### Deploydan keyin nima o'zgaradi

| Narsa | O'zgarish |
|---|---|
| `app_state` sxemasi | `rev bigint NOT NULL DEFAULT 0` ustuni qo'shiladi (mavjud qatorlar `0`) |
| Ma'lumot | **hech narsa o'chirilmaydi/o'zgartirilmaydi**; har yozuvda `rev` +1 |
| Jarayon | bitta polling instansi (qulf bilan kafolatlangan) |
| Joblar | `TASK_CHECK` joblari o'z holida qoladi; arxivlash — faqat qo'lda |

## 6. Deploydan keyingi read-only tekshiruvlar

`node scripts/post-deploy-check.mjs --url … --baseline … --strict` quyidagilarni
tekshiradi (hech narsa yozmaydi; `--save-baseline` faqat lokal fayl yozadi):

1. **Holat snapshot'i** — foydalanuvchi, kanal, buyurtma, vazifa, jurnal,
   a'zolik, joblar soni (baseline bilan solishtiriladi; kamayish = xato).
2. **Polling instanslari** — advisory lock mexanizmi probe'i (tasodifiy kalit,
   darhol bo'shatiladi), har bot uchun `pg_locks` (bir kalitni ikki sessiya
   ushlamasligi), `/healthz` (`online` botlar ≤ 1).
3. **Telegram Conflict** — Render loglarida `Conflict: terminated by other
   getUpdates` (0 bo'lishi shart; tarmoq yo'q bo'lsa — "o'tkazib yuborildi").
4. **RECHECK / CHECK_ERROR** — har vazifa uchun aynan bitta ochiq `TASK_CHECK`
   jobi; arxivlangan joblar o'chirilmaganligi.
5. **Takroriy joblar** — bir `task:`/`mem:` uchun bir nechta ochiq job yo'qligi.
6. **Kredit rekonciliatsiyasi** — `available = Σ amount`,
   `reserved = Σ|order_spend| − Σ(order_refund) − spent`, `total = available +
   reserved`; manfiy balans yo'q; takror `idempotencyKey` yo'q. Hech narsa
   avtomatik tuzatilmaydi.
7. **Referal mukofoti** — har `REFERRAL_REWARD` aynan **300 kredit**, takror
   `refreward:` kaliti yo'q (farq → `--strict` da exit 1).
8. **A'zolik qayta tekshiruvi** — `ACTIVE` a'zoliklarda `nextCheckAt` bor,
   `RECHECK` joblar kechikmagan, bir vaqtga to'planmagan (staggered).
9. **A'zolik voqealari** — `membershipEvents` baseline bilan bir xil yoki o'sgan.

## 7. Muammo bo'lsa

| Alomat | Birinchi qadam |
|---|---|
| `online` botlar > 1 yoki Conflict | qulf ishlamayapti: `pg_locks` tekshirish, eski instansni to'xtatish |
| `--strict` da ledger farqi | `post-deploy-check` chiqishidagi `sabab:` qatorlarini o'qish; **qo'lda tuzatish yo'q** |
| Yangi build ishlamayapti | Render → Rollback (oldingi build); ma'lumot tegilmagan |
| Holat buzilgan | ilovani to'xtatish → `restore-backup.mjs --dry-run` → `--apply --id N --confirm` |
| `rev` konflikti logda | bir vaqtda ikki instans yozgan: qulfni tekshirish (bu xato bo'lsa yozuv rad etiladi, ma'lumot buzilmaydi) |
