require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const Parser = require('rss-parser');
const slugify = require('slugify');
const Anthropic = require('@anthropic-ai/sdk');

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

let anthropic = null;
if (process.env.CLAUDE_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  console.log('Claude AI aktif');
}

const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'AnlikHaber/1.0 (+https://anlikhaber.com)' }
});

const RSS_FEEDS = [
  // ===== TÜRKÇE KAYNAKLAR (önce bunlar çekilir) =====
  { url: 'https://tr.investing.com/rss/news.rss',                          cat: 'finans',  emoji: '📊', kaynak: 'Investing.com TR',  lang: 'tr' },
  { url: 'https://investing.com/rss/news_1.rss',                           cat: 'doviz',   emoji: '💱', kaynak: 'Investing.com TR',  lang: 'tr' },
  { url: 'https://investing.com/rss/news_11.rss',                          cat: 'emtia',   emoji: '🥇', kaynak: 'Investing.com TR',  lang: 'tr' },
  { url: 'https://investing.com/rss/news_14.rss',                          cat: 'ekonomi', emoji: '🏛', kaynak: 'Investing.com TR',  lang: 'tr' },
  { url: 'https://investing.com/rss/news_25.rss',                          cat: 'borsa',   emoji: '📈', kaynak: 'Investing.com TR',  lang: 'tr' },
  { url: 'https://www.haberturk.com/rss/ekonomi.xml',                      cat: 'ekonomi', emoji: '🏛', kaynak: 'Haberturk',         lang: 'tr' },
  { url: 'https://www.haberturk.com/rss/borsa.xml',                        cat: 'borsa',   emoji: '📈', kaynak: 'Haberturk',         lang: 'tr' },
  { url: 'https://www.bloomberght.com/rss',                                 cat: 'finans',  emoji: '📊', kaynak: 'Bloomberg HT',      lang: 'tr' },
  { url: 'https://www.cnnturk.com/feed/rss/ekonomi/news',                  cat: 'ekonomi', emoji: '🏛', kaynak: 'CNN Turk',          lang: 'tr' },
  { url: 'https://www.ntv.com.tr/ekonomi.rss',                             cat: 'ekonomi', emoji: '🏛', kaynak: 'NTV',               lang: 'tr' },
  { url: 'https://feeds.feedburner.com/paraAnaliz',                        cat: 'analiz',  emoji: '🔍', kaynak: 'Para Analiz',       lang: 'tr' },
  // ===== İNGİLİZCE KAYNAKLAR (AI çevirir) =====
  { url: 'https://cointelegraph.com/rss',                                   cat: 'kripto',  emoji: '₿',  kaynak: 'CoinTelegraph',     lang: 'en' },
  { url: 'https://cnbc.com/id/10000664/device/rss/rss.html',               cat: 'finans',  emoji: '📊', kaynak: 'CNBC',              lang: 'en' },
  { url: 'https://cnbc.com/id/15839135/device/rss/rss.html',               cat: 'piyasa',  emoji: '📈', kaynak: 'CNBC Markets',      lang: 'en' },
  { url: 'https://feeds.bloomberg.com/markets/news.rss',                   cat: 'piyasa',  emoji: '📈', kaynak: 'Bloomberg',         lang: 'en' },
  { url: 'https://feeds.reuters.com/reuters/businessNews',                  cat: 'ekonomi', emoji: '🏛', kaynak: 'Reuters',           lang: 'en' },
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

const STATIC_TRENDS = ['#BIST100', '#dolar', '#altin', '#faiz', '#kripto'];

function createSlug(title) {
  return slugify(title, { lower: true, strict: true, trim: true }).substring(0, 80);
}

// AI ile Türkçe içerik oluştur
async function generateTurkishContent(haber) {
  if (!anthropic) return { title: haber.title, content: haber.description || '' };
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Bu haber başlığını ve açıklamasını Türkçeye çevir ve kısa bir haber makalesi yaz (3-4 paragraf). 
        
Başlık: ${haber.title}
Açıklama: ${haber.description || ''}
Kaynak: ${haber.kaynak}

Sadece JSON formatında dön: {"title": "Türkçe başlık", "content": "Türkçe içerik"}`
      }]
    });
    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    console.log('AI içerik hatası:', e.message);
    return { title: haber.title, content: haber.description || '' };
  }
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

        // Türkçe/İngilizce içerik işleme
        let turkishTitle = title;
        let turkishContent = item.contentSnippet || item.content || item.summary || '';
        let isTranslated = false;

        if (feed.lang === 'en' && anthropic) {
          // İngilizce kaynak — AI ile Türkçeye çevir
          try {
            const aiContent = await generateTurkishContent({
              title, description: turkishContent, kaynak: feed.kaynak
            });
            turkishTitle = aiContent.title || title;
            turkishContent = aiContent.content || turkishContent;
            isTranslated = true;
            await sleep(1500);
          } catch(e) {
            // AI çevirisi başarısız — orijinal + not ekle
            turkishContent = (turkishContent || '') + '\n\nDetaylar için kaynağı ziyaret edin: ' + feed.kaynak;
          }
        } else if (feed.lang === 'en' && !anthropic) {
          // AI yok — İngilizce habere not ekle
          turkishContent = (turkishContent || title) + '\n\nBu haber ' + feed.kaynak + ' kaynağından alınmıştır. Detaylar için kaynağı ziyaret edin.';
        }

        // Resim çek — RSS'den veya Open Graph'tan
        let resim = null;
        if (item.enclosure && item.enclosure.url) {
          resim = item.enclosure.url;
        } else if (item['media:content'] && item['media:content']['$'] && item['media:content']['$'].url) {
          resim = item['media:content']['$'].url;
        } else if (item.image) {
          resim = item.image;
        }

        // AI notu
        let aiNotu = '';
        if (feed.lang === 'tr') {
          aiNotu = `Bu içerik ${feed.kaynak} kaynağından derlenmiştir.`;
        } else if (isTranslated) {
          aiNotu = `Bu içerik yapay zeka tarafından ${feed.kaynak} (İngilizce) kaynağından Türkçeye çevrilmiştir.`;
        } else {
          aiNotu = `Bu içerik ${feed.kaynak} kaynağından alınmıştır. Detaylar için kaynağı ziyaret edin.`;
        }

        const haber = {
          id: Date.now() + Math.random(),
          slug,
          title: turkishTitle,
          originalTitle: title,
          content: turkishContent,
          description: turkishContent.substring(0, 300),
          orijinalUrl,
          bizimUrl,
          kaynak: feed.kaynak,
          kaynakUrl: orijinalUrl,
          kaynakDomain: new URL(orijinalUrl).hostname.replace('www.',''),
          cat: feed.cat,
          emoji: feed.emoji,
          resim,
          aiNotu,
          tarih: item.pubDate ? new Date(item.pubDate) : new Date(),
          tweetAtildi: false,
        };

        haberler.unshift(haber);
        yeni++;
        if (haberler.length > 500) haberler = haberler.slice(0, 500);
        console.log('Haber eklendi:', turkishTitle.substring(0, 60));

        await tweetHaber(haber);
        await sleep(2000);
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

// API ENDPOINTS
app.get('/api/haberler', (req, res) => {
  const { cat, limit = 50 } = req.query;
  let data = cat && cat !== 'hepsi' ? haberler.filter(h => h.cat === cat) : haberler;
  res.json(data.slice(0, parseInt(limit)));
});

// Haber detay sayfası — slug ile
app.get('/api/haber/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if (!haber) return res.status(404).json({ error: 'Bulunamadi' });
  res.json(haber);
});

// İlgili haberler
app.get('/api/ilgili/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if (!haber) return res.status(404).json([]);
  const ilgili = haberler
    .filter(h => h.slug !== req.params.slug && h.cat === haber.cat)
    .slice(0, 4);
  res.json(ilgili);
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
