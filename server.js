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
  { url: 'https://tr.investing.com/rss/news.rss',  cat: 'finans',  emoji: '📊', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_1.rss',  cat: 'doviz',   emoji: '💱', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_11.rss', cat: 'emtia',   emoji: '🥇', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_14.rss', cat: 'ekonomi', emoji: '🏛', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_25.rss', cat: 'borsa',   emoji: '📈', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://www.haberturk.com/rss/finans.xml',                      cat: 'ekonomi', emoji: '🏛', kaynak: 'Haberturk',         lang: 'tr' },
  // { url: 'https://www.haberturk.com/rss/borsa.xml',                        cat: 'borsa',   emoji: '📈', kaynak: 'Haberturk',         lang: 'tr' },
  { url: 'https://www.bloomberght.com/rss',                                 cat: 'finans',  emoji: '📊', kaynak: 'Bloomberg HT',      lang: 'tr' },
  { url: 'https://www.cnnturk.com/feed/rss/ekonomi/news',                  cat: 'ekonomi', emoji: '🏛', kaynak: 'CNN Turk',          lang: 'tr' },
  { url: 'https://www.ntv.com.tr/ekonomi.rss',                             cat: 'ekonomi', emoji: '🏛', kaynak: 'NTV',               lang: 'tr' },
  { url: 'https://feeds.feedburner.com/paraAnaliz',                        cat: 'analiz',  emoji: '🔍', kaynak: 'Para Analiz',       lang: 'tr' },
  // ===== İNGİLİZCE KAYNAKLAR (sadece kripto - AI çevirir) =====
  { url: 'https://cointelegraph.com/rss', cat: 'kripto', emoji: '₿', kaynak: 'CoinTelegraph', lang: 'en' },
  // Bloomberg ve Reuters geçici kapalı - çok fazla İngilizce haber geliyor
  // { url: 'https://feeds.bloomberg.com/markets/news.rss', cat: 'piyasa', emoji: '📈', kaynak: 'Bloomberg', lang: 'en' },
  // { url: 'https://feeds.reuters.com/reuters/businessNews', cat: 'ekonomi', emoji: '🏛', kaynak: 'Reuters', lang: 'en' },
  // { url: 'https://cnbc.com/id/10000664/device/rss/rss.html', cat: 'finans', emoji: '📊', kaynak: 'CNBC', lang: 'en' },
  // { url: 'https://cnbc.com/id/15839135/device/rss/rss.html', cat: 'piyasa', emoji: '📈', kaynak: 'CNBC Markets', lang: 'en' },
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

// Türkçe karakter kontrolü
function isTurkish(text) {
  if(!text) return false;
  const trChars = /[çğıöşüÇĞİÖŞÜ]/;
  const enWords = /(the|and|for|that|this|with|from|have|been|will|said|says|were|they|their|which|would|could|about|after|before|during|market|stock|shares|trading|investors|percent|billion|million)/i;
  if(trChars.test(text)) return true;
  if(enWords.test(text)) return false;
  return true;
}

function createSlug(title) {
  return slugify(title, { lower: true, strict: true, trim: true }).substring(0, 80);
}

// AI ile Türkçe içerik oluştur
async function generateTurkishContent(haber) {
  if (!anthropic) return { title: haber.title, content: haber.description || '' };
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Translate this financial news to Turkish. Return ONLY valid JSON, no extra text.

Title: ${haber.title.substring(0, 100)}
Description: ${(haber.description || '').substring(0, 200)}

Return: {"title":"Turkish title here","content":"Turkish content 2-3 sentences here"}`
      }]
    });
    const text = response.content[0].text.trim();
    // JSON'u güvenli şekilde parse et
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('JSON bulunamadı');
    const parsed = JSON.parse(match[0]);
    return {
      title: (parsed.title || haber.title).substring(0, 200),
      content: (parsed.content || haber.description || '').substring(0, 500)
    };
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
        
        // Türkçe kaynak ama İngilizce haber geliyorsa atla
        if (feed.checkTr && !isTurkish(title)) {
          console.log('TR kaynaktan İngilizce haber atlandı:', title.substring(0,50));
          continue;
        }

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

        // Tweet saatlik cron ile atılacak
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
      console.log('Rate limit — 5 dk bekleniyor...');
      await sleep(5 * 60 * 1000);
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

// Sitemap endpoint - Google için
app.get('/sitemap.xml', (req, res) => {
  const urls = haberler.slice(0, 100).map(h => `
  <url>
    <loc>${h.bizimUrl || 'https://anlikhaber.com'}</loc>
    <lastmod>${new Date(h.tarih || Date.now()).toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://anlikhaber.com</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  ${urls}
</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// Brevo Email Abonelik Endpoint
app.post('/api/abone', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Geçersiz email' });
  }

  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    
    // Brevo'ya abone ekle
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        email,
        listIds: [2],
        updateEnabled: true,
        attributes: {
          SOURCE: 'anlikhaber.com'
        }
      })
    });

    if (response.ok || response.status === 204) {
      // Hoşgeldin maili gönder
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
          sender: { name: 'AnlıkHaber', email: 'yonetim@anlikhaber.com' },
          to: [{ email }],
          subject: 'AnlıkHaber Bültenine Hoş Geldiniz! 📊',
          htmlContent: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0f;color:#f0ede8;padding:32px;border-radius:12px">
              <h1 style="color:#e8c84a;font-size:28px;margin-bottom:8px">AnlıkHaber</h1>
              <p style="color:#6b6b80;font-size:12px;margin-bottom:32px">anlikhaber.com</p>
              <h2 style="font-size:22px;margin-bottom:16px">Bültenimize Hoş Geldiniz! 🎉</h2>
              <p style="color:#b8b5b0;line-height:1.8;margin-bottom:20px">
                Her sabah 07:00'de Türkiye ve dünyadan en önemli finans haberlerini, 
                piyasa gelişmelerini ve ekonomi analizlerini e-postanıza gönderiyoruz.
              </p>
              <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:8px;padding:20px;margin-bottom:24px">
                <h3 style="color:#e8c84a;margin-bottom:12px">Bültenimizde neler var?</h3>
                <ul style="color:#b8b5b0;line-height:2;padding-left:20px">
                  <li>📈 BIST 100 ve dünya borsaları</li>
                  <li>💱 Döviz ve altın güncellemeleri</li>
                  <li>₿ Kripto para haberleri</li>
                  <li>🏛 Ekonomi ve Merkez Bankası gelişmeleri</li>
                  <li>📊 Uzman analizleri</li>
                </ul>
              </div>
              <a href="https://anlikhaber.com" style="background:#e8c84a;color:#0a0a0f;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">
                Siteyi Ziyaret Et →
              </a>
              <p style="color:#6b6b80;font-size:11px;margin-top:32px">
                Bu maili almak istemiyorsanız <a href="#" style="color:#e8c84a">abonelikten çıkın</a>.<br>
                © 2025 AnlıkHaber · anlikhaber.com · reklam@anlikhaber.com
              </p>
            </div>
          `
        })
      });

      res.json({ success: true, message: 'Abone oldunuz!' });
    } else {
      const err = await response.json();
      // Zaten abone ise de başarılı say
      if (err.code === 'duplicate_parameter') {
        res.json({ success: true, message: 'Zaten abonesiniz!' });
      } else {
        res.status(400).json({ error: err.message });
      }
    }
  } catch(e) {
    console.log('Brevo hatası:', e.message);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Sitemap endpoint - Google SEO için
app.get('/sitemap.xml', (req, res) => {
  const urls = haberler.slice(0, 100).map(h => `
  <url>
    <loc>${h.bizimUrl || 'https://anlikhaber.com'}</loc>
    <lastmod>${new Date(h.tarih || Date.now()).toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://anlikhaber.com</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  ${urls}
</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// RSS Feed endpoint - Zapier için
app.get('/rss', (req, res) => {
  const items = haberler.slice(0, 20).map(h => `
    <item>
      <title><![CDATA[${h.title || ''}]]></title>
      <link>${h.bizimUrl || h.orijinalUrl || ''}</link>
      <description><![CDATA[${h.description || ''}]]></description>
      <pubDate>${new Date(h.tarih || Date.now()).toUTCString()}</pubDate>
      <guid>${h.bizimUrl || h.orijinalUrl || ''}</guid>
      <category>${h.cat || 'finans'}</category>
    </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>AnlıkHaber - Son Dakika Finans Haberleri</title>
    <link>https://anlikhaber.com</link>
    <description>Türkiye ve dünyadan anlık finans haberleri</description>
    <language>tr</language>
    ${items}
  </channel>
</rss>`;

  res.set('Content-Type', 'application/rss+xml');
  res.send(xml);
});

app.get('/', (req, res) => {
  res.json({ status: 'AnlikHaber Backend calisıyor', haberSayisi: haberler.length });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

cron.schedule('*/30 * * * *', fetchAndSaveNews);

// Günde 10 tweet - her 2.5 saatte bir 1 tweet (haftada ~70 tweet)
cron.schedule('0 */2 * * *', async () => {
  const bekleyenler = haberler.filter(h => !h.tweetAtildi && !postedUrls.has(h.orijinalUrl));
  
  if (bekleyenler.length === 0) {
    console.log('Tweet kuyruğu boş');
    return;
  }

  const haber = bekleyenler[0];
  await tweetHaber(haber);
  console.log('Tweet gönderildi:', haber.title.substring(0, 50));
});

app.listen(PORT, async () => {
  console.log('AnlikHaber Backend - Port:', PORT);
  await fetchAndSaveNews();
});
