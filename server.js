require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const Parser = require('rss-parser');
const slugify = require('slugify');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

let haberler = [];
let postedUrls = new Set();

const twitter = new TwitterApi({
  appKey:       process.env.X_API_KEY,
  appSecret:    process.env.X_API_SECRET,
  accessToken:  process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

// !! User-Agent'ta sadece ASCII karakter — Türkçe harf yok
const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'AnlikHaber/1.0 (+https://anlikhaber.com)' }
});

const RSS_FEEDS = [
  { url: 'https://tr.investing.com/rss/news.rss',                      cat: 'finans',  emoji: '📊', kaynak: 'Investing.com TR' },
  { url: 'https://investing.com/rss/news_1.rss',                       cat: 'doviz',   emoji: '💱', kaynak: 'Investing.com' },
  { url: 'https://investing.com/rss/news_11.rss',                      cat: 'emtia',   emoji: '🥇', kaynak: 'Investing.com' },
  { url: 'https://investing.com/rss/news_14.rss',                      cat: 'ekonomi', emoji: '🏛', kaynak: 'Investing.com' },
  { url: 'https://investing.com/rss/news_25.rss',                      cat: 'borsa',   emoji: '📈', kaynak: 'Investing.com' },
  { url: 'https://cointelegraph.com/rss',                              cat: 'kripto',  emoji: '₿',  kaynak: 'CoinTelegraph' },
  { url: 'https://cnbc.com/id/10000664/device/rss/rss.html',          cat: 'finans',  emoji: '📊', kaynak: 'CNBC' },
  { url: 'https://cnbc.com/id/15839135/device/rss/rss.html',          cat: 'piyasa',  emoji: '📈', kaynak: 'CNBC Markets' },
];

const CAT_TAGS = {
  finans:  ['#finans', '#yatirim'],
  doviz:   ['#dolar', '#kur'],
  emtia:   ['#altin', '#petrol'],
  ekonomi: ['#ekonomi', '#faiz'],
  borsa:   ['#BIST100', '#borsa'],
  kripto:  ['#bitcoin', '#kripto'],
  piyasa:  ['#piyasa', '#borsa'],
};

// Sabit TR finans trendleri — API 403 aldığımız için statik kullanıyoruz
const STATIC_TRENDS = ['#BIST100', '#dolar', '#altin', '#faiz', '#kripto'];

function createSlug(title) {
  return slugify(title, { lower: true, strict: true, trim: true }).substring(0, 80);
}

async function fetchAndSaveNews() {
  console.log('RSS taramasi baslıyor...');
  let yeni = 0;

  for (const feed of RSS_FEEDS) {
    try {
      const feedData = await rssParser.parseURL(feed.url);
      const items = feedData.items.slice(0, 5);

      for (const item of items) {
        const orijinalUrl = item.link || item.url || '';
        const title = (item.title || '').trim();
        if (!title || !orijinalUrl) continue;
        if (haberler.find(h => h.orijinalUrl === orijinalUrl)) continue;

        const slug = createSlug(title);
        const bizimUrl = `https://anlikhaber.com/haber/${slug}`;

        const haber = {
          id: Date.now() + Math.random(),
          slug, title,
          description: item.contentSnippet || item.content || '',
          orijinalUrl, bizimUrl,
          kaynak: feed.kaynak,
          cat: feed.cat,
          emoji: feed.emoji,
          tarih: item.pubDate ? new Date(item.pubDate) : new Date(),
          tweetAtildi: false,
        };

        haberler.unshift(haber);
        yeni++;
        if (haberler.length > 200) haberler = haberler.slice(0, 200);
        console.log('Haber eklendi:', title.substring(0, 60));

        await tweetHaber(haber);
        await sleep(3000);
      }
    } catch (e) {
      console.log('Feed hatasi (' + feed.kaynak + '):', e.message);
    }
  }
  console.log('RSS bitti. ' + yeni + ' yeni haber.');
}

async function tweetHaber(haber) {
  if (haber.tweetAtildi || postedUrls.has(haber.orijinalUrl)) return;
  try {
    const catTags = (CAT_TAGS[haber.cat] || ['#finans']).slice(0, 2).join(' ');
    const trendTags = STATIC_TRENDS.slice(0, 2).join(' ');

    const tweetText = [
      `${haber.emoji} ${haber.title}`,
      ``,
      `🔗 ${haber.bizimUrl}`,
      ``,
      `Kaynak: ${haber.kaynak}`,
      ``,
      `${catTags} ${trendTags} #anlikhaber`,
    ].join('\n').substring(0, 280);

    await twitter.v2.tweet(tweetText);
    haber.tweetAtildi = true;
    postedUrls.add(haber.orijinalUrl);
    console.log('Tweet atildi:', haber.title.substring(0, 50));
  } catch (e) {
    if (e.code === 429) {
      console.log('Rate limit — 15 dk bekleniyor...');
      await sleep(15 * 60 * 1000);
    } else {
      console.log('Tweet hatasi:', e.message);
    }
  }
}

app.get('/api/haberler', (req, res) => {
  const { cat, limit = 50 } = req.query;
  let data = cat && cat !== 'hepsi' ? haberler.filter(h => h.cat === cat) : haberler;
  res.json(data.slice(0, parseInt(limit)));
});

app.get('/api/haber/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if (!haber) return res.status(404).json({ error: 'Bulunamadi' });
  res.json(haber);
});

app.get('/api/stats', (req, res) => {
  res.json({
    toplamHaber: haberler.length,
    tweetAtilanlar: haberler.filter(h => h.tweetAtildi).length,
    sonGuncelleme: new Date().toISOString(),
    trends: STATIC_TRENDS,
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'AnlikHaber Backend calisıyor', haberSayisi: haberler.length });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

cron.schedule('*/30 * * * *', fetchAndSaveNews);

app.listen(PORT, async () => {
  console.log('AnlikHaber Backend - Port:', PORT);
  await fetchAndSaveNews();
});
