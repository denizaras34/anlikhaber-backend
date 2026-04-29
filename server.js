// ============================================================
// AnlıkHaber — Ana Backend Sunucu
// Express API + RSS Bot + X Bot hepsi burada
// Railway.app'te çalışır — 7/24 aktif
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const Parser = require('rss-parser');
const slugify = require('slugify');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // Netlify sitesi buraya istek atabilsin
app.use(express.json());

// ============================================================
// VERİTABANI (Railway'de memory — upgrade edince PostgreSQL)
// ============================================================
let haberler = []; // Tüm haberler burada tutulur
let postedUrls = new Set(); // Daha önce tweet atılanlar

// ============================================================
// X (TWITTER) CLIENT
// ============================================================
const twitter = new TwitterApi({
  appKey:       process.env.X_API_KEY,
  appSecret:    process.env.X_API_SECRET,
  accessToken:  process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

// ============================================================
// RSS PARSER
// ============================================================
const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'AnlıkHaber/1.0 (+https://anlikhaber.com)' }
});

// ============================================================
// RSS FEED LİSTESİ
// ============================================================
const RSS_FEEDS = [
  { url: 'https://tr.investing.com/rss/news.rss',                       cat: 'finans',  emoji: '📊', kaynak: 'Investing.com TR' },
  { url: 'https://investing.com/rss/news_1.rss',                        cat: 'doviz',   emoji: '💱', kaynak: 'Investing.com' },
  { url: 'https://investing.com/rss/news_11.rss',                       cat: 'emtia',   emoji: '🥇', kaynak: 'Investing.com' },
  { url: 'https://investing.com/rss/news_14.rss',                       cat: 'ekonomi', emoji: '🏛', kaynak: 'Investing.com' },
  { url: 'https://investing.com/rss/news_25.rss',                       cat: 'borsa',   emoji: '📈', kaynak: 'Investing.com' },
  { url: 'https://cointelegraph.com/rss',                               cat: 'kripto',  emoji: '₿',  kaynak: 'CoinTelegraph' },
  { url: 'https://cnbc.com/id/10000664/device/rss/rss.html',           cat: 'finans',  emoji: '📊', kaynak: 'CNBC' },
  { url: 'https://cnbc.com/id/15839135/device/rss/rss.html',           cat: 'piyasa',  emoji: '📈', kaynak: 'CNBC Markets' },
];

// Kategori bazlı sabit hashtagler
const CAT_TAGS = {
  finans:  ['#finans', '#yatırım'],
  doviz:   ['#dolar', '#kur'],
  emtia:   ['#altın', '#petrol'],
  ekonomi: ['#ekonomi', '#faiz'],
  borsa:   ['#BIST100', '#borsa'],
  kripto:  ['#bitcoin', '#kripto'],
  piyasa:  ['#piyasa', '#borsa'],
};

// ============================================================
// TR TREND HASHTAG ÇEK
// ============================================================
let cachedTrends = [];
let lastTrendFetch = 0;

async function getTurkishTrends() {
  const now = Date.now();
  if (cachedTrends.length > 0 && now - lastTrendFetch < 30 * 60 * 1000) {
    return cachedTrends; // 30 dk cache
  }
  try {
    const trends = await twitter.v1.trendsByPlace(23424969); // TR woeid
    cachedTrends = (trends[0]?.trends || [])
      .filter(t => t.name.startsWith('#'))
      .slice(0, 8)
      .map(t => t.name);
    lastTrendFetch = now;
    console.log('🔥 TR Trendler:', cachedTrends.slice(0, 4).join(', '));
    return cachedTrends;
  } catch (e) {
    console.log('⚠ Trend hatası:', e.message);
    return [];
  }
}

// ============================================================
// SLUG OLUŞTUR (URL için)
// ============================================================
function createSlug(title) {
  return slugify(title, {
    lower: true,
    strict: true,
    locale: 'tr',
    trim: true
  }).substring(0, 80);
}

// ============================================================
// RSS'DEN HABER ÇEK VE SİTEYE EKLE
// ============================================================
async function fetchAndSaveNews() {
  console.log('\n📡 RSS taraması başlıyor...');
  let yeniHaberSayisi = 0;

  for (const feed of RSS_FEEDS) {
    try {
      const feedData = await rssParser.parseURL(feed.url);
      const items = feedData.items.slice(0, 5); // Her feedden en yeni 5

      for (const item of items) {
        const orijinalUrl = item.link || item.url || '';
        const title = (item.title || '').trim();

        if (!title || !orijinalUrl) continue;

        // Daha önce eklenmiş mi?
        const varMi = haberler.find(h => h.orijinalUrl === orijinalUrl);
        if (varMi) continue;

        // Slug oluştur
        const slug = createSlug(title);
        const bizimUrl = `https://anlikhaber.com/haber/${slug}`;

        // Haberi kaydet
        const haber = {
          id: Date.now() + Math.random(),
          slug,
          title,
          description: item.contentSnippet || item.content || item.summary || '',
          orijinalUrl,
          bizimUrl,
          kaynak: feed.kaynak,
          kaynakUrl: orijinalUrl,
          cat: feed.cat,
          emoji: feed.emoji,
          tarih: item.pubDate ? new Date(item.pubDate) : new Date(),
          tweetAtildi: false,
        };

        haberler.unshift(haber); // En başa ekle
        yeniHaberSayisi++;

        // Max 200 haber tut
        if (haberler.length > 200) haberler = haberler.slice(0, 200);

        console.log(`✓ Haber eklendi: ${title.substring(0, 60)}`);

        // Tweet at (haber eklenince hemen)
        await tweetHaber(haber);
        await sleep(3000); // Her tweet arası 3 sn bekle
      }
    } catch (e) {
      console.log(`✗ Feed hatası (${feed.kaynak}):`, e.message);
    }
  }

  console.log(`\n✅ RSS taraması bitti. ${yeniHaberSayisi} yeni haber eklendi.`);
}

// ============================================================
// X'E TWEET AT
// ============================================================
async function tweetHaber(haber) {
  if (haber.tweetAtildi) return;
  if (postedUrls.has(haber.orijinalUrl)) return;

  try {
    // TR trendleri çek
    const trends = await getTurkishTrends();

    // Kategori tagları (2 tane)
    const catTags = (CAT_TAGS[haber.cat] || ['#finans']).slice(0, 2).join(' ');

    // Trend tagları (3 tane — finans/kripto/ekonomi trendleri tercih et)
    const finansTrends = trends
      .filter(t => {
        const lower = t.toLowerCase();
        return lower.includes('dolar') || lower.includes('borsa') ||
               lower.includes('bitcoin') || lower.includes('altın') ||
               lower.includes('ekonomi') || lower.includes('faiz') ||
               lower.includes('lira') || lower.includes('kripto');
      })
      .slice(0, 2);

    // Finans trendi yoksa rastgele 2 trend al
    const trendTags = finansTrends.length > 0
      ? finansTrends.join(' ')
      : trends.slice(0, 2).join(' ');

    // Tweet metni
    const tweetText = [
      `${haber.emoji} ${haber.title}`,
      ``,
      `🔗 ${haber.bizimUrl}`,
      ``,
      `📌 Kaynak: ${haber.kaynak}`,
      ``,
      `${catTags} ${trendTags} #anlikhaber #AnlıkHaber`,
    ].join('\n').substring(0, 280);

    await twitter.v2.tweet(tweetText);

    haber.tweetAtildi = true;
    postedUrls.add(haber.orijinalUrl);
    console.log(`🐦 Tweet atıldı: ${haber.title.substring(0, 50)}`);

  } catch (e) {
    if (e.code === 429) {
      console.log('⏳ Rate limit — 15 dk bekleniyor...');
      await sleep(15 * 60 * 1000);
    } else {
      console.log('✗ Tweet hatası:', e.message);
    }
  }
}

// ============================================================
// API ENDPOINT'LER — Netlify sitesi bunları kullanır
// ============================================================

// Tüm haberler
app.get('/api/haberler', (req, res) => {
  const { cat, limit = 50 } = req.query;
  let data = haberler;
  if (cat && cat !== 'hepsi') {
    data = haberler.filter(h => h.cat === cat);
  }
  res.json(data.slice(0, parseInt(limit)));
});

// Tek haber (slug ile)
app.get('/api/haber/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if (!haber) return res.status(404).json({ error: 'Haber bulunamadı' });
  res.json(haber);
});

// İstatistikler
app.get('/api/stats', (req, res) => {
  res.json({
    toplamHaber: haberler.length,
    tweetAtilanlar: haberler.filter(h => h.tweetAtildi).length,
    sonGuncelleme: new Date().toISOString(),
    trends: cachedTrends.slice(0, 5),
    kategoriler: {
      finans: haberler.filter(h => h.cat === 'finans').length,
      kripto: haberler.filter(h => h.cat === 'kripto').length,
      borsa: haberler.filter(h => h.cat === 'borsa').length,
      ekonomi: haberler.filter(h => h.cat === 'ekonomi').length,
      doviz: haberler.filter(h => h.cat === 'doviz').length,
      emtia: haberler.filter(h => h.cat === 'emtia').length,
    }
  });
});

// Sağlık kontrolü
app.get('/', (req, res) => {
  res.json({
    status: '✅ AnlıkHaber Backend çalışıyor',
    haberSayisi: haberler.length,
    sonGuncelleme: new Date().toLocaleString('tr-TR'),
  });
});

// ============================================================
// ZAMANLANMIŞ GÖREVLER
// ============================================================

// Her 30 dakikada bir RSS tara
cron.schedule('*/30 * * * *', async () => {
  console.log('\n⏰ Zamanlanmış RSS taraması başlıyor...');
  await fetchAndSaveNews();
});

// Her 30 dakikada bir trendleri güncelle
cron.schedule('*/30 * * * *', async () => {
  await getTurkishTrends();
});

// ============================================================
// YARDIMCI
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// SUNUCUYU BAŞLAT
// ============================================================
app.listen(PORT, async () => {
  console.log(`\n🚀 AnlıkHaber Backend başlatıldı — Port: ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api/haberler`);
  console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);

  // Başlangıçta hemen bir tarama yap
  console.log('\n⚡ İlk RSS taraması başlıyor...');
  await fetchAndSaveNews();
});
