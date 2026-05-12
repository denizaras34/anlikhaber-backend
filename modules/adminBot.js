/**
 * modules/adminBot.js — Görev 5: Telegram Admin Komut Paneli
 *
 * Railway'e girmeden backend'i Telegram bot komutlarıyla yönet.
 *
 * Komutlar:
 *   /ping    → Backend sağlık kontrolü
 *   /stats   → Son 24 saat istatistikleri
 *   /queue   → Yayın kuyruğu durumu
 *   /top     → Bugünün viral top 3 haberi
 *   /pause   → RSS + yayın durdur
 *   /resume  → RSS + yayın başlat
 *   /force   → Belirtilen RSS'i şimdi çek
 *   /health  → RSS kaynak sağlık durumu
 *   /newsletter → Günlük bülteni şimdi gönder
 *
 * Kurulum: npm install node-telegram-bot-api
 *
 * Kullanım:
 *   const adminBot = require('./modules/adminBot');
 *   adminBot.init({ schedulerDurum, rssHealthDurum, topHaberler, rssGuncelle });
 */

const TelegramBot = require('node-telegram-bot-api');
const { getDb, topHaberler, bekleyenKuyruk } = require('../db/init');
const { saglikDurumu } = require('./rssHealth');
const schedulerMod = require('./scheduler');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_GRUP = process.env.TELEGRAM_GRUP;
const ADMIN_USER_IDS = (process.env.ADMIN_TELEGRAM_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

let bot = null;
let duraklatildi = false;
let _callbacks = {};

// ── Güvenlik kontrolü ─────────────────────────────────────────────────────

function yetkiliMi(msg) {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id);

  // Grup kontrolü
  if (chatId !== String(TELEGRAM_GRUP)) return false;

  // Kullanıcı whitelist (boşsa sadece grup kontrolü)
  if (ADMIN_USER_IDS.length > 0 && !ADMIN_USER_IDS.includes(userId)) return false;

  return true;
}

function yetkisizYoksay(msg) {
  console.log(`[AdminBot] Yetkisiz istek: user=${msg.from?.id} chat=${msg.chat.id}`);
  // Sessizce yoksay — yanıt verme
}

// ── Komut tanımları ────────────────────────────────────────────────────────

const KOMUTLAR = {
  '/ping': {
    aciklama: 'Backend sağlık kontrolü',
    handler: async (msg) => {
      const baslangic = Date.now();
      const db = getDb();
      const kuyrukSayisi = db.prepare("SELECT COUNT(*) as c FROM publish_queue WHERE durum='bekliyor'").get().c;
      const gecikme = Date.now() - baslangic;
      return (
        `🟢 *Backend Aktif*\n` +
        `⏱ Yanıt süresi: ${gecikme}ms\n` +
        `📋 Bekleyen kuyruk: ${kuyrukSayisi}\n` +
        `⏸ Durum: ${duraklatildi ? 'DURDURULDU' : 'Çalışıyor'}\n` +
        `🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`
      );
    },
  },

  '/stats': {
    aciklama: 'Son 24 saat istatistikleri',
    handler: async (msg) => {
      const db = getDb();
      const yayinlanan = db.prepare(`
        SELECT COUNT(*) as c FROM publish_queue
        WHERE durum='yayinlandi' AND yayinlandi_at >= datetime('now','-24 hours')
      `).get().c;
      const engagementX = db.prepare(`
        SELECT SUM(impressions) as toplam FROM engagement_metrics
        WHERE platform='x' AND olusturuldu_at >= datetime('now','-24 hours')
      `).get();
      const engagementTg = db.prepare(`
        SELECT SUM(views) as toplam FROM engagement_metrics
        WHERE platform='telegram' AND olusturuldu_at >= datetime('now','-24 hours')
      `).get();
      const schedulerStat = schedulerMod.durum();

      return (
        `📊 *Son 24 Saat İstatistikleri*\n\n` +
        `📰 Yayınlanan haber: ${yayinlanan}\n` +
        `🐦 X toplam impression: ${(engagementX?.toplam || 0).toLocaleString('tr-TR')}\n` +
        `📱 Telegram toplam görüntülenme: ${(engagementTg?.toplam || 0).toLocaleString('tr-TR')}\n\n` +
        `📋 *Kuyruk:*\n` +
        `• Bekleyen: ${schedulerStat.son_30dk_haber} son 30dk\n` +
        `• X pencerede mi: ${schedulerStat.x_pencerede_mi ? '✅' : '❌'}\n` +
        `• Sonraki X: ${schedulerStat.sonraki_x}\n` +
        `• Sonraki TG: ${schedulerStat.sonraki_telegram}`
      );
    },
  },

  '/queue': {
    aciklama: 'Yayın kuyruğu durumu',
    handler: async (msg) => {
      const bekleyenler = bekleyenKuyruk();
      if (bekleyenler.length === 0) return '✅ *Kuyruk boş* — tüm haberler yayınlandı.';

      const liste = bekleyenler.slice(0, 5).map((h, i) =>
        `${i + 1}. [${h.oncelik.toUpperCase()}] "${h.haber_baslik.substring(0, 40)}..." → ${h.platform}`
      ).join('\n');

      return (
        `📋 *Yayın Kuyruğu* (${bekleyenler.length} haber)\n\n` +
        liste +
        (bekleyenler.length > 5 ? `\n... ve ${bekleyenler.length - 5} haber daha` : '')
      );
    },
  },

  '/top': {
    aciklama: 'Bugünün viral top 3 haberi',
    handler: async (msg) => {
      const top = topHaberler(1, 3);
      if (top.length === 0) return '📊 Bugün için yeterli etkileşim verisi yok.';

      const liste = top.map((h, i) =>
        `${i + 1}. \`${h.haber_slug}\`\n   👁 ${(h.toplam_gorunum || 0).toLocaleString('tr-TR')} · ` +
        `❤️ ${(h.toplam_etkilesim || 0).toLocaleString('tr-TR')} · ${h.platform}`
      ).join('\n\n');

      return `🔥 *Bugünün Top 3 Haberi*\n\n${liste}`;
    },
  },

  '/pause': {
    aciklama: 'RSS çekme ve yayını durdur',
    handler: async (msg) => {
      duraklatildi = true;
      if (_callbacks.pause) await _callbacks.pause();
      return '⏸ *Sistem durduruldu.*\n\nRSS çekme ve yayın devre dışı.\n`/resume` ile yeniden başlat.';
    },
  },

  '/resume': {
    aciklama: 'RSS çekme ve yayını başlat',
    handler: async (msg) => {
      duraklatildi = false;
      if (_callbacks.resume) await _callbacks.resume();
      return '▶️ *Sistem yeniden başlatıldı.*\n\nRSS çekme ve yayın aktif.';
    },
  },

  '/force': {
    aciklama: '/force <rss_url> — RSS kaynağını şimdi çek',
    handler: async (msg) => {
      const parcalar = msg.text?.split(' ');
      const url = parcalar?.[1];
      if (!url) return '❌ Kullanım: `/force https://kaynak.com/rss.xml`';
      if (!url.startsWith('http')) return '❌ Geçerli bir URL gir.';

      if (_callbacks.forceRss) {
        await _callbacks.forceRss(url);
        return `🔄 *Manuel RSS çekimi başlatıldı*\n\`${url}\``;
      }
      return '⚠️ forceRss callback tanımlı değil.';
    },
  },

  '/health': {
    aciklama: 'RSS kaynak sağlık durumu',
    handler: async (msg) => {
      const durum = saglikDurumu();
      const rss = durum.rss_kaynaklari;
      const detay = rss.detay
        .map(k => `${k.aktif ? '✅' : '🔴'} ${k.isim} (${k.kategori})${k.fail_sayisi > 0 ? ` ⚠️${k.fail_sayisi}` : ''}`)
        .join('\n');

      return (
        `🏥 *RSS Sağlık Durumu*\n\n` +
        `✅ Aktif: ${rss.aktif}/${rss.toplam}\n` +
        `🔴 Pasif: ${rss.pasif}\n` +
        `⚠️ Uyarı: ${rss.uyari}\n\n` +
        `*Detay:*\n${detay}`
      );
    },
  },

  '/newsletter': {
    aciklama: 'Günlük bülteni şimdi gönder',
    handler: async (msg) => {
      if (_callbacks.sendNewsletter) {
        await bot.sendMessage(msg.chat.id, '📨 Bülten hazırlanıyor...');
        await _callbacks.sendNewsletter();
        return '✅ *Bülten gönderildi!*';
      }
      return '⚠️ Newsletter callback tanımlı değil.';
    },
  },

  '/yardim': {
    aciklama: 'Komut listesi',
    handler: async (msg) => {
      const liste = Object.entries(KOMUTLAR)
        .map(([cmd, def]) => `${cmd} — ${def.aciklama}`)
        .join('\n');
      return `🤖 *AnlıkHaber Admin Bot*\n\n${liste}`;
    },
  },
};

// ── Bot başlatıcı ──────────────────────────────────────────────────────────

function init(callbacks = {}) {
  if (!TELEGRAM_TOKEN) {
    console.warn('[AdminBot] TELEGRAM_TOKEN eksik, bot başlatılmadı.');
    return;
  }

  _callbacks = callbacks;

  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  // Her komut için handler
  Object.entries(KOMUTLAR).forEach(([komut, tanim]) => {
    // /force gibi argümanı olan komutlar için regex
    const regex = new RegExp(`^${komut.replace('/', '\\/')}(\\s|$)`);
    bot.onText(regex, async (msg) => {
      if (!yetkiliMi(msg)) { yetkisizYoksay(msg); return; }

      try {
        const cevap = await tanim.handler(msg);
        if (cevap) {
          await bot.sendMessage(msg.chat.id, cevap, { parse_mode: 'Markdown' });
        }
      } catch (e) {
        console.error(`[AdminBot] Komut hatası (${komut}):`, e.message);
        await bot.sendMessage(msg.chat.id, `❌ Hata: ${e.message}`);
      }
    });
  });

  bot.on('polling_error', (err) => {
    console.error('[AdminBot] Polling hatası:', err.message);
  });

  console.log(`[AdminBot] Başlatıldı. Grup: ${TELEGRAM_GRUP}`);
  console.log(`[AdminBot] Admin users: ${ADMIN_USER_IDS.length > 0 ? ADMIN_USER_IDS.join(', ') : 'hepsi (whitelist yok)'}`);
  console.log(`[AdminBot] Komutlar: ${Object.keys(KOMUTLAR).join(', ')}`);
}

function duraklatildiMi() {
  return duraklatildi;
}

module.exports = { init, duraklatildiMi };
