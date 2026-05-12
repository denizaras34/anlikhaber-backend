/**
 * modules/rssHealth.js — Görev 6: RSS Kaynak Sağlık Monitörü
 *
 * - Her RSS çekiminde kaynağı izler, hata sayar
 * - 3 ardışık hatada kaynağı devre dışı bırakır, fallback'i aktive eder
 * - Her 6 saatte bir sağlık raporu Telegram'a gönderir
 * - Haftada 1 kez devre dışı kaynakları test eder
 * - GET /api/health endpoint'i için durum verir
 *
 * Kullanım:
 *   const rssHealth = require('./modules/rssHealth');
 *   rssHealth.init(); // server başlarken bir kez çağır
 *   const basarili = await rssHealth.rapor(kaynak, haber); // RSS başarılıysa
 *   await rssHealth.hataBildir(kaynak, hata); // RSS başarısızsa
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const SOURCES_PATH = path.join(__dirname, '..', 'config', 'rss_sources.json');
const MAX_FAIL = 3;
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const TELEGRAM_GRUP = process.env.TELEGRAM_GRUP;

// ── Config yönetimi ────────────────────────────────────────────────────────

function configYukle() {
  return JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf-8'));
}

function configKaydet(config) {
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function aktifKaynaklar() {
  const config = configYukle();
  return config.kaynaklar.filter(k => k.aktif);
}

function tumKaynaklar() {
  return configYukle().kaynaklar;
}

// ── Sağlık takibi ──────────────────────────────────────────────────────────

/**
 * RSS çekimi başarılıysa çağır
 */
function rapor(kaynak) {
  const config = configYukle();
  const k = config.kaynaklar.find(x => x.id === kaynak.id || x.url === kaynak.url);
  if (!k) return;

  k.fail_sayisi = 0;
  k.aktif = true;
  k.son_basari_at = new Date().toISOString();
  k.son_hata_mesaji = null;
  configKaydet(config);

  console.log(`[RSSHealth] ✅ ${k.isim} sağlıklı`);
}

/**
 * RSS çekimi başarısızsa çağır
 */
async function hataBildir(kaynak, hata) {
  const config = configYukle();
  const k = config.kaynaklar.find(x => x.id === kaynak.id || x.url === kaynak.url);
  if (!k) return;

  k.fail_sayisi = (k.fail_sayisi || 0) + 1;
  k.son_hata_at = new Date().toISOString();
  k.son_hata_mesaji = hata?.message || String(hata);

  console.warn(`[RSSHealth] ⚠️ ${k.isim} hata #${k.fail_sayisi}: ${k.son_hata_mesaji}`);

  if (k.fail_sayisi >= MAX_FAIL && k.aktif) {
    k.aktif = false;
    console.error(`[RSSHealth] 🔴 ${k.isim} devre dışı (${MAX_FAIL} ardışık hata)`);

    // Fallback aktive et
    if (k.fallback_url) {
      const fallback = config.kaynaklar.find(x => x.url === k.fallback_url);
      if (fallback && !fallback.aktif) {
        fallback.aktif = true;
        console.log(`[RSSHealth] 🔄 Fallback aktive: ${fallback.isim}`);
      }
    }

    // Telegram uyarısı
    await telegramUyari(k);
  }

  configKaydet(config);
}

// ── Telegram bildirim ──────────────────────────────────────────────────────

async function telegramUyari(kaynak) {
  if (!TELEGRAM_GRUP || !process.env.TELEGRAM_TOKEN) return;

  const fallbackMetni = kaynak.fallback_url
    ? `\n🔄 Fallback aktive edildi`
    : `\n❌ Yedek kaynak yok — kategori tek kaynakla devam ediyor`;

  const mesaj =
    `⚠️ *RSS Kaynak Hatası*\n\n` +
    `📡 *Kaynak:* ${kaynak.isim}\n` +
    `🔗 \`${kaynak.url}\`\n` +
    `❗ *Hata:* ${kaynak.son_hata_mesaji}\n` +
    `📊 *Ardışık hata:* ${kaynak.fail_sayisi}/${MAX_FAIL}` +
    fallbackMetni;

  await telegramGonder(TELEGRAM_GRUP, mesaj);
}

async function saglikRaporu() {
  const kaynaklar = tumKaynaklar();
  const aktif = kaynaklar.filter(k => k.aktif).length;
  const pasif = kaynaklar.filter(k => !k.aktif);
  const uyarilar = kaynaklar.filter(k => k.aktif && k.fail_sayisi > 0);

  let mesaj = `📊 *RSS Kaynak Sağlık Raporu*\n`;
  mesaj += `🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}\n\n`;
  mesaj += `✅ Sağlıklı: ${aktif - uyarilar.length}/${kaynaklar.length}\n`;

  if (uyarilar.length > 0) {
    mesaj += `⚠️ Uyarı: ${uyarilar.map(k => `${k.isim} (${k.fail_sayisi} hata)`).join(', ')}\n`;
  }

  if (pasif.length > 0) {
    mesaj += `🔴 Devre dışı: ${pasif.map(k => k.isim).join(', ')}\n`;
  } else {
    mesaj += `🟢 Tüm kaynaklar aktif\n`;
  }

  await telegramGonder(TELEGRAM_GRUP, mesaj);
  console.log('[RSSHealth] Sağlık raporu gönderildi.');
}

// ── Haftalık iyileşme testi ────────────────────────────────────────────────

async function haftalikTest() {
  const Parser = require('rss-parser');
  const parser = new Parser({ timeout: 10000 });
  const config = configYukle();
  const pasifler = config.kaynaklar.filter(k => !k.aktif);

  if (pasifler.length === 0) {
    console.log('[RSSHealth] Haftalık test: Tüm kaynaklar zaten aktif.');
    return;
  }

  console.log(`[RSSHealth] Haftalık test: ${pasifler.length} pasif kaynak test ediliyor...`);

  for (const k of pasifler) {
    try {
      await parser.parseURL(k.url);
      k.aktif = true;
      k.fail_sayisi = 0;
      k.son_basari_at = new Date().toISOString();
      console.log(`[RSSHealth] ✅ ${k.isim} iyileşti, yeniden aktive edildi.`);
    } catch (e) {
      console.log(`[RSSHealth] ❌ ${k.isim} hâlâ hatalı.`);
    }
  }

  configKaydet(config);
}

// ── Yardımcı: Telegram mesaj gönder ───────────────────────────────────────

async function telegramGonder(chatId, mesaj) {
  if (!process.env.TELEGRAM_TOKEN) return;
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mesaj,
        parse_mode: 'Markdown',
      }),
    });
  } catch (e) {
    console.error('[RSSHealth] Telegram gönderi hatası:', e.message);
  }
}

// ── /api/health verisi ─────────────────────────────────────────────────────

function saglikDurumu() {
  const kaynaklar = tumKaynaklar();
  return {
    rss_kaynaklari: {
      toplam: kaynaklar.length,
      aktif: kaynaklar.filter(k => k.aktif).length,
      pasif: kaynaklar.filter(k => !k.aktif).length,
      uyari: kaynaklar.filter(k => k.aktif && k.fail_sayisi > 0).length,
      detay: kaynaklar.map(k => ({
        isim: k.isim,
        kategori: k.kategori,
        aktif: k.aktif,
        fail_sayisi: k.fail_sayisi,
        son_basari: k.son_basari_at,
        son_hata: k.son_hata_at,
      })),
    },
  };
}

// ── Başlatıcı ──────────────────────────────────────────────────────────────

function init() {
  // Her 6 saatte bir sağlık raporu (TR saati 09:00, 15:00, 21:00, 03:00)
  cron.schedule('0 6,12,18,0 * * *', saglikRaporu, {
    timezone: 'Europe/Istanbul',
  });

  // Pazar sabahı 06:00'da haftalık test
  cron.schedule('0 6 * * 0', haftalikTest, {
    timezone: 'Europe/Istanbul',
  });

  console.log('[RSSHealth] Başlatıldı. Sağlık kontrolleri aktif.');
}

module.exports = {
  init,
  rapor,
  hataBildir,
  saglikDurumu,
  aktifKaynaklar,
  saglikRaporu,
};
