/**
 * modules/engagement.js — Görev 2: Etkileşim Takibi + Otomatik Öne Çıkarma
 *
 * - X API v2 ile 1. ve 6. saat metriklerini çeker
 * - Telegram view/forward sayılarını izler
 * - Üst %10'a giren post: Telegram'da pin + X'te alıntı tweet
 * - Günlük Sonnet analizi → briefs/weekly_engagement.md
 * - Platformlar arası amplifier (cross-platform-amplifier-skill)
 *
 * Kullanım:
 *   const engagement = require('./modules/engagement');
 *   engagement.init(twitterClient);
 *   engagement.kaydet({ post_id, platform, haber_slug, ... });
 */

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { kaydetEngagement, topHaberler, getDb } = require('../db/init');

const claudeClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const AMPLIFIER_CONFIG = path.join(__dirname, '..', 'config', 'amplifier.json');
const BRIEFS_DIR = path.join(__dirname, '..', 'briefs');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const TELEGRAM_KANAL = process.env.TELEGRAM_KANAL;

// Twitter client referansı
let _twitterClient = null;

// Post takip listesi (in-memory, DB'ye yedekleme)
// { post_id, platform, haber_slug, kategori, kayitli_at }
const takipListesi = [];

// ── Kayıt & Takip ──────────────────────────────────────────────────────────

function kaydet(postBilgi) {
  const kayit = {
    post_id: postBilgi.post_id,
    platform: postBilgi.platform,
    haber_slug: postBilgi.haber_slug,
    kategori: postBilgi.kategori || 'genel',
    kayitli_at: Date.now(),
  };
  takipListesi.push(kayit);
  console.log(`[Engagement] Takibe alındı: ${postBilgi.platform}/${postBilgi.post_id}`);
}

// ── X Metrikleri ───────────────────────────────────────────────────────────

async function xMetrikCek(postId, saatSonrasi) {
  if (!_twitterClient) return null;
  try {
    const tweet = await _twitterClient.v2.singleTweet(postId, {
      'tweet.fields': ['public_metrics'],
    });
    const m = tweet.data?.public_metrics || {};
    return {
      impressions: m.impression_count || 0,
      likes: m.like_count || 0,
      retweets: m.retweet_count || 0,
      bookmarks: m.bookmark_count || 0,
      views: 0,
      forwards: 0,
    };
  } catch (e) {
    console.error(`[Engagement] X metrik hatası (${postId}):`, e.message);
    return null;
  }
}

// ── Telegram Metrikleri ────────────────────────────────────────────────────

async function telegramMetrikCek(messageId) {
  try {
    // Kanal mesajı getir
    const res = await fetch(
      `${TELEGRAM_API}/getMessages?chat_id=${TELEGRAM_KANAL}&message_ids=${messageId}`
    );
    const data = await res.json();
    const msg = data.result?.[0];
    if (!msg) return null;

    return {
      impressions: 0,
      likes: 0,
      retweets: 0,
      bookmarks: 0,
      views: msg.views || 0,
      forwards: msg.forwards || 0,
    };
  } catch (e) {
    console.error(`[Engagement] Telegram metrik hatası (${messageId}):`, e.message);
    return null;
  }
}

// ── Metrik toplama döngüsü ─────────────────────────────────────────────────

async function metrikTopla(saatSonrasi) {
  const simdi = Date.now();
  const esik = saatSonrasi * 60 * 60 * 1000;

  const hedefler = takipListesi.filter(p => {
    const gecenSure = simdi - p.kayitli_at;
    const tolerans = 5 * 60 * 1000; // ±5 dakika tolerans
    return Math.abs(gecenSure - esik) < tolerans;
  });

  for (const hedef of hedefler) {
    let metrik = null;

    if (hedef.platform === 'x') {
      metrik = await xMetrikCek(hedef.post_id, saatSonrasi);
    } else if (hedef.platform === 'telegram') {
      metrik = await telegramMetrikCek(hedef.post_id);
    }

    if (!metrik) continue;

    kaydetEngagement({
      post_id: hedef.post_id,
      platform: hedef.platform,
      haber_slug: hedef.haber_slug,
      kategori: hedef.kategori,
      etiketler: JSON.stringify([hedef.kategori]),
      ...metrik,
      olcum_saati: saatSonrasi,
    });

    // Viral kontrol
    await viralKontrol(hedef, metrik);
  }
}

// ── Viral tespit ve aksiyon ────────────────────────────────────────────────

async function viralKontrol(post, metrik) {
  const config = JSON.parse(fs.readFileSync(AMPLIFIER_CONFIG, 'utf-8'));
  const top = topHaberler(7, 10);
  if (top.length === 0) return;

  const maxGorunum = Math.max(...top.map(h => h.toplam_gorunum));
  const postGorunum = metrik.impressions || metrik.views || 0;

  // Üst %10 eşiği
  const esik = maxGorunum * 0.9;

  if (postGorunum >= esik && postGorunum > 0) {
    console.log(`[Engagement] 🔥 VİRAL: ${post.haber_slug} — ${postGorunum} görüntülenme`);

    if (post.platform === 'x') {
      // X → Telegram amplifier
      if (config.x_to_telegram.aktif && postGorunum >= config.x_to_telegram.esik_impression_6saat) {
        await xToTelegramAmplifiy(post, metrik, config.x_to_telegram);
      }
      // Telegram'da pin
      await telegramPin(post.post_id);
    } else if (post.platform === 'telegram') {
      // Telegram → X amplifier
      if (config.telegram_to_x.aktif && metrik.forwards >= config.telegram_to_x.esik_forward_sayisi) {
        await telegramToXAmplify(post, metrik, config.telegram_to_x);
      }
    }
  }
}

async function xToTelegramAmplifiy(post, metrik, config) {
  const mesaj = config.mesaj_sablonu
    .replace('{baslik}', post.haber_slug)
    .replace('{ozet}', '')
    .replace('{link}', `https://anlikhaber.com/haber/${post.haber_slug}`)
    .replace('{impression}', metrik.impressions.toLocaleString('tr-TR'))
    .replace('{likes}', metrik.likes.toLocaleString('tr-TR'));

  await telegramGonder(TELEGRAM_KANAL, mesaj);
  console.log('[Engagement] X→Telegram amplify yapıldı.');
}

async function telegramToXAmplify(post, metrik, config) {
  if (!_twitterClient) return;
  const tweet = config.tweet_sablonu
    .replace('{baslik}', post.haber_slug)
    .replace('{link}', `https://anlikhaber.com/haber/${post.haber_slug}`);

  try {
    await _twitterClient.v2.tweet(tweet);
    console.log('[Engagement] Telegram→X amplify yapıldı.');
  } catch (e) {
    console.error('[Engagement] Amplify tweet hatası:', e.message);
  }
}

async function telegramPin(messageId) {
  try {
    await fetch(`${TELEGRAM_API}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_KANAL,
        message_id: parseInt(messageId),
        disable_notification: true,
      }),
    });
    console.log('[Engagement] Mesaj pinlendi:', messageId);
  } catch (e) {
    console.error('[Engagement] Pin hatası:', e.message);
  }
}

// ── Haftalık Sonnet Analizi ────────────────────────────────────────────────

async function haftalikAnalizYap() {
  const top10 = topHaberler(7, 10);
  if (top10.length < 3) {
    console.log('[Engagement] Yeterli veri yok, haftalık analiz atlandı.');
    return;
  }

  const prompt = `AnlıkHaber Türkçe finans haber sitesinin son 7 günlük etkileşim verisi:

${top10.map((h, i) =>
  `${i + 1}. ${h.haber_slug} | ${h.platform} | Kategori: ${h.kategori} | ` +
  `Görüntülenme: ${h.toplam_gorunum} | Etkileşim: ${h.toplam_etkilesim}`
).join('\n')}

Bu top 10 postun ortak özellikleri neler? Hangi kategoriler, hangi saatler, hangi içerik tipleri daha çok tutuyor?
Gelecek hafta için 3 somut içerik stratejisi öner. Türkçe yaz, 400 kelime altında tut.`;

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const analiz = response.content[0].text;
    const tarih = new Date().toISOString().split('T')[0];

    if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });

    const dosyaAdi = path.join(BRIEFS_DIR, `weekly_engagement_${tarih}.md`);
    fs.writeFileSync(dosyaAdi, `# AnlıkHaber Haftalık Etkileşim Analizi\n**Tarih:** ${tarih}\n\n${analiz}\n`);

    console.log('[Engagement] Haftalık analiz yazıldı:', dosyaAdi);
  } catch (e) {
    console.error('[Engagement] Sonnet analiz hatası:', e.message);
  }
}

// ── Yardımcı ──────────────────────────────────────────────────────────────

async function telegramGonder(chatId, mesaj) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: mesaj, parse_mode: 'Markdown' }),
  });
}

// ── Başlatıcı ──────────────────────────────────────────────────────────────

function init(twitterClient) {
  _twitterClient = twitterClient;

  // 1 saat sonrası metrik (her saat başı kontrol)
  cron.schedule('5 * * * *', () => metrikTopla(1), { timezone: 'Europe/Istanbul' });

  // 6 saat sonrası metrik
  cron.schedule('10 * * * *', () => metrikTopla(6), { timezone: 'Europe/Istanbul' });

  // Pazartesi 08:00'de haftalık analiz
  cron.schedule('0 8 * * 1', haftalikAnalizYap, { timezone: 'Europe/Istanbul' });

  console.log('[Engagement] Başlatıldı. Metrik takibi aktif.');
}

module.exports = {
  init,
  kaydet,
  haftalikAnalizYap,
};
