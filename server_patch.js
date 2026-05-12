/**
 * server_patch.js — AnlıkHaber Modül Entegrasyon Rehberi
 *
 * Bu dosyayı server.js'ine kopyala/yapıştır veya require et.
 * ─────────────────────────────────────────────────────────
 *
 * ADIM 1: Yeni paketleri yükle
 * ────────────────────────────
 * Railway ortamında ya da lokalde çalıştır:
 *
 *   npm install better-sqlite3 node-telegram-bot-api @getbrevo/brevo
 *
 * ─────────────────────────────────────────────────────────
 * ADIM 2: Railway'e yeni env değişkeni ekle (opsiyonel ama önerilir)
 * ────────────────────────────────────────────────────────────────────
 *
 *   ADMIN_TELEGRAM_USER_IDS=123456789  (kendi Telegram user ID'in)
 *
 *   Telegram user ID öğrenmek için: @userinfobot'a /start yaz
 *
 * ─────────────────────────────────────────────────────────
 * ADIM 3: server.js dosyanın başına ekle
 * ───────────────────────────────────────
 */

// ══ IMPORTS ══════════════════════════════════════════════════════════════════

const { generateMultiFormat, logMetrik } = require('./modules/multiformat');
const rssHealth = require('./modules/rssHealth');
const scheduler = require('./modules/scheduler');
const engagement = require('./modules/engagement');
const newsletter = require('./modules/newsletter');
const adminBot = require('./modules/adminBot');
const { getDb } = require('./db/init');

// ══ BAŞLATMA (server.js'deki mevcut cron ve express init'in ALTINA ekle) ═════

function anlikHaberModulleriniBaslat(app, twitterClient) {

  // 1. Veritabanını başlat
  getDb(); // Şemayı oluşturur, ilk çalıştırmada tabloları kurar

  // 2. RSS sağlık monitörü
  rssHealth.init();

  // 3. Akıllı zamanlayıcı
  //    yayinFn: mevcut server.js'deki X ve Telegram yayın fonksiyonun
  scheduler.init(async (haber, platform) => {
    if (platform === 'x' || platform === 'both') {
      await xYayinla(haber, twitterClient);       // ← mevcut X yayın fonksiyonun
    }
    if (platform === 'telegram' || platform === 'both') {
      await telegramYayinla(haber);               // ← mevcut Telegram yayın fonksiyonun
    }
  });

  // 4. Etkileşim takibi
  engagement.init(twitterClient);

  // 5. Günlük bülten
  //    haberlerFn: mevcut haber listeni döndüren fonksiyon
  newsletter.init(async () => {
    return haberlerDon(); // ← mevcut haberleri döndüren fonksiyonun
  });

  // 6. Telegram admin bot
  adminBot.init({
    pause:           () => { /* cron'ları durdur */ console.log('Sistem durduruldu'); },
    resume:          () => { /* cron'ları başlat */ console.log('Sistem başlatıldı'); },
    forceRss:        async (url) => { /* belirtilen RSS'i çek */ },
    sendNewsletter:  () => newsletter.gonder(),
  });

  // 7. /api/health endpoint'ini genişlet
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      duraklatildi: adminBot.duraklatildiMi(),
      zamanlayici: scheduler.durum(),
      ...rssHealth.saglikDurumu(),
      ts: new Date().toISOString(),
    });
  });

  console.log('[AnlıkHaber] Tüm modüller başlatıldı ✅');
}

// ══ RSS FONKSİYONUNDA YAPILACAK DEĞİŞİKLİK ════════════════════════════════
//
// Mevcut kod örneği (server.js'inde buna benzer bir şey var):
//
//   const items = await parser.parseURL(feedUrl);
//   for (const item of items) {
//     await xYayinla(item);
//     await telegramYayinla(item);
//   }
//
// YENİ AKIŞ:
//
async function rssIsleYeni(feedUrl, kaynak, parser) {
  // Sağlık kontrolü
  if (adminBot.duraklatildiMi()) {
    console.log('[RSS] Sistem durdurulmuş, atlıyorum.');
    return;
  }

  let items;
  try {
    const feed = await parser.parseURL(feedUrl);
    items = feed.items;
    rssHealth.rapor(kaynak); // Başarı bildir
  } catch (err) {
    await rssHealth.hataBildir(kaynak, err); // Hata bildir
    return;
  }

  for (const item of items) {
    const article = {
      baslik: item.title,
      icerik: item.content || item.summary || item.title,
      link: item.link,
      slug: slugify(item.title, { lower: true, strict: true }),
      kategori: kaynak.kategori,
      kaynak: kaynak.isim,
    };

    // Tek Haiku çağrısı → tüm formatlar
    const formatlar = await generateMultiFormat(article);
    logMetrik(formatlar._meta);

    // Etkileşim kaydı için hazırla
    const haberTam = { ...article, ...formatlar };

    // Zamanlayıcıya ver (breaking ise anında, değilse kuyrukla)
    await scheduler.kuyrugaEkleHaber(article, formatlar);
  }
}

// ══ MEVCUT YAYIM FONKSİYONLARINA EKLENECEK SATIRLAR ══════════════════════
//
// xYayinla fonksiyonunun SONUNA ekle:
//
//   engagement.kaydet({
//     post_id: tweet.data.id,
//     platform: 'x',
//     haber_slug: haber.slug,
//     kategori: haber.kategori,
//   });
//
// telegramYayinla fonksiyonunun SONUNA ekle:
//
//   engagement.kaydet({
//     post_id: String(mesaj.message_id),
//     platform: 'telegram',
//     haber_slug: haber.slug,
//     kategori: haber.kategori,
//   });
//
// Telegram POLL göndermek için (kripto/döviz/bist):
//
//   if (formatlar.telegram_poll) {
//     await fetch(`${TELEGRAM_API}/sendPoll`, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         chat_id: TELEGRAM_KANAL,
//         question: formatlar.telegram_poll.soru,
//         options: formatlar.telegram_poll.secenekler,
//         is_anonymous: true,
//         open_period: formatlar.telegram_poll.sure_saat * 3600,
//       }),
//     });
//   }

// ══ PACKAGE.JSON'A EKLENECEK BAĞIMLILIKLAR ════════════════════════════════
//
// "dependencies" bloğuna ekle:
//
//   "better-sqlite3": "^9.0.0",
//   "node-telegram-bot-api": "^0.64.0",
//   "@getbrevo/brevo": "^2.0.0"
//
// ══ DOSYA YAPISI ══════════════════════════════════════════════════════════
//
//   anlikhaber-backend/
//   ├── server.js              (mevcut — az değişiklik)
//   ├── server_patch.js        (bu dosya — entegrasyon rehberi)
//   ├── modules/
//   │   ├── multiformat.js     (Görev 3)
//   │   ├── rssHealth.js       (Görev 6)
//   │   ├── scheduler.js       (Görev 1)
//   │   ├── engagement.js      (Görev 2)
//   │   ├── newsletter.js      (Görev 4)
//   │   └── adminBot.js        (Görev 5)
//   ├── db/
//   │   └── init.js            (SQLite şema + yardımcılar)
//   ├── config/
//   │   ├── rss_sources.json   (RSS kaynakları + fallback)
//   │   └── amplifier.json     (Cross-platform eşikleri)
//   ├── briefs/                (Haftalık Sonnet analizleri — git ignore et)
//   └── data/                  (SQLite DB — git ignore et)
//
// .gitignore'a ekle:
//   briefs/
//   data/

module.exports = { anlikHaberModulleriniBaslat, rssIsleYeni };
