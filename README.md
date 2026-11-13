# Growth Exchange Bot — Render.com uchun

Telegram "growth exchange" boti (haqiqiy long-polling) + veb admin panel.
Bitta Node.js jarayonida ishlaydi: HTTP panel va bot birga.

Bu nusxa **Render.com'ning bepul (free) web service** tarifiga moslangan.
Asl nusxa alwaysdata uchun qilingan edi (faylga saqlash + qo'lda ishga tushirish).

---

## 1. Nima o'zgardi (alwaysdata nusxasiga nisbatan)

| Muammo (Render free) | Yechim |
|---|---|
| Fayl tizimi **doimiy emas** — `data/db.json` har restart/deploy/uxlashda o'chadi | `DATABASE_URL` berilganda holat **Postgres**ga yoziladi (bitta `app_state` jadvali, JSONB). Bo'lmasa fayl rejimi saqlanadi (lokal uchun) |
| Free instance **15 daqiqa trafiksiz uxlaydi** → bot to'xtaydi | `KEEP_ALIVE=1`: servis o'zini har 10 daqiqada `/healthz` bilan uyg'otadi |
| Noto'g'ri token → `process.exit(1)` → Render qayta-qayta restart qiladi | Endi jarayon o'lmaydi: 30 soniyada bir qayta urinadi, panel va `/healthz` ishlashda davom etadi |
| Render `PORT`ni o'zi beradi | `PORT` env'dan olinadi, `0.0.0.0`ga bog'lanadi (avval ham shunday edi, tekshirildi) |
| Deploy/restart paytida ma'lumot yo'qolishi | `SIGTERM`da darhol faylga **va** Postgres'ga yozib chiqadi (8 s limit bilan) |
| Health check yo'q | `/healthz` — Render health check yo'li (`render.yaml`da) |
| `package-lock.json` yo'q | `pg` bilan birga lock fayl qo'shildi → `npm ci` barqaror |

Bot mantiqiga (FIFO navbat, kreditlar, referal, sponsorlar, hisobotlar) **tegilmagan**.

---

## 2. Render'ga joylash

### A variant — Blueprint (eng oson)

1. Repozitoriy Render'ga ulangan bo'lsin: [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
2. GitHub repozitoriyani tanlang. Render `render.yaml`ni o'qiydi.
3. So'ralganda kiriting:
   - `TELEGRAM_BOT_TOKEN` — @BotFather tokeni
   - `ADMIN_IDS` — admin Telegram ID'lari (vergul bilan)
4. **Apply** → deploy boshlanadi.
5. `ADMIN_PASSWORD` Render tomonidan generatsiya qilinadi:
   **Dashboard → servis → Environment → ADMIN_PASSWORD → Reveal**.
6. (Tavsiya) Doimiy saqlashni ulang — 3-bo'limga qarang.

### B variant — qo'lda

**New + → Web Service** → repozitoriy → quyidagilar:

| Maydon | Qiymat |
|---|---|
| Runtime | Node |
| Build Command | `npm ci --omit=dev` |
| Start Command | `node server.js` |
| Instance Type | **Free** |
| Health Check Path | `/healthz` |

Keyin **Environment** bo'limiga: `TELEGRAM_BOT_TOKEN`, `ADMIN_IDS`, `ADMIN_PASSWORD`,
`KEEP_ALIVE=1`, `KEEP_ALIVE_SEC=600`, `NODE_VERSION=22`.

### Muhim: faqat bitta bot ishlashi mumkin

Bitta token bilan bir vaqtda faqat **bitta** long-polling ulanish bo'ladi.
Eski alwaysdata'dagi botni **to'xtating**, aks holda ikkalasi navbat bilan `409 Conflict` oladi
(logda `getUpdates xato: Conflict` ko'rinadi).

---

## 3. Doimiy saqlash (Postgres) — tavsiya etiladi

Render'ning bepul Postgres'i **30 kundan keyin o'chadi** (14 kun grace, keyin ma'lumot bilan
o'chiriladi), bepul Key Value esa **xotirada** — restartda yo'qoladi. Shuning uchun muddatsiz
bepul Postgres ishlatsangiz yaxshi bo'ladi (masalan **Neon** — bepul tarif, uxlab turadi va
ulanishda uyg'onadi, ma'lumot saqlanadi).

1. [neon.com](https://neon.com) → ro'yxatdan o'tish → **New Project**.
2. **Connection string**ni nusxalang:
   `postgresql://user:parol@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`
3. Render → servis → **Environment** → **Add Environment Variable**:
   `DATABASE_URL` = shu satr → **Save** (servis qayta deploy bo'ladi).
4. Logda quyidagini ko'rishingiz kerak:
   `Saqlash: Postgres (yangi jadval, boshlang'ich holat yozildi)`.
5. Keyingi restartdan keyin: `Saqlash: Postgres (mavjud holat yuklandi)`.

Jadval o'zi yaratiladi (`CREATE TABLE IF NOT EXISTS app_state ...`) — migratsiya kerak emas.

> `DATABASE_URL` bo'lmasa bot baribir ishlaydi, lekin **har restart/deploy/uxlashda
> barcha foydalanuvchilar, kreditlar va vazifalar nolga tushadi**. Logda ogohlantirish chiqadi.

### alwaysdata'dan ko'chirish

Eski serverdagi `data/db.json`ni saqlab qolgan bo'lsangiz: botni bir marta `DATABASE_URL`
bilan ishga tushiring, so'ng `data/db.json`ni loyiha papkasiga qo'yib qayta deploy qiling —
baza bo'sh bo'lsa, fayl avtomatik import qilinadi. (Yoki `psql` bilan to'g'ridan-to'g'ri yozing.)

---

## 4. Free tarifning chegaralari (halol ro'yxat)

- **Uxlash:** 15 daqiqa kiruvchi trafik bo'lmasa servis uxlaydi. `KEEP_ALIVE=1` buni
  to'sadi, lekin uyg'oq servis **oyiga ~730 soat** yeydi — Render bepul limiti **750 soat/oy**.
  Oy to'lganda barcha bepul servislar keyingi oygacha to'xtatiladi. Uzilishni xohlamasangiz —
  pullik instansiya.
- **RAM 512 MB / 0.1 CPU:** kichik bot uchun yetadi; og'ir yuklamada sekinlashadi.
- **Deploy vaqtida qisqa uzilish:** Render yangi instansiyani ko'tarib, eskisini o'chiradi.
  Shu paytda ikkita jarayon bir vaqtda poll qilsa `409` bo'lishi mumkin — bir necha soniyada
  o'zi tiklanadi.
- **Asosiy bot tokeni** (`TELEGRAM_BOT_TOKEN`) env'dan olinadi; panelda u **faqat ko'rinadi**.
  Qo'shimcha **ishchi botlar** panel orqali qo'shiladi va o'chiriladi (pastdagi 9-bo'lim).
- **Veb panel** (`/`) endi haqiqiy ma'lumot bilan ishlaydi: foydalanuvchilar, kanallar,
  buyurtmalar, vazifalar, shikoyatlar, homiylar, botlar va sozlamalar — hammasi bazadan.
  Soxta demo raqamlar va Telegram chat (mini app) interfeysi olib tashlangan.

---

## 5. Env o'zgaruvchilari

| Nomi | Majburiy | Izoh |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ha | @BotFather tokeni |
| `ADMIN_IDS` | ha | Admin Telegram ID'lari, vergul bilan |
| `ADMIN_PASSWORD` | ha | Panel paroli (Basic auth). Bo'sh bo'lsa panel `503` qaytaradi |
| `DATABASE_URL` | tavsiya | `postgresql://...` — doimiy saqlash |
| `KEEP_ALIVE` | yo'q | `1` (standart) — o'zini uyg'oq tutish; `0` — o'chirish |
| `KEEP_ALIVE_SEC` | yo'q | Uyg'otish oralig'i, soniya (standart 600) |
| `APP_URL` | yo'q | `RENDER_EXTERNAL_URL` bo'lmasa ishlatiladi |
| `DATA_FILE` | yo'q | Lokal fayl yo'li (standart `./data/db.json`) |
| `NEWS_BOT_TOKEN` | yangiliklar boti uchun | `@Dunyo_Yangiliklari_Texno_bot` tokeni |
| `GEMINI_API_KEY` | yangiliklar boti uchun | Post yaratish kaliti (`/news`da ham kiritiladi) |
| `NEWS_RSS_QUERY` | yo'q | Yangilik mavzusi (standart `technology`) |
| `PORT`, `IP` | yo'q | Render o'zi beradi |

---

## 6. Tekshirish (deploydan keyin)

```bash
# 1. Servis tirikmi (200 + "ok postgres" yoki "ok file")
curl -i https://SERVIS.onrender.com/healthz

# 2. Panel parol so'rayaptimi (401)
curl -i https://SERVIS.onrender.com/

# 3. Parol bilan statistika
curl -u "admin:PAROL" https://SERVIS.onrender.com/api/stats
```

Logda kutilgan satrlar:

```
Veb server: http://0.0.0.0:10000 (saqlash: postgres)
Keep-alive yoqilgan: https://...onrender.com/healthz (har 600s)
Bot @kanalingiz_bot ishga tushdi (long polling)
```

Botni Telegram'da tekshiring: `/start` → menyu chiqishi kerak; admin sifatida `/admin`.

---

## 7. Lokal ishga tushirish

```bash
npm install
cp .env.example .env      # qiymatlarni to'ldiring
npm start                 # http://localhost:3000
```

Lokalda `DATABASE_URL` shart emas — `data/db.json` yetarli.
Postgres bilan sinash (Docker):

```bash
docker run -d --name gx-pg -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16
DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres npm start
```

---

## 8. Nosozliklar

| Belgi | Sabab / yechim |
|---|---|
| `getUpdates xato: Conflict` | Boshqa joyda (alwaysdata/eski server) bir xil token bilan bot ishlayapti — uni to'xtating |
| `Bot ishga tushmadi ... 401 Unauthorized` | Token noto'g'ri/o'chirilgan. Env'ni tuzatib **Manual Deploy → Clear build cache & deploy** qiling |
| Panel `503 ADMIN_PASSWORD o'rnatilmagan` | `ADMIN_PASSWORD` env qo'shilmagan |
| Restartdan keyin ma'lumot yo'q | `DATABASE_URL` yo'q — 3-bo'limga qarang |
| Servis uxlab qolyapti | `KEEP_ALIVE=1` va `RENDER_EXTERNAL_URL` mavjudligini tekshiring |
| `Postgres ulanmadi` | `DATABASE_URL` xato yoki baza uxlagan; logda 5 urinishdan keyin fayl rejimiga o'tadi |

Zaxira nusxa: `curl -u admin:PAROL .../api/stats` (statistika) yoki Postgres:
`pg_dump "$DATABASE_URL" > backup.sql`.

---

## 9. Xavfsizlik

- `.env` va `data/` **hech qachon** commit qilinmaydi (`.gitignore`).
- Panel Basic auth bilan yopilgan; `ADMIN_PASSWORD`ni kuchli qilib qo'ying.
- Token va parolni chatga/logga chiqarmang; Render'da faqat **Environment** orqali bering.
- Repozitoriy **private** bo'lishi tavsiya etiladi.

## 10. Bot qoidalari (o'zgarmagan)

- Vazifalar 10 talik partiya, qat'iy FIFO; kechiktirilganlari yangilardan oldin qaytadi.
- Obuna `getChatMember` orqali haqiqiy tekshiriladi; API xatosi = `CHECK_ERROR`, obunadan chiqish hisoblanmaydi.
- Buyurtmada kredit band qilinadi (`available → reserved`), bekor qilinsa bajarilmagan qismi qaytadi.
- Referal: do'st tasdiqlangan vazifani bajargandan keyingina +200 (bir marta).
- Kanal qo'shishda bot adminligi va foydalanuvchining kanal adminligi tekshiriladi.
- Nazoratchi kodi: 6 xonali, 5 daqiqa.
- Har 15 daqiqada obunadan chiqqanlar qayta tekshiriladi; 48 soatdan eski bajarilmagan vazifalar bo'shatiladi.
- Instagram standart holatda o'chiq (`/igon` bilan yoqiladi).

Admin buyruqlari: `/admin /pause /resume /freeze /unfreeze /igon /igoff /addcredits ID SON
/block ID /unblock ID /broadcast MATN /complaints /reply TICKET MATN
/sponsor add @kanal|del @kanal|list /reward tg|ig|ref SON`

---

## 11. Panel, multi-bot va yangiliklar boti

### Panel (Basic auth, `/`)

Bo'limlar: **Umumiy** (real statistika, botlar holati, oxirgi ro'yxatdan o'tganlar),
**Botlar**, **Foydalanuvchilar** (qidiruv, kredit qo'shish/ayirish, bloklash),
**Kanallar**, **Buyurtmalar** (bekor qilish + avtomatik qaytarim), **Vazifalar**,
**Shikoyatlar** (javob yuborish), **Homiy kanallar**, **Sozlamalar** (mukofotlar,
pause/freeze/IG/hisobot, broadcast). Yangiliklar boti — `/news`.

Barcha raqamlar `db`dan olinadi; panelda soxta/demo ma'lumot yo'q.

### Bir nechta bot — bitta baza

`@Obuna_2X_bot` asosiy bot (`TELEGRAM_BOT_TOKEN`). Panel → **Botlar** bo'limida
boshqa bot tokenlarini qo'shish mumkin. Har bir bot o'z long-polling tsikli bilan
ishlaydi (offset alohida), lekin **bitta `db`** ni ishlatadi: foydalanuvchi qaysi
botga yozsa ham bir xil hisob, kanallar va buyurtmalar. Shuning uchun Telegram'da
bir necha "kirish nuqtasi" qilish mumkin.

### Yangi foydalanuvchi

- `/start` bosganda **10 kredit** sovg'a (`creditRewardSignup`, panelda o'zgartiriladi).
- Keyin qadam-baqadam **yo'riqnoma** yuboriladi (kredit ishlash → kanal ulash →
  buyurtma → referal).

### Yangiliklar boti

`@Dunyo_Yangiliklari_Texno_bot` → kanal `@Dunyo_Yangiliklari_Texno`.
Jadval: **06:00, 09:00, 12:00, 15:00, 18:00, 21:00** (Asia/Tashkent, har 3 soat).
Model zanjiri + cooldown: bitta model limiti tugasa, keyingisiga o'tadi.
