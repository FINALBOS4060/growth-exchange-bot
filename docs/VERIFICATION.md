# A'zolik tekshiruvi tizimi (DB, verification, 24h scheduler)

Bu hujjat `server.js` dagi a'zolik (membership) registri, tekshiruv navbati va
soatlik xabarnoma mexanizmini tavsiflaydi. Spetsifikatsiya talab qilgan
"doimiy skanerlash emas, rejalashtirilgan tekshiruv" modeli shu yerda.

## 1. Ma'lumotlar modeli

Baza — yagona JSON hujjat (`db`), Postgres'da `state` ustunida saqlanadi
(`DATABASE_URL` bo'lsa). Quyidagi kolleksiyalar qo'shildi:

| Kolleksiya | Vazifasi | Muhim maydonlar |
|---|---|---|
| `memberships` | Har bir ma'lum (foydalanuvchi, kanal) juftligi uchun BITTA joriy yozuv | `id, userId, channelId, status, firstSeenAt, firstVerifiedAt, lastCheckedAt, nextCheckAt, lastMembershipChangeAt, lastCheckResult, consecutiveCheckErrors` |
| `membershipEvents` | Faqat qo'shiladigan tarix | `id, userId, channelId, eventType, oldStatus, newStatus, source, eventTime, apiResult, relatedTaskId` |
| `verificationJobs` | Doimiy (persistent) tekshiruv navbati | `id, membershipId, userId, channelId, jobType, scheduledAt, status, attemptCount, lastError, lockedAt, completedAt, idempotencyKey` |
| `sponsorMemberships` | Homiy kanallar a'zoligi — oddiy vazifalardan ALOHIDA | `id, userId, sponsorId, membershipStatus, lastCheckedAt, lastCheckResult` |
| `notifPeriods` | Soatlik xabarnoma davrlari (takror yuborishni to'sadi) | `id, key, userId, periodStart, periodEnd, notificationType, sentAt, status` |
| `transactions` | Kredit jurnali | `... , idempotencyKey, relatedTaskId` |

`memberships` uchun mantiqiy yagonalik: `(userId, channelId)` — `ensureMembership`.
`verificationJobs` uchun: `idempotencyKey = jobType:userId:channelId:soat`.

Eski (deploygacha tasdiqlangan) obunalar `migrateMemberships()` bilan registrga
ko'chiriladi: hech qanday foydalanuvchi, buyurtma yoki tarix o'chirilmaydi.

## 2. A'zolik holatlari va o'tishlar

```
            ┌──────────┐  obuna tasdiqlandi (task_verify)
            │ PENDING  │──────────────────────────────┐
            └──────────┘                              ▼
                                                 ┌────────┐
        ┌────────────────────────────────────────│ ACTIVE │
        │  recheck: not_member                   └────────┘
        ▼                                            ▲   │
  ┌───────────┐   recheck: member (REJOINED)         │   │ recheck: API xatosi
  │ CANCELLED │──────────────────────────────────────┘   ▼
  └───────────┘                                     ┌─────────────┐
                                                    │ CHECK_ERROR │
                                                    └─────────────┘
```

- `CHECK_ERROR` — vaqtinchalik API xatosi. **Obunadan chiqish deb hisoblanmaydi.**
  Job `5 daqiqa × 2^n` (maks. 6 soat) backoff bilan qayta navbatga qo'yiladi.
- `CANCELLED` — faqat API aniq `left`/`kicked` qaytarganda.
- `REJOINED` — qayta obuna: voqea yoziladi, statistika tiklanadi, **yangi kredit
  berilmaydi** (spec §3-B).

Voqea turlari: `FIRST_VERIFIED`, `RECHECK_ACTIVE`, `UNSUBSCRIBED`, `REJOINED`,
`CHECK_ERROR`.

**Jurnal hajmi siyosati:** holat o'zgarmagan muvaffaqiyatli 24 soatlik tekshiruv
`membershipEvents` ga yozilmaydi — faqat `lastCheckedAt`, `lastHealthyCheckAt`,
`healthyCheckCount` va `nextCheckAt` yangilanadi. `RECHECK_ACTIVE` faqat
`CHECK_ERROR` dan keyin tiklanishda yoziladi. Shu tufayli 1000 foydalanuvchida
ham jurnal yiliga yuz minglab yozuv bilan shishmaydi. Instagram uchun `SELF_CONFIRMED` alohida saqlanadi va kredit
bermaydi (`creditRewardInstagramSelfConfirmed` standart 0).

## 3. Uch tekshiruv nuqtasi

**A. Vazifa tasdiqlanganda (darhol).** `verifyBatch()` biriktirilgan 10 ta
vazifani alohida-alohida `getChatMember` bilan tekshiradi, har birining natijasini
(`lastCheckResult`, `checkedAt`, `consecutiveCheckErrors`) yozadi. Faqat
`member` bo'lganlariga `reward_task` tranzaksiyasi (`idempotencyKey: reward:<taskId>`)
beriladi. Bajarilmaganlar `PENDING` holida navbatga qaytadi, xatolar `RECHECK`
bo'lib qoladi.

**B. 24 soatlik qayta tekshiruv.** `applyVerified()` a'zolik yozuvini yaratadi va
`nextCheckAt = now + 24 soat + 0..3 soat jitter` bilan job qo'yadi. Bir a'zolik
uchun faqat bitta ochiq (`PENDING`/`RUNNING`) job bo'ladi: qayta rejalashtirishda
mavjud jobning `scheduledAt` i yangilanadi, dublikat yaratilmaydi. (Ilgari
idempotency kaliti soat oynasi bo'yicha edi va `DONE` bo'lgan eski job kalitni
band qilib, yangi job yaratilmasdan qolardi — a'zolik jimgina kuzatuvdan chiqardi.)
`maintenance()`
har 2 daqiqada `processVerificationJobs()` ni chaqiradi va bir tikda ko'pi bilan
`VERIFY_BATCH` (standart 25) jobni oladi — `scheduledAt` bo'yicha saralab.
Har bir job: tekshir → holatni yoz → keyingi 24 soatlik jobni rejalashtir → `DONE`.
Jarayon qulasa, `RUNNING` job 10 daqiqadan keyin `PENDING` ga qaytadi va navbat
bazada qoladi (restart-safe).

**Kanal uzilganda.** `chdely` kanal yozuvini o'chirmaydi: `status="disconnected"`,
`disconnectedAt` va `lastConfirmedActiveSubscribers` snapshot yoziladi, faol
buyurtmalar bekor qilinib kredit qaytariladi, ochiq vazifalar `CANCELLED` bo'ladi,
shu kanalning `PENDING` monitoring joblari `DONE` ("kanal uzilgan") qilinadi va
a'zolik yozuvlari saqlanadi. Qayta ulanganda o'sha yozuv tiklanadi — tarix
yo'qolmaydi va yangi kanal ulash bonusi takror berilmaydi.

**C. Homiy kanallar.** `sponsorGate()` har chaqiriqda `sponsorMemberships` ga
`MEMBER / NOT_MEMBER / CHECK_ERROR` yozadi. Bu yozuvlar `memberships` bilan
aralashtirilmaydi va 24 soatlik navbatga tushmaydi.

## 4. Scheduler oqimi

```
maintenance()  (har 2 daqiqa)
  ├─ 48 soatdan eski OPEN vazifalarni yopish (eskirgan navbat)
  ├─ recoverStaleJobs(): RUNNING > 10 daqiqa → PENDING
  └─ processVerificationJobs(limit=25)
        ├─ due = PENDING && scheduledAt <= now, saralangan
        ├─ har bir job: RUNNING + lockedAt
        ├─ checkMember(channelId, telegramId)
        │    ├─ member      → ACTIVE, REJOINED/RECHECK_ACTIVE voqeasi
        │    ├─ not_member  → CANCELLED, UNSUBSCRIBED, statistika yangilanadi
        │    └─ error       → holat saqlanadi, backoff bilan qayta navbat
        └─ keyingi 24 soatlik job (idempotencyKey bilan)
```

Cheklovlar va API imkoniyatlari:
- Bot faqat **ma'lum juftlikni** tekshira oladi (`getChatMember`); kanalning
  to'liq obunachilar ro'yxatini Telegram Bot API bermaydi.
- Bot kanalda administrator bo'lishi shart, aks holda natija `error` bo'ladi.
- Instagram uchun rasmiy "kim kimga follow qildi" API yo'q — holat
  `SELF_CONFIRMED` bo'lib qoladi va kredit bermaydi.

## 5. Soatlik xabarnoma

`hourlyReport()` har daqiqada tekshiradi: tugagan soat oralig'idagi
`verifyLog` yozuvlarini egasi bo'yicha guruhlaydi va **bitta** xabar yuboradi.
Idempotentlik `notifPeriods` dagi `userId:periodStart:subscribers` kaliti bilan
ta'minlanadi (xabar yuborilmasa `skipped` deb yoziladi). Bu jarayon hech qanday
a'zolik tekshiruvini ishga tushirmaydi.

Faqat **rasmiy tasdiqlangan** amallar sanaladi (spec §6.4): `verifyLog` yozuvi
`source: "verified" | "self"` maydonini saqlaydi va `self` (Instagram
o'z-o'zini tasdiqlash) hisobotga kirmaydi. Yangi tasdiqlangan obuna bo'lmasa
xabar umuman yuborilmaydi (§6.6), mavjud bo'lmagan platforma qatori ham
ko'rsatilmaydi.

## 5a. Kanal holati va pauza (spec §7)

Kanalning `status` maydoni: `active` | `paused` | `disconnected`.

- **paused** — panelda «Pauza» tugmasi. Yangi vazifa berilmaydi
  (`assignFresh` o'tkazib yuboradi), yangi buyurtma qabul qilinmaydi
  (`prepareOrder`/`createOrderConfirmed` rad etadi). Faol buyurtmalar, navbat,
  a'zoliklar va 24 soatlik monitoring **saqlanadi** — «Davom ettirish” bilan
  hammasi qaytadi.
- **disconnected** — kanal uzilganda: faol buyurtmalar bekor qilinib kredit
  qaytariladi, ochiq vazifalar `CANCELLED`, `PENDING` joblar `DONE`, yozuv va
  `lastConfirmedActiveSubscribers` snapshot qoladi.
- `(userId, channelId)` juftligi uchun **bitta** `memberships` yozuvi
  kafolatlanadi — ishga tushishda `dedupeMemberships()` takror yozuvlarni
  birlashtiradi (joblar qolgan yozuvga bog'lanadi, `membershipEvents`
  o'chirilmaydi).

## 6. Namuna yozuvlar

```json
// memberships
{ "id": "mem-1a2b", "userId": "u-1111", "channelId": "ch-1", "status": "ACTIVE",
  "firstVerifiedAt": "2026-11-14T04:40:00.000Z", "lastCheckedAt": "2026-11-14T04:40:00.000Z",
  "nextCheckAt": "2026-11-15T05:10:00.000Z", "lastCheckResult": "member",
  "consecutiveCheckErrors": 0 }

// verificationJobs
{ "id": "job-77", "membershipId": "mem-1a2b", "userId": "u-1111", "channelId": "ch-1",
  "jobType": "RECHECK", "scheduledAt": "2026-11-15T05:10:00.000Z", "status": "PENDING",
  "attemptCount": 0, "idempotencyKey": "RECHECK:u-1111:ch-1:489000" }

// membershipEvents
{ "eventType": "UNSUBSCRIBED", "oldStatus": "ACTIVE", "newStatus": "CANCELLED",
  "source": "recheck", "apiResult": "not_member" }
```

## 7. Test natijalari

`node data/membership-test.mjs` — mahalliy mock Telegram (`tests/support/mock-telegram.mjs`)
bilan, 32/32 PASS (3 marta ketma-ket barqaror):

| # | Tekshiruv | Natija |
|---|---|---|
| 1 | Vazifalar biriktiriladi | PASS |
| 2 | Obuna bo'lgan vazifa VERIFIED | PASS |
| 3 | Faqat tasdiqlangan vazifaga kredit | PASS |
| 4 | Bajarilmagan vazifa FIFO navbatda qoladi | PASS |
| 5 | Har bir tekshiruv natijasi alohida saqlanadi | PASS |
| 6 | A'zolik yozuvi yaratiladi (ACTIVE) | PASS |
| 7 | 24 soatlik qayta tekshiruv rejalashtiriladi (+24.6 soat) | PASS |
| 8 | FIRST_VERIFIED voqeasi yoziladi | PASS |
| 9 | Takroriy bosishda kredit takrorlanmaydi | PASS |
| 10 | API xatosi CHECK_ERROR, CANCELLED emas | PASS |
| 11 | Xatodan keyin backoff bilan qayta rejalashtiriladi | PASS |
| 12 | Xato obunachilar sonini kamaytirmaydi | PASS |
| 13 | Obunadan chiqish CANCELLED + UNSUBSCRIBED | PASS |
| 14 | Faqat shu kanal statistikasi o'zgaradi | PASS |
| 15 | Kredit qaytarilmaydi (tarix bukilmaydi) | PASS |
| 16 | Qayta obuna REJOINED voqeasi | PASS |
| 17 | Qayta obuna yangi kredit bermaydi | PASS |
| 18 | Instagram SELF_CONFIRMED kredit bermaydi | PASS |
| 19 | 30 ta due job 5 talik partiya bilan ishlanadi | PASS |
| 20 | Restartdan keyin navbat saqlanadi | PASS |
| 21 | Soatlik hisobot davri yoziladi, takrorlanmaydi | PASS |
| 22 | Sponsor a'zoligi alohida jadvalda | PASS |
| 23 | Sponsor yozuvi oddiy a'zolik bilan aralashmaydi | PASS |
| 24 | Kanal uzildi — yozuv va snapshot tarix uchun saqlanadi | PASS |
| 25 | Uzilgandan keyin monitoring to'xtaydi, a'zolik tarixi qoladi | PASS |
| 26 | Holat o'zgarmasa voqea yozilmaydi (jurnal shishmaydi) | PASS |
| 27 | O'zi tasdiqlagan Instagram soatlik hisobotga kirmaydi | PASS |
| 28 | Pauza qilingan kanalga yangi vazifa berilmaydi | PASS |
| 29 | Pauzada buyurtma va navbat tarixi saqlanadi | PASS |
| 30 | Rezyumedan keyin vazifa qayta beriladi | PASS |
| 31 | Bir juftlik uchun bitta a'zolik yozuvi qoladi | PASS |
| 32 | Birlashtirishda job yo'qolmaydi, voqealar saqlanadi | PASS |

Qo'shimcha: `node data/recon.mjs` productionda `Σ tranzaksiya = available`
mosligini tekshiradi.

### Kanal administratorligi va Sozlamalar — `tests/channel-settings.test.mjs`

`npm test` tarkibida ishlaydi (mock Telegram + haqiqiy server jarayoni), 32/32 PASS:

| Guruh | Tekshiruv |
|---|---|
| Kanal | topilmadi · bot admin emas · huquq yetarli emas · sizda huquq yo'q · vaqtinchalik API xatosi · muvaffaqiyat · cheklangan huquq ogohlantirishi |
| Buyurtma | huquq yo'qolgan kanalga buyurtma yaratilmaydi · kredit band qilinmaydi · kanal `permission_lost` · sabab tushuntiriladi |
| Sozlamalar | submenyuda 4 bo'lim · 4 ta bildirishnoma turkumi · xavfsizlik sahifasi · Telegram hisoblari (akkaunt ≠ kanal) · orqaga · asosiy menyu |
| Til | uz → ru → en, har bir sahifa tarjima qilingan |
| Persist | til va bildirishnoma sozlamasi restartdan keyin saqlanadi |

### Tekshiruv nosozliklari — `tests/verify-errors.test.mjs`

`npm test` tarkibida, mock Telegram bilan, **36/36 PASS**:

| # | Tekshiruv | Natija |
|---|---|---|
| 1 | Bitta kanal yiqildi — qolgan 9 tasi tekshirildi va mukofot oldi | PASS |
| 2 | Yiqilgan kanal CHECK_ERROR, CANCELLED emas | PASS |
| 3 | Sabab (`rate_limit`) va xato kodi (429) saqlandi | PASS |
| 4 | `retry_after` (4 s) saqlandi va navbatga hurmat qilindi | PASS |
| 5 | Doimiy `TASK_CHECK` jobi yaratildi | PASS |
| 6 | Xabar "qayta tekshiruv saqlandi" deydi va sababni ko'rsatadi | PASS |
| 7 | Diagnostika: method / chat_id / user_id / task_id saqlandi | PASS |
| 8 | Diagnostika: tavsif umumiy matn bilan almashtirilmadi | PASS |
| 9 | Restartdan keyin job bazada PENDING qoladi | PASS |
| 10 | Qayta urinish foydalanuvchi bosishisiz bajarildi | PASS |
| 11 | Mukofot takrorlanmadi (bitta tranzaksiya) | PASS |
| 12 | 403 → `blocked`, kod 403 | PASS |
| 13 | 400 → `bad_request` | PASS |
| 14 | 500 → `server`, HTTP holati 500 | PASS |
| 15 | 403/400/500 obunadan chiqish deb belgilanmadi | PASS |
| 16 | Tarmoq uzilishi (`fetch failed`) → `network`, vaqtinchalik | PASS |
| 17 | HTTP 502 HTML javobi → `server` + `httpStatus: 502` | PASS |
| 18 | Timeout → `network_timeout`, CANCELLED emas | PASS |
| 19 | 9 member + 1 tarmoq xatosi: 9 tasdiq, 9 ta bir martalik mukofot | PASS |
| 20 | Xato olgan kanal FIFO ro'yxatida qayta ko'rsatilmadi | PASS |
| 21 | Shu kanal uchun ikkinchi vazifa yaratilmadi | PASS |

### SIGTERM tartibi — `tests/shutdown-poll.test.mjs`

**13/13 PASS**: faol long-poll ochiq turganda to'xtatish · abort `poll-aborted`
`poll-start` dan oldin · jarayon `code 0` bilan chiqadi · qulf keyin bo'shaydi ·
butun jarayonda parallel long-poll yo'q.

### Qulf kalitlari — `tests/lock-keys.test.mjs`

**8/8 PASS**: turli tokenlar bir vaqtda polling qiladi (mustaqil qulf) ·
bir xil tokenli uchinchi bot polling qilmaydi va sababni aytadi · bir vaqtda
ko'pi bilan 2 ta long-poll.

### Polling qulfi — `tests/poll-lock.test.mjs`

**10/10 PASS**: ikki instans → faqat bittasi polling qiladi · ikkinchisi
sababni aytadi va logga yozadi · mock parallel `getUpdates` ko'rmaydi ·
SIGTERM'dan keyin qulf o'tadi · SIGKILL (crash) dan keyin o'lik `pid`
aniqlanib qulf o'tadi · crashdan keyin ham parallel so'rov yo'q.

### Retry scheduler — `tests/retry-scheduler.test.mjs`

**18/18 PASS**: muddati kelmagan job bajarilmaydi · muddati kelgan job
bajariladi · parallel ikki trigger jobni bir marta bajaradi · crash bo'lgan
`RUNNING` job tiklanadi · 429 `retry_after` saqlanadi va a'zolik `CANCELLED`
bo'lmaydi · ikki instansda mukofot takrorlanmaydi.

## 8. Kanal administratorligini tekshirish

`getChat` yolg'iz administratorlikni isbotlamaydi — u faqat kanal mavjudligini
ko'rsatadi. Shuning uchun har bir qadam **alohida** tekshiriladi
(`verifyChannelForOwner`):

```
manzil → resolveChannel()            // getChat
         ↓
      inspectBotAdmin()              // getChatMember(bot)
         ↓
      inspectUserRights()            // getChatMember(egasi)
```

Natijalar (`CHK`) — har biri foydalanuvchiga alohida tushuntiriladi:

| Holat | Sabab | Xabar |
|---|---|---|
| `ok` | hammasi o'tdi | kanal faol qo'shildi |
| `bot_not_admin` | bot `left`/`kicked`, yoki `chat_admin_required` | administrator qilish qadamlari |
| `insufficient_permissions` | bot admin, lekin `not enough rights` | kerakli huquqlarni yoqish |
| `channel_inaccessible` | `chat not found`, `not_a_channel`, yopiq kanal | manzilni tekshirish |
| `user_no_rights` | egasi `member`/`left` yoki barcha boshqaruv huquqlari o'chirilgan | faqat o'z kanali / nazoratchi kodi |
| `api_error` | timeout, `5xx`, `429`, tarmoq | "vaqtinchalik, sizda ayb yo'q" |

**Muhim:** `api_error` hech qachon "bot administrator emas" deb talqin
qilinmaydi va kanal holatini o'zgartirmaydi (`tgFailureKind()` transient/
doimiy xatoni ajratadi).

Huquqlar batafsil: bot `administrator` bo'lsa, `permissions.can_invite_users ===
false` bo'lsa kanal **bloklanmaydi**, lekin ogohlantirish beriladi va
`botRightsLimited: true` saqlanadi (a'zolikni o'qish uchun adminlik yetarli).

### Buyurtmadan oldin qayta tekshirish

`createOrderConfirmed()` kredit band qilishdan **oldin** `inspectBotAdmin()` ni
qayta chaqiradi:

- doimiy xato → buyurtma yaratilmaydi, kredit band qilinmaydi, kanal
  `status: "permission_lost"`, egasiga bir marta xabar;
- vaqtinchalik xato → buyurtma davom etadi (taxmin qilib bloklash noto'g'ri).

### Huquq keyin yo'qolsa

`channelHealthSweep()` har 2 daqiqada ishlaydi, lekin har bir kanalni **6 soatda
ko'pi bilan bir marta** va bir partiyada 5 tadan tekshiradi (1000 kanalda ham
Telegram'ga yuklama tushmaydi):

1. `markChannelPermissionLost()` — `botHasAdminRights: false`,
   `status: "permission_lost"`;
2. shu kanalning ochiq vazifalari `CANCELLED` (tarix o'chmaydi);
3. `assignFresh()` bunday kanalga yangi vazifa bermaydi;
4. egasiga bir marta texnik xabar;
5. huquq qaytsa — `status: "active"` va tiklandi xabari.

Vazifa tekshiruvida (`verifyBatch`) doimiy xato (`no_rights`, `not_found`)
ham shu funksiyani chaqiradi, shuning uchun "1 ta kanalni tekshirib bo'lmadi"
endilikda ikki xil ko'rsatiladi: **texnik xato** va **kanal muammosi**.

## 8.1 Xatolarni tasniflash va diagnostika

Har bir muvaffaqiyatsiz Telegram so'rovi `db.verifyErrors` ga **to'liq**
yoziladi va `console.error("[verify-error] {...}")` bilan logga chiqadi.
Umumiy matn ("Telegram API xatosi") xato sababini **almashtirmaydi**.

Yozuv maydonlari: `method, chatId, userId, taskId, orderId, channelDbId, stage,
errorCode, description, httpStatus, retryAfter, errKind, transient, ts`.
(Oxirgi 5000 yozuv saqlanadi; eskilari chiqarib yuboriladi.)

### Tasniflash

| Telegram holati | `errKind` | `transient` | Amal |
|---|---|---|---|
| 401 Unauthorized | `auth` | ha | administratorga xabar (18 soatda 1 marta), obunadan chiqish EMAS |
| 403 (bot kicked / no access) | `blocked` | yo'q | qayta urinish yo'q, sabab egasiga ko'rsatiladi |
| 400 `not enough rights` / `chat_admin_required` | `no_rights` | yo'q | kanal `permission_lost`, egasiga xabar |
| 400 `chat not found` / kanal o'chirilgan | `not_found` | yo'q | kanal `permission_lost` |
| 400 boshqa (noto'g'ri `chat_id`) | `bad_request` | yo'q | CHECK_ERROR, diagnostika saqlanadi |
| 429 `Too Many Requests` | `rate_limit` | ha | **`retry_after` hurmat qilinadi** |
| 5xx yoki HTTP 502/503/504 HTML | `server` | ha | eksponensial backoff |
| Timeout (`AbortSignal`) | `network_timeout` | ha | eksponensial backoff |
| Ulanish uzilishi (`fetch failed`) | `network` | ha | eksponensial backoff |
| Boshqa | `unknown` | yo'q | to'liq diagnostika bilan CHECK_ERROR |

`tgWith()` endi **HTTP holatini** ham o'qiydi: proksi HTML qaytarsa `r.json()`
yiqilmaydi va javob "tarmoq xatosi" deb noto'g'ri tasniflanmaydi.

### Qayta urinish navbati

Vaqtinchalik xato olgan **vazifa** `verificationJobs` ga `jobType: "TASK_CHECK"`
bo'lib yoziladi (ilgari `retryAt` faqat yozilardi va uni hech kim o'qimasdi —
vazifa faqat foydalanuvchi tugmani yana bosganda tekshirilardi).

- `retry_after` berilgan bo'lsa — `retry_after + 1s`;
- aks holda `min(6 soat, 5 daqiqa × 2^urinish)`;
- `maintenance()` har `MAINTENANCE_SEC` (standart 120) soniyada due joblarni
  cheklangan partiya bilan bajaradi → restartdan keyin ham qoladi;
- natija: `member` → mukofot **bir marta** (`reward:<taskId>` idempotentlik
  kaliti), `not_member` → vazifa FIFO navbatiga qaytadi, `error` → yana navbatga.

### Foydalanuvchi xabari

| Holat | Ko'rsatiladi |
|---|---|
| faqat muvaffaqiyat | `verify_ok` |
| doimiy xato | `verify_perm_err` — sabab: bot admin emas / kanal yo'q / bot chiqarilgan |
| vaqtinchalik xato **va** job saqlandi | `verify_retry_saved` — "qayta tekshiruv saqlandi, ~N daqiqadan keyin" |
| vaqtinchalik xato, job saqlanmadi | `verify_temp_err` — "keyinroq o'zingiz qayta bosing" |

Ya'ni "avtomatik qayta tekshiriladi" deb **faqat navbatga haqiqiy yozuv
tushganda** aytiladi. Uch tilda ham mavjud.

### Holat diagrammasi

```
              foydalanuvchi "✅ Obuna bo'ldim" bosdi
                              │
                              ▼
            getChatMember — 10 ta vazifa MUSTAQIL tekshiriladi
         ┌──────────────┬──────────────┬────────────────────┐
         ▼              ▼              ▼                    ▼
      member       not_member      transient            permanent
    (VERIFIED)      (PENDING)     (CHECK_ERROR)        (CHECK_ERROR)
         │              │              │                    │
    mukofot 1×     FIFO navbatga   TASK_CHECK job     kanal permission_lost
                   qaytariladi     (retryAt bilan)     (no_rights/not_found)
                                          │
                                 ┌────────┴────────┐
                            muddat keldi      muddat yo'q
                                 │                 │
                          claim + tekshiruv      kutadi (bajarilmaydi)
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
               member      not_member       error
              (VERIFIED)   (PENDING, FIFO)  (backoff, 6 soatgacha)
               1× mukofot
```

`CHECK_ERROR` **hech qachon** FIFO navbatiga qaytmaydi:
`OPEN = {ACTIVE, PENDING, RECHECK, CHECK_ERROR}` (ichki holat) —
`FIFO = {ACTIVE, PENDING}` (foydalanuvchiga ko'rsatiladi). Shuning uchun
vaqtinchalik xato olgan kanal keyingi partiyada qayta chiqmaydi va shu kanal
uchun ikkinchi vazifa yaratilmaydi. Uni faqat `TASK_CHECK` jobi (yoki
foydalanuvchining qo'lda bosishi) qayta tekshiradi. Faqat Telegram
`not_member` deb javob berganda vazifa FIFO'ga qaytadi.

`repairTaskChecks()` ishga tushishda eski `RECHECK`/`CHECK_ERROR` vazifalari
uchun yetishmayotgan jobni yaratadi — aks holda ular navbatda ham, ko'rinishda
ham osilib qolardi.

## 8.2 Bitta instans kafolati (polling qulfi)

### Aniqlangan sabab

Production loglarida 26 soat ichida **16 marta qayta ishga tushish** va
**5 xil instans ID** (`…-nn7rn`, `…-k49gk`, `…-gwc9v`, `…-lxmzz`, `…-vpxsq`)
ko'rindi. `Conflict: terminated by other getUpdates request` yozuvlari aynan
instans startidan ~100 ms keyin paydo bo'lgan (masalan
`05:17:15.514` "Bot ishga tushdi" → `05:17:15.615` Conflict).

Ya'ni sabab — **bir nechta Render servisi emas** (servis bitta,
`numInstances: 1`), balki **restart paytida eski va yangi instansning
qisqa vaqt ustma-ust ishlashi**: yangi jarayon eski jarayonning 50 soniyalik
long-poll so'rovi tugashini kutmasdan `getUpdates` boshlagan. Telegram eski
so'rovni uzgan. (Bazadagi tokenlar ham tekshirildi — ikki bot ikki xil token
bilan ishlaydi, dublikat token yo'q.)

### Mexanizm

| Saqlash | Qulf | Crashdan tiklanish |
|---|---|---|
| Postgres | `pg_try_advisory_lock(hashtextextended('gxb:poll:<token-sha1>', 0))` — **64-bit** kalit, alohida ulanishda | Ulanish uzilishi bilan Postgres qulfni bo'shatadi |
| Fayl | `data/.lock-<hash>.json` (`id, pid, at`), heartbeat har 25 s | `pid` o'lgan bo'lsa darhol stale (60 s kutmaymiz) |

- `startBotLoop()` qulfni olmasa **`getUpdates` umuman boshlanmaydi**;
  `health` da `online: false`, `lastError: "boshqa instans polling qilmoqda"`.
- Bir xil token ikki bot sifatida qo'shilgan bo'lsa — jarayon ichida ham
  to'xtatiladi (advisory lock bir sessiyada qayta olinadi).
- Heartbeat uzilsa — polling darhol to'xtatiladi (`onLockLost`), chunki
  qulfni boshqa instans olgan bo'lishi mumkin.
- `SIGTERM`/`SIGINT` da faol long-poll **uziladi va tugashi kutiladi**, qulf
  esa faqat shundan keyin bo'shaydi — yangi instans eski so'rov yopilmasdan
  polling boshlamaydi.
- `processVerificationJobs()` ham `scheduler` qulfini oladi: ikki instans bir
  vaqtda bir jobni bajarmaydi. Qo'shimcha himoya — `claimJob()` (holatni qayta
  tekshiradi) va `MAINTENANCE_BUSY` (bir jarayonda ustma-ust tik).

**Kalit:** `pollLockKey(token) = "poll:" + sha1(token)` → `hashtextextended(…, 0)`.
SHA-1 determinist (bir xil token → bir xil kalit), turli tokenlar esa amalda
farqli kalit beradi. `hashtextextended` 64-bit, `hashtext` esa 32-bit edi —
to'qnashuv ehtimoli ancha yuqori.

SQL production Postgres'da tekshirildi: turli tokenlar kaliti farqli,
bir xil token determinist, bir token uchun 1-sessiya `true` / 2-sessiya
`false`, boshqa token mustaqil `true`.

### SIGTERM tartibi (spec A)

```
SIGTERM
  1. botRuns dan chiqariladi        → yangi getUpdates REJALASHTIRILMAYDI
  2. AbortController.abort()        → faol long-poll uziladi (mock: poll-aborted)
  3. botLoops promise kutiladi      → tsikl haqiqatan tugadi (≤6 s)
  4. releaseLock(poll:<sha1>)       → SHUNDAN KEYIN qulf bo'shaydi
  5. holat saqlanadi, pool yopiladi, process.exit(0)
```

Tartib muhim: agar qulf 3-qadamdan oldin bo'shasa, yangi instans eski
long-poll hali ochiq turganda polling boshlaydi va yana `Conflict` paydo
bo'ladi. `tests/shutdown-poll.test.mjs` aynan shu tartibni tekshiradi:
`poll-aborted` yozuvi keyingi `poll-start` dan **oldin** keladi va jarayon
davomida parallel long-poll bo'lmaydi.

## 8.3 Production migratsiyasi va rollback

### Migratsiya ta'siri (deploy paytida)

Deployda bir marta ishlaydigan `repairTaskChecks()`:

1. `RECHECK` va `CHECK_ERROR` holatidagi vazifalarni topadi;
2. mavjud ochiq `TASK_CHECK` jobi bo'lmasa — `retryDelayMs(errs)` bilan
   yangisini yaratadi (dublikat `idempotencyKey` bilan to'siladi);
3. holatni `CHECK_ERROR` ga o'tkazadi (FIFO'da ko'rinmaydi).

Hozirgi productionda bunday vazifalar **4 ta** (`t-mwgmb2sq34`, `…36`, `…38`,
`t-mwgnwsv13l`). Har biri uchun bitta job yaratiladi. Ular:

- `member` → `VERIFIED`, mukofot **bir marta** (`reward:<taskId>`);
- `not_member` → `PENDING` (FIFO navbatiga qaytadi);
- doimiy xato (`no_rights`/`not_found`) → kanal `permission_lost`, vazifa
  `CANCELLED` (`cancelReason: channel_unavailable`) — ya'ni `CHECK_ERROR`
  da abadiy osilib qolmaydi;
- vaqtinchalik xato → backoff bilan yana navbatga (FIFO'ga **kirmaydi**).

Hech qanday foydalanuvchi, balans, buyurtma, a'zolik voqeasi yoki vazifa
tarixi o'chirilmaydi — faqat `status` maydoni o'zgaradi va `verificationJobs`
ga yozuv qo'shiladi.

### Rollback — **hech narsa o'chirilmaydi**

Eski (qulfdan oldingi) kod `jobType` ni ajratmaydi: `TASK_CHECK` jobini oddiy
a'zolik tekshiruvi deb bajaradi va `membershipId` bo'sh bo'lgani uchun
`ensureMembership()` orqali yolg'on a'zolik yozuvini yaratishi mumkin. Jobni
**o'chirish yoki JSON'dan chiqarib tashlash taqiqlanadi** — uning o'rniga
arxivlash ishlatiladi:

```bash
# 1. Arxiv (dry-run) — nima arxivlanishini ko'rsatadi, hech narsa yozmaydi
DATA_FILE=... node scripts/archive-task-check-jobs.mjs

# 2. Ilova TO'XTATILGAN holatda arxivlash:
#    to'liq nusxa arxiv omboriga yoziladi, keyin status → ARCHIVED
DATA_FILE=... node scripts/archive-task-check-jobs.mjs --apply

# 3. Nusxa butunligini tekshirish (faqat o'qiydi)
DATA_FILE=... node scripts/archive-task-check-jobs.mjs verify

# 4. Kerak bo'lsa qaytarish (arxiv yozuvi saqlanib qoladi)
DATA_FILE=... node scripts/archive-task-check-jobs.mjs restore --apply
```

Nima uchun `ARCHIVED` xavfsiz: `processVerificationJobs()` faqat
`status === "PENDING"` joblarni oladi, eski kod ham xuddi shunday filtrlaydi.
Ya'ni status o'zgarishi jobni to'xtatadi, barcha maydonlar esa joyida qoladi.

| Kafolat | Qanday ta'minlanadi |
|---|---|
| Nusxa to'liq | `jobs` — job obyektining aynan nusxasi (barcha maydonlar) |
| Yo'qotish yo'q | `verificationJobs` dan hech qanday yozuv olib tashlanmaydi |
| Solishtirish | `count`, `jobIds`, `checksum = sha1(canon(jobs))` |
| Yozishdan oldin tekshiruv | saqlangandan keyin qayta o'qib, asl bilan bayt-bayt solishtiriladi; mos kelmasa **status o'zgartirilmaydi** |
| Qaytarish | `restore` faqat `status` va arxiv belgilarini qaytaradi; maydonlar tegilmaydi |
| Jim yo'qotishga qarshi | job topilmasa `restore` **bekor qilinadi** (exit 1) |

Saqlash joyi: Postgres'da alohida `verification_job_archive` jadvali
(`id, archived_at, reason, count, checksum, job_ids, jobs`) — shuning uchun
`app_state` ning keyingi saqlanishi arxivni o'chirib yubormaydi. Fayl rejimida
`data/archives/task-check-<vaqt>.json`.

**Muhim:** `--apply` va `restore` `app_state` ga yozadi — ilova **to'xtatilgan**
holda bajarilishi shart, aks holda ilova xotiradagi holatni qayta yozib
arxivga bog'langan belgilarni yo'qotadi (arxivning o'zi baribir saqlanadi).

Boshqa ta'sirlar: `verifyErrors` yangi maydon — eski kod uni e'tiborsiz
qoldiradi; advisory lock qatorlari jarayon o'lishi bilan o'zi bo'shaydi.

## 8.4 Deploy ketma-ketligi (birinchi o'tish)

Birinchi deploy alohida: **eski build qulf haqida hech narsa bilmaydi**.

1. **Zaxira.** `app_state` allaqachon kunlik `app_backup` jadvaliga
   yoziladi (`backupNow`) — deploydan oldin qo'lda ham tekshiring:
   `SELECT count(*), max(created_at) FROM app_backup;`
2. **Baseline (read-only).**
   `node scripts/post-deploy-check.mjs --save-baseline --out data/baseline-pre.json`
3. **Deploy.** Render'da yangi instans ko'tariladi. Eski build qulfni
   bilmagani uchun qisqa ustma-ustlik davrida yana bitta `Conflict` yozuvi
   chiqishi mumkin — bu **kutilgan** va bir martalik. Qulf himoyasi eski
   jarayon o'chgandan keyin to'liq kuchga kiradi.
4. **Kuzatish.** Yangi instans logida:
   - `qulf olindi` (yoki shunga o'xshash) — qulf egasi bo'ldi;
   - `qulf boshqa instansda` — **bo'lmasligi** kerak (bo'lsa: eski jarayon
     hali tirik);
   - `Conflict: terminated by other getUpdates` — takrorlanmasligi kerak.
5. **Bir marta `repairTaskChecks()`** ishlaydi: 4 ta vazifa uchun 4 ta
   `TASK_CHECK` jobi. Logda qayta ishga tushirishda takror yaratilmaydi
   (ochiq job tekshiruvi).
6. **Keyingi restartlar** to'liq himoyalangan: yangi instans qulfni olmaguncha
   `getUpdates` boshlanmaydi.

**Faol polling bittadan ko'p emasligini tasdiqlash:**

- `GET /healthz` → `bots[].online` yig'indisi **≤ 1**;
- `pg_locks` (o'qish-only) — production polling kaliti uchun `granted` advisory
  qulf **1 ta sessiyada** bo'lishi kerak (skript avtomatik tekshiradi);
- Render loglarida `Conflict` soni **0** (deploydan keyingi davr uchun).

## 8.5 Deploydan keyingi tekshiruvlar (faqat o'qiydi)

```bash
node scripts/post-deploy-check.mjs \
  --url https://<servis>.onrender.com \
  --baseline data/baseline-pre.json
```

Skript production ma'lumotiga **yozmaydi** (baseline esa lokal faylga
saqlanadi). Bo'limlari:

| # | Tekshiruv | Kutilgan natija |
|---|---|---|
| 1 | Holat snapshot'i (`users`, `orders`, `tasks`, `transactions`, `memberships`, `membershipEvents`, `verificationJobs`) | deploydan oldingi baseline'dan **kamaymagan** |
| 2 | Qulf mexanizmi probe'i (**alohida tasodifiy `probe:` kaliti**, har doim bo'shatiladi), `pg_locks` orqali production kaliti egalari va `/healthz` `bots[].online` | probe ✓, polling kalitida **1** sessiya, `online` ≤ 1 |
| 3 | Render loglarida `Conflict: terminated by other getUpdates` | **0** (eski jarayon o'chgandan keyin) |
| 4 | `RECHECK`/`CHECK_ERROR` vazifalar va ularning `TASK_CHECK` joblari | har birida **aynan 1** ochiq job, `scheduledAt` kelajakda, `attemptCount` o'sib boradi |
| 5 | Takroriy ochiq joblar (`task:<id>` / `mem:<id>:<turi>`) | **0** guruh |
| 6 | Kredit rekonciliatsiyasi (quyida §8.6), manfiy balans, takror `idempotencyKey` | formula bo'yicha farq yo'q; legacy farq **izohli**, manfiy balans **0** |
| 7 | `membershipEvents` soni baseline bilan | kamaymagan (odatda o'sgan) |

`Conflict` soni va `online` ni qo'lda ham tekshirish mumkin: Render → Logs,
handa `Conflict` bilan qidirish; `/healthz` javobida `bots`.

### 8.6 Kredit rekonciliatsiyasi — matematik izchil formulalar

Amaldagi ombor (`app_state.transactions[]`) **bitta ishorali `amount`** modeli:
har bir yozuv faqat `available` ni o'zgartiradi. `reserved` alohida maydon va
yetkazilgan birlik (`ORDER_FULFILL`) uchun **jurnal yozuvi yo'q**. Shuning uchun:

```
reservation : available -= C, reserved += C, tx amount = -C   (order_spend)
reward      : available += R,                    tx amount = +R   (reward_task)
fulfil      : reserved  -= u, spent += u,        JURNAL YO'Q
refund      : available += X, reserved -= X,     tx amount = +X   (order_refund)
```

To'g'ri formulalar (`C = Σ|order_spend|`, `X = Σ order_refund`):

```
available = Σ amount                       (barcha yozuvlar bo'yicha)
reserved  = C − X − spent
 total    = available + reserved
```

`Σ amount` **total emas** — reservation totalni o'zgartirmaydi. `reserved` esa
`amount` dan yolg'iz chiqarilmaydi, chunki fulfil jurnalga yozilmaydi.

Misollar (boshlang'ich 0, kirim 1000 kredit):

| # | Amal | available | reserved | total | Σ amount |
|---|---|---|---|---|---|
| 1 | boshlang'ich (10 ta `reward_task`) | 1000 | 0 | 1000 | 1000 |
| 2 | reservation 600 | 400 | 600 | **1000** | 400 |
| 3 | `TASK_REWARD` +100 | 500 | 600 | 1100 | 500 |
| 4 | 2 birlik yetkazildi | 500 | 598 | 1098 | 500 |
| 5 | bekor qilish (qaytim 598) | 1098 | 0 | 1098 | 1098 |
| 6 | `REVERSAL` −100 (`admin_adjustment`) | 998 | 0 | 998 | 998 |

Maqsadli (delta) sxema `credit_transactions` paydo bo'lganda skript avtomatik
ikkinchi modelni ham tekshiradi:

```
available = opening_available + Σ available_delta
reserved  = opening_reserved  + Σ reserved_delta
total     = available + reserved        (reservation: −C/+C → total o'zgarmaydi)
```

**Hech qanday balans avtomatik tuzatilmaydi.** Farq topilsa skript faqat
sababni ko'rsatadi (`idempotencyKey` yo'q legacy yozuv, `signup_bonus` jurnalda
yo'q, `spent` ziddiyati, bepul birliklar). Bu ataylab shunday: muvofiqlikni
"yashil" qilish uchun ma'lumotni o'zgartirish taqiqlanadi.

#### Tekshiruvning xavfsizligi

| Talab | Bajarilishi |
|---|---|
| Probe **alohida** kalit | `probe:<tasodifiy 32 hex>`, har chaqiruvda yangi; `poll:` kaliti **olinmaydi** |
| Probe har doim bo'shatiladi | olish/bo'shatish **bitta ajratilgan klientda** (`advisory lock` sessiyaga bog'liq); `finally` da `pg_advisory_unlock`, u yiqilsa `pg_advisory_unlock_all()`; klient `release()` |
| Production kaliti faqat o'qiladi | `pg_locks` so'rovi: `classid = (k >> 32) & 0xFFFFFFFF`, `objid = k & 0xFFFFFFFF` — qulf **olinmaydi** |
| Biznes-ma'lumot o'zgarmaydi | faqat `SELECT`; yagona yozuv — lokal baseline fayli |
| Baseline bir xil baza/qoidalar | baseline `storage` va `dbIdentity` (host/baza nomi, parol emas) + `countsSchema: 2` saqlaydi; mos kelmasa solishtirish **bekor qilinadi** |

## 8.6 Tasdiqlashning atomarligi va idempotentligi (`applyVerified`)

Bir vazifa uchun mukofot **aynan bir marta** beriladi. Himoya qatlamlari:

| # | Qulf | Harakat |
|---|---|---|
| 1 | `task.status ∈ {VERIFIED, SELF_CONFIRMED, CANCELLED}` | funksiya darhol `0` qaytaradi — mavjud `VERIFIED` hech qachon `CANCELLED` ga qayta yozilmaydi |
| 2 | `APPLYING_TASKS` (id bo'yicha) | bir tick ichidagi ikkinchi chaqiruv hech narsa qilmaydi |
| 3 | `reward:<taskId>` — **yagona** idempotency kaliti | jurnalda yozuv bo'lsa funksiya balansga tegmaydi |
| 4 | jurnal yozuvi **birinchi** | `addTx` `false` qaytarsa, quyidagi hech bir hisoblagich o'zgarmaydi |
| 5 | `try/catch` + snapshot | istisno bo'lsa jurnal, hamyon, buyurtma, vazifa, a'zolik, joblar va loglar chaqiruvdan oldingi holatga qaytariladi |

Bir operatsiyada (sinxron, `await` yo'q) o'zgaradi: `transactions[]` yozuvi,
`credits.available`, `credits.reserved`, `credits.spent`,
`order.verifiedQuantity`, `order.pendingQuantity`, `task.status`,
`task.verifiedAt`, a'zolik yozuvi va 24 soatlik job.

Ikki kod yo'li ham **ayni shu** funksiyani chaqiradi:

- foydalanuvchi tugmasi — `verifyBatch()`;
- doimiy qayta urinish — `runTaskCheckJob()`.

Ular bir vazifa uchun bir vaqtda ishlamasligi uchun `verifyBatch()` navbatchi
ro'yxatdan `CHECK_ERROR` vazifalarni **chiqarib tashlaydi** (spec §2): ularni
faqat `TASK_CHECK` jobi tekshiradi. Job tomonida ham qo'shimcha
`status !== VERIFIED` tekshiruvi qoladi.

Isbot: [`tests/apply-verified.test.mjs`](../tests/apply-verified.test.mjs) — 54
tekshiruv, funksiyalar **haqiqiy `server.js` manbasidan** (`vm`) olinadi, mock
algoritm emas. Qamrov: takroriy chaqiruv, 20 parallel chaqiruv, jurnal
yozilgandan keyingi xatolik (to'liq rollback), `VERIFIED` dan keyingi chaqiruv,
`SELF_CONFIRMED` (mukofot yo'q), ikki vazifa — bitta buyurtma, refund bilan
ketma-ket/parallel ishlash, bepul birliklar, har testda ledger ↔ hamyon tengligi.

Eski xatti-harakat (HEAD) va yangi kod bir xil ssenariyda:

```
ESKI : available=200  ledger=100  drift=+100  verifiedQuantity=2
YANGI: available=100  ledger=100  drift=0     verifiedQuantity=1
```

## 8.7 Ishchi botlar ham administratorlikni tekshiradi

Ilgari faqat joriy kontekstdagi bot tekshirilardi va `botId` bo'sh bo'lsa asosiy
botning id'si ishlatilardi — ishchi bot boshqa bot haqida xulosa chiqarardi.
Endi har bir bot **o'z tokeni va o'z `botId` si** bilan tekshiriladi:

| Funksiya | Vazifasi |
|---|---|
| `inspectBotAdminFor(bot, chatId)` | bitta bot: `getChatMember(botId)` → `creator` / `administrator` / `no_bot` / `api_error` |
| `inspectAllBotsAdmin(chatId)` | asosiy + barcha yoqilgan ishchi botlar, bir vaqtda 3 tadan ko'p emas |
| `botAdminSnapshot()` | natija kanalga `botAdmins: { <botId>: { ok, status, limited, reason, checkedAt } }` ko'rinishida yoziladi |
| `botsMissingAdmin()` | administrator bo'lmagan botlar ro'yxati (vaqtinchalik xato hisobga olinmaydi) |

Qoidalar:

1. **Kanal ulash** — hal qiluvchi tekshiruv asosiy bot; ishchi botlarning holati
   ham darhol tekshiriladi va yetishmasa `ch_bots_missing` ogohlantirishi beriladi
   (kanal tarixi saqlanadi).
2. **Buyurtma yaratish** — barcha botlar qayta tekshiriladi. Biror bot doimiy
   ravishda admin bo'lmasa, buyurtma **yaratilmaydi** va kredit band qilinmaydi;
   foydalanuvchiga qaysi botlar yetishmayotgani aytiladi.
3. **6 soatlik sweep** — har bir kanal uchun barcha botlar tekshiriladi. Kanal
   faqat **asosiy bot** huquqni yo'qotganda `permission_lost` bo'ladi (ishchi
   botdagi yetishmovchilik kanalni va tarixni o'chirmaydi); har bir yangi
   yetishmovchilik ro'yxati uchun egasiga bir marta texnik xabar yuboriladi.
4. Vaqtinchalik API xatosi hech qachon "bot admin emas" degan xulosa bermaydi va
   `botsMissingAdmin` ro'yxatiga kirmaydi.

Isbot: [`tests/worker-bots-admin.test.mjs`](../tests/worker-bots-admin.test.mjs) —
19 tekshiruv (real server + mock Telegram, ikki xil token/botId): kanal ulashda
ikkala bot tekshiriladi, ishchi botsiz buyurtma bloklanadi, sweep har bir botni
ko'radi, ishchi bot qo'shilgach keyingi tekshiruv `ok` beradi va buyurtma
kreditni band qiladi.

## 8.8 Crash-safety: saqlash mexanizmi va atomarlik chegarasi

### Saqlash oqimi (aynan kod bo'yicha)

```
applyVerified(u, t)         ← sinxron, `await` YO'Q, `save()` chaqirmaydi
  ├─ addTx()                → FAQAT xotirada: db.transactions.push(...)
  ├─ credits.available/reserved/spent    → xotirada
  ├─ order.verifiedQuantity, task.status → xotirada
  └─ return reward
        │
   (handler oxirida)  save()  → 500 ms debounce timer
        │                       └─ saveNow(): data/db.json.tmp yozish → rename()
        └─ persist()            → app_state (id=1) jsonb — bitta qator, bitta UPDATE
```

Muhim xulosalar:

1. `addTx()` **diskka yozmaydi** — u faqat xotiradagi jurnalga qo'shadi.
2. `save()` **debounced** (500 ms) va `setTimeout` orqali ishlaydi. Operatsiya
   sinxron bo'lgani uchun taymer uning **o'rtasida otilmaydi** (JS bitta oqim).
   Test buni tasdiqlaydi: operatsiya davomida `save()` chaqiruvlari = 0,
   taymerlar soni = 0.
3. `saveNow()` butun hujjatni **tmp + rename** bilan yozadi — fayl hech qachon
   yarim holatda qolmaydi. `persist()` esa `app_state` ning bitta qatorini
   yozadi (atomar).

### Crash stsenariylari

| Nuqta | Xotirada | Diskda | Natija |
|---|---|---|---|
| Jurnal yozildi, balans hali yo'q | +tx, balans eski | eski holat | operatsiya butunlay yo'q — **drift yo'q** |
| `available` o'zgardi | qisman | eski holat | yuqoridagi kabi |
| `reserved`/`spent` o'zgardi | qisman | eski holat | yuqoridagi kabi |
| `task.status = VERIFIED` | qisman | eski holat | yuqoridagi kabi |
| `checkOrderComplete()` | qisman | eski holat | yuqoridagi kabi |
| `save()` dan keyin | to'liq | to'liq | hammasi joyida, takroriy tasdiqlash 0 |
| Fayl yozish yarim yo'lda yiqildi | to'liq | **eski**, buzilmagan | keyingi `save()` qayta yozadi |

Ya'ni **crash hech qachon drift qoldirmaydi**, chunki saqlanadigan birlik —
butun hujjat, va u faqat operatsiya tugagach yoziladi. Narxi: crash bo'lsa
tugallangan operatsiya ham yo'qolishi mumkin (drift emas, **durability** oynasi).

### Snapshot rollback ≠ crash himoyasi

`applyVerified()` ichidagi `try/catch` snapshot rollback faqat **runtime
xatolarini** (istisno, `addTx` yozuvi yiqilishi) qoplaydi: xotira tirik, shuning
uchun orqaga qaytarish mumkin. Jarayon o'lsa xotira yo'q — u holda hech narsa
qaytarilmaydi, lekin diskdagi holat ham o'zgarmagan bo'ladi. Ikkalasi birgalikda
"yoki hammasi, yoki hech narsa" beradi.

### Durability oynasini yopish (lokal tuzatish)

Xabar yuborilgandan keyin 500 ms ichida crash bo'lsa, foydalanuvchi "+100 kredit"
ko'rgan, lekin mukofot yo'qolardi. Shuning uchun pul amalidan keyin, **xabardan
oldin** darhol yozish qo'shildi (`flushSave()` — taymerni bekor qilib, `saveNow()`
+ `persist()` bajaradi):

| Joy | Funksiya | Shart |
|---|---|---|
| `verifyBatch()` | `flushSave()` | `earned > 0` yoki avto-buyurtma yaratildi |
| `createOrderConfirmed()` | `flushOrRollback()` | reservationdan keyin |
| `cancelOrder()` | `flushOrRollback()` | refunddan keyin |
| `cancelOrderAdmin()` | `flushOrRollback()` | admin bekor qilishida |
| `/addcredits`, panel `user.credits` | `applyAdminAdjust()` | admin tuzatishida |
| `grantSignupBonus()` | `flushOrRollback()` | ro'yxatdan o'tish sovg'asida |
| `grantChannelLinkBonus()` | `flushOrRollback()` | kanal ulash sovg'asida |
| `tryQualifyReferral()` | `flushOrRollback()` | referal bonusida |

**Saqlash xatosi = muvaffaqiyat xabari yo'q.** `saveNow()` endi `false`
qaytaradi; `flushOrRollback(rollback)` yozuv yiqilsa hamyon/jurnal/buyurtma
o'zgarishini qaytaradi va chaqiruvchi foydalanuvchiga `save_err` xabarini
yuboradi (bildirishnoma yuborilmaydi). Panel endpointi esa xato qaytaradi.

### Halol cheklovlar

- Har `flushSave()` butun JSON hujjatni qayta yozadi (yozuv kattalashuvi).
  100–1 000 foydalanuvchida maqbul, 100 000+ da normalizatsiya kerak.
- `app_state` — bitta qator: qator darajasidagi atomarlik bor, lekin haqiqiy
  tranzaksiya (bir nechta jadval, `credit_wallets` + `credit_transactions`)
  uchun PostgreSQL tranzaksiyasi kerak. Bu **migratsiya bosqichi**
  ([PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) §3–§4) va hozir
  bajarilmagan.
- Fayl rejimida `rename()` atomarligi fayl tizimiga bog'liq (POSIX/NTFS —
  atomar; tarmoq diski (NFS) kafolat bermaydi). Production `app_state`
  ishlatadi.
- Ikki instans bir vaqtda yozsa — advisory lock buni to'sadi; fayl rejimida
  qulf fayl orqali.

Isbot: [`tests/crash-safety.test.mjs`](../tests/crash-safety.test.mjs) — 44
tekshiruv, haqiqiy `applyVerified` / `addTx` / `saveNow` / `save` / `flushSave`
(`vm`), taymer qo'lda otiladi, fayl haqiqiy `fs` bilan yoziladi.

### Admin tuzatishi (`admin_adjustment`)

Ilgari ikki joyda (`/addcredits`, panel) `available = Math.max(0, ... + n)`
qilinardi: manfiy qoldiqda balans **klamplenardi**, jurnalga esa to'liq summa
yozilardi — natijada balans va jurnal farq qilardi. Endi `adminAdjust()`:

- manfiy qoldiqqa olib keladigan tuzatishni **rad etadi** (jurnal yozilmaydi);
- balans va jurnalni birga, bitta sinxron blokda yangilaydi;
- `idempotencyKey` berilsa takroriy so'rovni ikkinchi marta qo'llamaydi:
  panel `client_token` yuboradi, bot buyrug'i ixtiyoriy kalit qabul qiladi.
- Kalitsiz chaqiruv **at-least-once** bo'lib qoladi (hujjatlashtirilgan cheklov).

Isbot: [`tests/admin-adjust.test.mjs`](../tests/admin-adjust.test.mjs) — 20 tekshiruv.

## 8.9 Pre-deploy tuzatishlari (F1, F2, F4, F5)

### F1 — pul amallarida `flushSave` tartibi

Ilgari to'rt joyda pul o'zgarishi `save()` (500 ms debounce) bilan qolardi:
`signup_bonus`, `channel_link_bonus`, `/addcredits`, `cancelOrderAdmin`.
Endi hammasi `flushOrRollback(...)` orqali **xabardan oldin** yoziladi;
yozuv yiqilsa o'zgarish qaytariladi. Bir martalik sovg'alar alohida
funksiyalarga chiqarildi: `grantSignupBonus(u)`, `grantChannelLinkBonus(u, ch)`
(qaytaradi: summa / `0` — berilmagan / `-1` — saqlanmadi).

### F2 — buyurtma `client_token`

`prepareOrder()` har bir tasdiqlash uchun `crypto.randomBytes(8)` (16 hex)
kalit yaratadi, `u.state.token` va `db.orderTokens[token]` ga yozadi;
inline tugma `ordok:<token>` yuboradi.

| Qoida | Kod |
|---|---|
| Kalit majburiy | `claimOrderToken()` `^[0-9a-f]{16}$` bo'lmasa rad etadi |
| Foydalanuvchiga bog'langan | `rec.userId === u.id` |
| Manzil/miqdorga bog'langan | `rec.destId`, `rec.qty` mos bo'lishi shart |
| Atomar da'vo | `rec.inflight = true` — **`await` dan oldin**, sinxron blok |
| Takroriy so'rov | `rec.orderId` bo'lsa **mavjud** buyurtma qaytariladi, yangisi yaratilmaydi |
| Parallel so'rov | `inflight` bo'lsa "yaratilmoqda" xabari — ikkinchi reservation yo'q |
| `u.state` himoyasi | saqlanadi, lekin **yagona** himoya emas |

Reservationdan keyin `flushOrRollback()`: saqlanmasa buyurtma, kredit va
hisoblagichlar qaytariladi, token bo'shatiladi.

### F5 — refundda `reserved` tekshiruvi

`Math.max(0, reserved - refund)` **olib tashlandi**. Endi `cancelOrder()` va
`cancelOrderAdmin()`:

1. `refundCredits > 0 && reserved < refundCredits` → amal **rad etiladi**,
   balans/jurnal/buyurtma o'zgarmaydi, `auditLog` ga
   `refund_rejected` + `reserved_insufficient` diagnostikasi yoziladi;
2. shu buyurtma uchun `refund:<orderId>` yozuvi mavjud bo'lsa → `duplicate`,
   hech narsa o'zgarmaydi;
3. yopilgan buyurtma → `already_closed`;
4. saqlash yiqilsa → to'liq rollback (`save_failed`), xabar yo'q.

Avtomatik balans tuzatish **yo'q** — faqat diagnostika.

### F4 — referal: yagona hamyonga 300 kredit

Oldingi kod referal bonusini **bepul birlik** sifatida foydalanuvchi kanaliga
buyurtma qilib qo'yardi (spec §12 talqini: `pendingRefBonus` +
`allocateRefBonus()`). Yakuniy talab bo'yicha malakali referal bonusi bitta
umumiy (Telegram + Instagram) hamyonga **300 kredit** sifatida tushadi:

- `addTx(referrer, 300, "REFERRAL_REWARD", ..., { idempotencyKey: "refreward:<refId>" })`;
- `ref.bonusIssued = true` — **bir marta** (takroriy chaqiruv qo'shmaydi);
- o'zini referal qilish (`referrerId === referredUserId`) va bloklangan
  referrer rad etiladi;
- malakalantirish faqat **haqiqiy `getChatMember` tekshiruvidan o'tgan oddiy
  Telegram vazifasidan** (`applyVerified`) chaqiriladi — `SELF_CONFIRMED`,
  Instagram va `CHECK_ERROR` bonus bermaydi;
- bepul reklama birliklari **berilmaydi** — `pendingRefBonus` to'ldirilmaydi;
- `defaultSettings().creditRewardReferral = 300` (admin panelda o'zgartiriladi;
  bazada saqlangan qiymat ustuvor).

`allocateRefBonus()` **o'chirilmadi**: eski (deploygacha bo'lgan) `pendingRefBonus`
yozuvlari uchun `refa:` oqimi ishlashda qoladi — ma'lumot yo'qolmaydi.

Isbot: [`tests/predeploy-fixes.test.mjs`](../tests/predeploy-fixes.test.mjs) —
88 tekshiruv (haqiqiy `server.js` funksiyalari, `vm`, disk xatosi inyeksiyasi)
va [`tests/channel-settings.test.mjs`](../tests/channel-settings.test.mjs) —
real server: kalitsiz `ordok` buyurtma yaratmaydi, 20 ta bir xil tasdiqdan
bitta buyurtma va bitta reservation.

## 9. Sozlamalar menyusi

Reply keyboard saqlanadi (2 ustun). Sozlamalar — haqiqiy submenyu:

```
⚙️ Sozlamalar
├── 🌐 Til: uz / ru / en        (inline, darhol saqlanadi)
├── 🔔 Bildirishnomalar
│   ├── Yangi obunachilar / Referal / Buyurtma / Texnik
│   ├── Soatlik hisobot
│   └── Hammasini yoqish / o'chirish
├── 🛡 Hisob xavfsizligi
│   ├── holat, oxirgi faollik
│   ├── xavfsizlik bildirishnomalari — doim yoniq (o'chirilmaydi)
│   └── 🚨 Shubhali kirish haqida xabar → ticket
├── 📱 Telegram hisoblari
│   ├── shaxsiy akkaunt (ID, username, ism, til)
│   └── bog'langan kanallar: rol (egasi/nazoratchi) + bot huquqi
├── 📊 Kredit qoidalari
├── 👤 Ma'lumotlarim
├── 🛟 Adminga murojaat / Murojaatlarim
└── ⬅️ Orqaga · 🏠 Asosiy menyu
```

Har bir ichki sahifada `⬅️ Orqaga` (Sozlamalarga) va `🏠 Asosiy menyu` (reply
keyboard) bor. Placeholder tugma yo'q: har bir tugma haqiqiy amal bajaradi.
Sozlamalar `users.notif` / `users.language` da saqlanadi — restartdan keyin
qoladi.

## 10. Operatsion buyruqlar

- `GET  /api/admin/health` — memberships/queue statistikasi + `verifyErrors
  { total, recent[] }` (oxirgi 10 nosozlik, haqiqiy Telegram javobi bilan)
- `POST /api/admin/jobs {"action":"verify","limit":25}` — navbatni qo'lda ishlatish
- `POST /api/admin/jobs {"action":"hourly"}` — soatlik hisobotni qo'lda ishga tushirish

## 11. PostgreSQL rejimida saqlash aniqligi

Postgres rejimida pul amali uchun "bajarildi" xabari faqat yozuv HAQIQATAN
bazaga tushgandan keyin yuboriladi.

Muammo (tuzatildi): `saveNow()` `dbPool` mavjud bo'lsa darhol `true`
qaytarardi, `persist()` esa xatoni yutardi. Shu sabab `flushSave()` — demak
`flushOrRollback()` ham — Postgres'da hech qachon qaytarmasdi (faqat fayl
rejimida ishlardi).

Endi:

- `persist()` yozuv natijasini `true/false` ko'rinishida qaytaradi; zanjir
  (`dbChain`) rad etilmaydi, shuning uchun bitta xato keyingi yozuvlarni
  bloklamaydi.
- `flushSaveAwaited()` — pul yo'llari uchun: Postgres'da yozuvni KUTADI,
  fayl rejimida sinxron `saveNow()`.
- `flushOrRollback()` `async`: yozuv yiqilsa rollback bajariladi va `false`.
- `applyAdminAdjust`, `grantChannelLinkBonus`, `tryQualifyReferral`,
  `cancelOrderAdmin`, `cancelOrder`, `createOrderConfirmed`,
  `runTaskCheckJob`/`verifyBatch` — hammasi `await` bilan chaqiriladi.
- Ro'yxatdan o'tish sovg'asi `getUser()` (sinxron) ichidan chiqarildi:
  `getUser()` faqat `signupPending` bayrog'ini qo'yadi, sovg'a
  `handleMessage`/`handleCallback` ichida `await grantSignupBonus(u)` bilan
  beriladi.

### 11.0 Tasdiqlash (verifyBatch / TASK_CHECK) — to'liq rollback

Ilgari `verifyBatch()` saqlash yiqilganda xotiradagi mukofotni qoldirardi:
foydalanuvchi `save_err` olardi, lekin keyingi ALOQASIZ `save()` bu
tasdiqlanmagan mukofotni bazaga yozib yuborishi mumkin edi.

Endi ikkala yo'l ham (`verifyBatch`, `runTaskCheckJob`) mutatsiyadan oldin
`verifyRollbackSnapshot()` oladi va saqlash yiqilsa
`verifyRollbackApply()` bilan quyidagilarni qaytaradi:

- foydalanuvchi `credits` (available/reserved/spent/verifiedRewards), hisoblagichlar;
- task holati (`VERIFIED` → avvalgi `PENDING`/`CHECK_ERROR`);
- order `verifiedQuantity` / `pendingQuantity` / `freeUnits` / `status`;
- kanal hisoblagichlari (verified/active/pending);
- referal yozuvi va referrer balansi;
- yangi yaratilgan a'zolik, job, avtobuyurtma yozuvlari olib tashlanadi;
- `transactions` / `membershipEvents` / `verifyLog` kesiladi.Tiklash `restoreInto()` bilan **obyektni almashtirmasdan** bajariladi, shuning uchun bir vaqtda ishlayotgan boshqa handler'larning yozuvlari yo'qolmaydi.
Referal bildirishnomasi ham kechiktiriladi (`tryQualifyReferral(u, { defer })`)
va faqat yozuv muvaffaqiyatli bo'lgandan keyin yuboriladi.

### 11.0.1 Operatsiya ID bo'yicha rollback (concurrency)

Ilgari `db.transactions` / `membershipEvents` / `verifyLog` rollback'da
**uzunlik bo'yicha** qisqartirilardi — persist kutish paytida boshqa handler
yozgan yozuv ham o'chib ketardi.

Endi har bir pul amali `opStart()` bilan operatsiya ID oladi va yozuvlar shu ID
bilan belgilanadi (`addTx`, `membershipEvent`, `ensureMembership`,
`scheduleTaskCheck`, `scheduleMembershipCheck`, `autoOrderFromBalance`,
`applyVerified` → `verifyLog`). `opSet(op)` faqat **sinxron mutatsiya bloki**
uchun o'rnatiladi (tarmoq kutilmaydi), `await` dan oldin qaytariladi.
Rollback `dropOpRows()` orqali faqat `x.opId === snap.op` yozuvlarni olib
tashlaydi.

Qo'shimcha: `withSaveLock()` — saqlash + rollback bitta qulf ostida bajariladi,
shuning uchun xato bo'lgan operatsiya hali xotirada qaytarilmaganda boshqa
yozuv shu oraliq holatni bazaga ko'chirib qo'ymaydi. `flushSaveAwaited()` faqat
shu qulf ichida chaqiriladi (u `persistNow()` ishlatadi — qayta qulf olinmaydi),
oddiy `persist()` esa qulf orqali ishlaydi.

`TASK_CHECK` jobida saqlash yiqilsa job `PENDING` ga qaytadi, `attemptCount`
osadi va backoff bilan qayta rejalashtiriladi — mukofot keyin beriladi.

### 11.1 Haqiqiy PostgreSQL testlari

`tests/pg-persist.test.mjs` (33), `tests/pg-referral-e2e.test.mjs` (39),
`tests/pg-verify-rollback.test.mjs` (27) va
`tests/pg-concurrency-rollback.test.mjs` (33)
`embedded-postgres` bilan vaqtinchalik PG 18 serverni ko'taradi
(`data/pg-*`, port 55800/55810) va haqiqiy `server.js` jarayonini ishlatadi:

- `app_state` jadvalini nomini o'zgartirib persist xatosi sun'iy yuzaga
  keltiriladi: balans, reservation, buyurtma va jurnal qaytarilishi tekshiriladi;
- ikki PG ulanishi + ikki server instansi bilan advisory lock (probe ALOHIDA
  kalit ishlatadi, production kaliti tegilmaydi);
- SIGKILL → qayta ishga tushirish → balans ↔ ledger drift yo'qligi;
- referal: `runTaskCheckJob` → `tryQualifyReferral` → bitta
  `REFERRAL_REWARD` +300 (SELF_CONFIRMED/Instagram/CHECK_ERROR bermaydi);
- buyurtma: 20 parallel + kechikkan + mismatch + boshqa foydalanuvchi tokeni;
- refund: `reserved < refund` ikkala yo'lda ham rad etiladi;
- verifyBatch signup: persist xatosi → mukofot/bonus qaytariladi, keyingi
  aloqasiz `save()` ularni yozib yubormaydi;
- concurrency: `app_state` ga BEFORE trigger orqali persist xatosi in'ektsiya
  qilinadi (`pg_sleep` + `RAISE`, hisoblagich — sequence, ya'ni tranzaksiya
  bekor bo'lsa ham qaytmaydi). Persist kutish oynasida boshqa handler yozgan
  reward / membershipEvent / verifyLog / membership **saqlanib qoladi**; bu
  verifyBatch, TASK_CHECK job va ikkita parallel verifyBatch uchun tekshiriladi.

`tests/save-audit.test.mjs` (86) — statik audit: money funksiyalar `async`,
`flushOrRollback`/`flushSaveAwaited` chaqiruvlari `await` bilan, sinxron
`flushSave()` faqat login guard'ida, `persist()` xatoni yutmaydi,
`withStateTx`/CAS/merge va har bir pul yo'lining tranzaksiya ichidaligi.

Bu testlar production bazasiga ulanmaydi va deploy talab qilmaydi.

### 11.2 KO'P INSTANS: `app_state` uchun instanslararo tranzaksiya

`withSaveLock()` faqat bitta Node.js jarayoni ichida ishlaydi. Ikki instans
(bir nechta Render instansi, panel + bot jarayoni, deploy oynasidagi eski va
yangi build) bir vaqtda pul yozsa, butun JSON hujjatni yozish "oxirgi yozuvchi
yutadi" xatariga ega edi: bir instansning krediti ikkinchisining eski nusxasi
bilan o'chib ketishi mumkin edi.

Endi pul yo'llari **`withStateTx()`** orqali bajariladi:

1. `gxb:state` — PostgreSQL advisory lock (`hashtextextended`, 64-bit) alohida
   ulanishda olinadi. Kalit polling kalitlaridan (`gxb:poll:<sha1>`) va
   scheduler kalitidan (`gxb:scheduler`) **alohida**, shuning uchun ular
   bir-birini bloklamaydi. Ulanish uzilsa Postgres qulfni o'zi bo'shatadi.
2. Qulf ostida holat **qayta o'qiladi** (`syncDown()`) va xotiraga **joyida**
   ko'chiriladi (`liveSync()`) — `db`, `db.users[id]` va massiv elementlarining
   obyekt identifikligi saqlanadi, shuning uchun ishlab turgan handler ushlab
   turgan havolalar (`u`, `t`, `o`) yangi qiymatlarni ko'radi. Tekshiruvlar
   (balans, `reserved` yetarliligi, takroriy reward/refund, token bandligi)
   **eng so'nggi holat** bo'yicha bajariladi — eski snapshot bilan emas.
3. Yozuv `rev` ustuni bo'yicha **CAS** bilan: `UPDATE ... WHERE id = 1 AND rev = $2`.
   Eski nusxa 0 qator oladi va `false` qaytaradi (jimgina bosib ketmaydi).
4. Qulf olinmasa (`lock_timeout` / `no_conn`) yoki holat o'qilmasa, pul amali
   **bajarilmaydi** va `save_failed` qaytadi — foydalanuvchiga yolg'on
   muvaffaqiyat xabari yuborilmaydi.

Oddiy (pul bo'lmagan) yozuvlar ham qulf ostida bajariladi, lekin ular uchun
**uch tomonlama merge** ishlaydi (`mergeTop` / `mergeList` / `mergeRecord`):
`base` = oxirgi kelishilgan holat, `ours` = xotira, `theirs` = baza. Shu bilan
bir instansning sozlama/status yozuvi boshqa instansning kredit yozuvini bosib
ketmaydi; bir xil yozuvning turli maydonlari ham birlashadi. Bir xil maydonni
ikkala instans o'zgartirsa — oxirgi yozuvchi yutadi (pul maydonlarida bunga
qulf yo'l qo'ymaydi).

Qamrov: `applyAdminAdjust`, `grantSignupBonus`, `grantChannelLinkBonus`,
`tryQualifyReferral` (yadro: `qualifyReferralCore`), `verifyBatch` mutatsiya
bloki, `runTaskCheckJob` reward bloki, `createOrderConfirmed` +
`createOrderConfirmedInner` reservation bloki, `cancelOrder`,
`cancelOrderAdmin`, `autoOrderFromBalance` chaqiruvlari (showTasks, addChannel,
startup) va oddiy `persist()`.

Buyurtma tokeni ikki instans uchun ham yagona: `rec.claimBy` + 60 sekundlik
lease. Boshqa instans band qilgan bo'lsa, ikkinchisi reservation qilmaydi
(`ord_inflight`); lease eskisa (crash) qayta olinadi.

**Test:** `tests/pg-multi-instance.test.mjs` (34) — ikkita mustaqil
`server.js` jarayoni (5631 / 5632), bitta PG 18, bitta mock Telegram:

| Ssenariy | Natija |
|---|---|
| 20 parallel balans o'zgarishi (10 ta har instansda) | barchasi qo'llanadi, 20 ta jurnal yozuvi, drift 0 |
| bir vazifa uchun reward: tugma (poller) + job (ikkinchi instans) | aynan 1 reward, 1 `VERIFIED`, `verifiedQuantity=1`, bitta a'zolik |
| bir orderni ikki instans bekor qiladi | aynan 1 qaytim yozuvi, `reserved` bir marta kamayadi |
| instans A persist xatosiga uchraydi, B yozadi | A qaytariladi, B ning krediti va jurnali **saqlanadi** |
| A pul, B status (eski nusxa) yozadi | ikkalasi ham saqlanadi (merge) |
| `app_state.rev` va bitta faol polling instansi | o'sadi; `online` = 1 |

### 11.3 Ochiq xavflar (hal qilinmagan)

- **Yozuv hajmi:** har yozuv butun holatni qayta yozadi (bitta JSONB qator) va
  endi har pul amali oldidan to'liq o'qish ham qiladi. 100–1000 foydalanuvchi
  uchun maqbul, lekin ma'lumot o'sganda latency o'sadi. Yechim — normallashtirilgan
  jadvallar (`docs/PRODUCTION_READINESS.md`), bunda `SELECT ... FOR UPDATE`
  qatorlar darajasida ishlaydi va butun holatni qayta o'qish kerak bo'lmaydi.
- **Qulf egasi sekin ishlasa:** boshqa instanslar `STATE_LOCK_TIMEOUT_MS`
  (20 s) kutadi; tarmoq fazalari (Telegram `getChatMember`) qulfdan **tashqarida**
  bajariladi, lekin `flushOrRollback` sekin diskda qulfni ushlab turadi.
- **`loginFail`/`loginOk`** dagi `flushSave()` hanuz kutmaydi (pul yo'li emas).
- **PG versiyasi:** 18.6 embedded'da sinalgan; production versiyasi boshqacha
  bo'lishi mumkin (`jsonb`, advisory lock semantikasi bir xil).
