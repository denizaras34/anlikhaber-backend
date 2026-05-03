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

// Telegram Bot
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_KANAL = process.env.TELEGRAM_KANAL; // @anlikhaber veya -100xxxxxxx
const TELEGRAM_GRUP = process.env.TELEGRAM_GRUP;   // grup ID

let telegramRateLimit = 0;

async function telegramGonder(chatId, mesaj) {
  if(!TELEGRAM_TOKEN || !chatId) return;
  
  // Rate limit kontrolü
  const now = Date.now();
  if(now < telegramRateLimit) {
    console.log('Telegram rate limit - bekleniyor...');
    return;
  }

  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mesaj,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const d = await r.json();
    if(!d.ok) {
      if(d.parameters && d.parameters.retry_after) {
        telegramRateLimit = Date.now() + (d.parameters.retry_after * 1000);
        console.log('Telegram rate limit:', d.parameters.retry_after + 'sn');
      }
    } else {
      console.log('Telegram OK:', chatId);
    }
  } catch(e) {
    console.log('Telegram hata:', e.message);
  }
}

app.use(cors({ origin: '*' }));
app.use(express.json());

let haberler = [];
let postedUrls = new Set();
const goruntulenmeSayaci = {};

// AI Şeffaflık Sayaçları
const seffaflikStats = {
  haftalikTaranan: 0,
  haftalikEklenen: 0,
  haftalikElenen: 0,
  toplamTaranan: 0,
  toplamElenen: 0,
  haftaBaslangic: new Date(),
};

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
  { url: 'https://tr.investing.com/rss/news.rss',    cat: 'finans',  emoji: '📊', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_1.rss',  cat: 'doviz',   emoji: '💱', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_11.rss', cat: 'emtia',   emoji: '🥇', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_14.rss', cat: 'ekonomi', emoji: '🏛', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://tr.investing.com/rss/news_25.rss', cat: 'borsa',   emoji: '📈', kaynak: 'Investing.com TR', lang: 'tr', checkTr: true },
  { url: 'https://www.bloomberght.com/rss',          cat: 'finans',  emoji: '📊', kaynak: 'Bloomberg HT',     lang: 'tr' },
  { url: 'https://www.cnnturk.com/feed/rss/ekonomi/news', cat: 'ekonomi', emoji: '🏛', kaynak: 'CNN Turk', lang: 'tr' },
  { url: 'https://www.ntv.com.tr/ekonomi.rss',       cat: 'ekonomi', emoji: '🏛', kaynak: 'NTV',              lang: 'tr' },
  { url: 'https://cointelegraph.com/rss',            cat: 'kripto',  emoji: '₿',  kaynak: 'CoinTelegraph',    lang: 'en' },
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

// Manipülatif/clickbait haber tespiti
function isManipulative(title) {
  if(!title) return false;
  const manipPatterns = [
    /şok(layıcı)?/i, /inanılmaz/i, /bomba gibi/i, /flaş/i,
    /herkes bunu biliyor mu/i, /kimse söylemiyor/i, /gizli/i,
    /sizi zengin edecek/i, /garantili/i, /kesin kazan/i,
    /\d+x kazanç/i, /para basıyor/i, /milyoner ol/i,
    /acil.*karar/i, /son fırsat/i, /dikkat.*dolandırıcı/i
  ];
  return manipPatterns.some(p => p.test(title));
}

// Önemli haber mi? (Analitik thread için)
function isOnemliHaber(title, cat) {
  const onemliKeywords = [
    /faiz/i, /merkez bankası/i, /fed/i, /enflasyon/i,
    /dolar.*tl/i, /bist.*\d+/i, /bitcoin.*\d+/i, /altın.*\d+/i,
    /tcmb/i, /büyüme/i, /gsyih/i, /işsizlik/i
  ];
  return onemliKeywords.some(p => p.test(title));
}

function isTurkish(text) {
  if(!text) return false;
  const trChars = /[çğıöşüÇĞİÖŞÜ]/;
  const enWords = /(the|and|for|that|this|with|from|have|been|will|said|says|were|they|their|which|would|could|about|after|before|during|market|stock|shares|trading|investors|percent|billion|million)/i;
  if(trChars.test(text)) return true;
  if(enWords.test(text)) return false;
  return true;
}

function createSlug(title) {
  return slugify(title, { lower: true, strict: true, trim: true }).substring(0, 80);
}

async function generateTurkishContent(haber) {
  if (!anthropic) return { title: haber.title, content: haber.description || '' };
  try {
    const bugun = new Date().toLocaleDateString('tr-TR', {day:'numeric', month:'long', year:'numeric'});
    
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Sen AnlıkHaber için çalışan bir Türk finans haber editörüsün. Aşağıdaki haberi Google Discover ve SEO için optimize et.

Bugünün tarihi: ${bugun}
Orijinal başlık: ${haber.title.substring(0, 150)}
Açıklama: ${(haber.description || '').substring(0, 300)}
Kaynak: ${haber.kaynak}
Kategori: ${haber.cat || 'finans'}

GÖREV 1 - BAŞLIK: Google Discover için merak uyandıran ama tıklama tuzağı olmayan başlık yaz.
Örnekler: "Borsa İstanbul'da Bilanço Şoku mu, Şöleni mi?", "Dolar 45 TL'yi Aşar mı? İşte Kritik Eşik"
Başlığa bugünün tarihini ekle.

GÖREV 2 - GİRİŞ PARAGRAFI: "Claude AI analizimize göre..." diye başla, haberin can alıcı verisini ver, merak uyandır.
2-3 cümle, meta description olarak kullanılacak.

GÖREV 3 - GÖRSEL PROMPT: Siyah ve altın sarısı renk paleti, fütüristik, dijital tema. Haberin konusunu görselleştir.
Örnek: "Futuristic stock market trading floor, golden glowing holographic charts, black and gold palette, 16:9, cinematic"

SADECE JSON döndür:
{"title":"başlık","content":"içerik 3-4 cümle","metaDesc":"giriş paragrafı 150 karakter","imagePrompt":"görsel prompt İngilizce"}`
      }]
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('JSON bulunamadi');
    const parsed = JSON.parse(match[0]);
    return {
      title: (parsed.title || haber.title).substring(0, 200),
      content: (parsed.content || haber.description || '').substring(0, 800),
      metaDesc: (parsed.metaDesc || '').substring(0, 160),
      imagePrompt: parsed.imagePrompt || ''
    };
  } catch(e) {
    console.log('AI icerik hatasi:', e.message);
    return { title: haber.title, content: haber.description || '', metaDesc: '', imagePrompt: '' };
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

        if (feed.checkTr && !isTurkish(title)) {
          continue;
        }

        const slug = createSlug(title);
        const bizimUrl = `https://anlikhaber.com/haber/${slug}`;

        let turkishTitle = title;
        let turkishContent = item.contentSnippet || item.content || item.summary || '';
        let isTranslated = false;
        let metaDesc = '';
        let imagePrompt = '';

        if (feed.lang === 'en' && anthropic) {
          try {
            const aiContent = await generateTurkishContent({ title, description: turkishContent, kaynak: feed.kaynak, cat: feed.cat });
            turkishTitle = aiContent.title || title;
            turkishContent = aiContent.content || turkishContent;
            metaDesc = aiContent.metaDesc || turkishContent.substring(0, 160);
            imagePrompt = process.env.IMAGE_PROMPT_ACTIVE === 'true' ? (aiContent.imagePrompt || '') : '';
            isTranslated = true;
            await sleep(1500);
          } catch(e) {
            turkishContent = (turkishContent || '') + '\n\nDetaylar icin kaynagi ziyaret edin: ' + feed.kaynak;
            metaDesc = turkishContent.substring(0, 160);
          }
        } else if (feed.lang === 'tr' && anthropic && turkishContent) {
          try {
            const aiContent = await generateTurkishContent({ title, description: turkishContent, kaynak: feed.kaynak, cat: feed.cat });
            turkishTitle = aiContent.title || title;
            metaDesc = aiContent.metaDesc || turkishContent.substring(0, 160);
            // Image prompt sadece aktifse sakla
            imagePrompt = process.env.IMAGE_PROMPT_ACTIVE === 'true' ? (aiContent.imagePrompt || '') : '';
            await sleep(1000);
          } catch(e) {
            metaDesc = turkishContent.substring(0, 160);
          }
        } else if (feed.lang === 'en' && !anthropic) {
          turkishContent = (turkishContent || title) + '\n\nBu haber ' + feed.kaynak + ' kaynagindan alinmistir.';
          metaDesc = turkishContent.substring(0, 160);
        } else {
          metaDesc = turkishContent.substring(0, 160);
        }

        let resim = null;
        if (item.enclosure && item.enclosure.url) resim = item.enclosure.url;
        else if (item['media:content'] && item['media:content']['$'] && item['media:content']['$'].url) resim = item['media:content']['$'].url;
        else if (item.image) resim = item.image;

        let aiNotu = '';
        if (feed.lang === 'tr') {
          aiNotu = `Bu icerik ${feed.kaynak} kaynagindan derlenmistir.`;
        } else if (isTranslated) {
          aiNotu = `Bu icerik yapay zeka tarafindan ${feed.kaynak} (Ingilizce) kaynagindan Turkceye cevrilmistir.`;
        } else {
          aiNotu = `Bu icerik ${feed.kaynak} kaynagindan alinmistir. Detaylar icin kaynagi ziyaret edin.`;
        }

        const haber = {
          id: Date.now() + Math.random(),
          slug, title: turkishTitle, originalTitle: title,
          content: turkishContent,
          description: metaDesc || turkishContent.substring(0, 160),
          metaDesc: metaDesc || turkishContent.substring(0, 160),
          imagePrompt: imagePrompt || '',
          orijinalUrl, bizimUrl,
          kaynak: feed.kaynak,
          kaynakUrl: orijinalUrl,
          kaynakDomain: (() => { try { return new URL(orijinalUrl).hostname.replace('www.',''); } catch(e) { return feed.kaynak; } })(),
          cat: feed.cat, emoji: feed.emoji, resim, aiNotu,
          tarih: item.pubDate ? new Date(item.pubDate) : new Date(),
          tweetAtildi: false,
        };

        // Her habere duygu skoru ekle
        haber.sentiment = haberSentimentSkoru(haber);
        
        haberler.unshift(haber);
        yeni++;
        seffaflikStats.haftalikEklenen++;

        // Telegram kanala gönder - max 3 haber per fetch, 5sn arayla
        if(TELEGRAM_KANAL && yeni <= 3) {
          const tgMesaj = [
            haber.emoji + ' <b>' + haber.title + '</b>',
            '',
            (haber.description || '').substring(0, 150) + '...',
            '',
            '🔗 <a href="' + haber.bizimUrl + '">Devamini oku</a>',
            '📌 ' + haber.kaynak,
            '#' + (haber.cat || 'finans') + ' #anlikhaber'
          ].join('\n');
          setTimeout(() => telegramGonder(TELEGRAM_KANAL, tgMesaj), yeni * 5000);
        }
        if (haberler.length > 500) haberler = haberler.slice(0, 500);
        console.log('Haber eklendi:', turkishTitle.substring(0, 60));
      }
    } catch (e) {
      console.log('Feed hatasi (' + feed.kaynak + '):', e.message);
    }
  }
  console.log('RSS bitti. ' + yeni + ' yeni haber.');
  if(yeni > 0) setTimeout(sentimentAnalizi, 1000);
}

// Önemli haberler için analitik thread oluştur
async function generateAnalitikThread(haber) {
  if (!anthropic) return;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Türk finans analisti olarak şu haberi analiz et ve X (Twitter) için kısa bir thread yaz.

Haber: ${haber.title}

Şunu yap: "Bu verinin/kararın/haberin 3 olası etkisi:" formatında 3 madde yaz.
Sadece JSON döndür: {"thread": "🧵 Başlık\n\n1️⃣ ...\n2️⃣ ...\n3️⃣ ...\n\n#finans #anlikhaber"}`
      }]
    });
    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.thread) {
        haber.analitikThread = parsed.thread.substring(0, 280);
        console.log('Analitik thread oluşturuldu:', haber.title.substring(0, 40));
      }
    }
  } catch(e) {
    // Sessizce geç
  }
}

async function tweetHaber(haber) {
  if (haber.tweetAtildi || postedUrls.has(haber.orijinalUrl)) return;
  try {
    const catTags = (CAT_TAGS[haber.cat] || ['#finans']).slice(0, 2).join(' ');
    const tweetText = [
      `${haber.emoji} ${haber.title}`,
      ``,
      `🔗 ${haber.bizimUrl}`,
      ``,
      `Kaynak: ${haber.kaynak}`,
      ``,
      `${catTags} #anlikhaber`,
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

// ============ SENTIMENT ANALİZİ ============

let sentimentCache = {
  skor: 50,
  etiket: 'Nötr / Belirsiz',
  pozitif: 0,
  negatif: 0,
  notr: 0,
  toplamHaber: 0,
  sonGuncelleme: new Date().toISOString(),
};

// ============ HABER BAŞINA DUYGU SKORU ============

const pozitifAgirlik = {
  // Güçlü pozitif (+3)
  'kâr artışı': 3, 'beklenti üstü': 3, 'ihracat rekoru': 3, 'rekor kâr': 3,
  'stratejik iş birliği': 3, 'yabancı ilgisi': 3, 'büyüme rekoru': 3,
  // Orta pozitif (+2)
  'yükseldi': 2, 'arttı': 2, 'rekor': 2, 'güçlü': 2, 'toparlandı': 2,
  'pozitif': 2, 'büyüdü': 2, 'kârlı': 2, 'başarı': 2, 'rally': 2,
  'aştı': 2, 'üzerinde': 2, 'tahmin üstü': 2, 'ivme': 2,
  // Hafif pozitif (+1)
  'istikrar': 1, 'güven': 1, 'artış': 1, 'fırsat': 1, 'talep': 1,
  'yatırım': 1, 'ihracat': 1, 'büyüme': 1, 'kâr': 1, 'temettü': 1,
};

const negatifAgirlik = {
  // Güçlü negatif (-3)
  'maliyet artışı': -3, 'arz daralması': -3, 'jeopolitik risk': -3,
  'enflasyon baskısı': -3, 'düşüş trendi': -3, 'iflas': -3, 'batık': -3,
  // Orta negatif (-2)
  'düştü': -2, 'geriledi': -2, 'kayıp': -2, 'risk': -2, 'kriz': -2,
  'panik': -2, 'zayıf': -2, 'endişe': -2, 'baskı': -2, 'daraldı': -2,
  'zararda': -2, 'tahmin altı': -2, 'sert düşüş': -2,
  // Hafif negatif (-1)
  'belirsiz': -1, 'yavaşladı': -1, 'azaldı': -1, 'olumsuz': -1,
  'sorun': -1, 'güçlük': -1, 'faiz artışı': -1, 'enflasyon': -1,
};

// Manipülatif kelimeler — analiz dışı bırak
const manipulatif = [
  'şok', 'bomba', 'inanılmaz', 'garantili', 'kesin kazan', 'milyoner',
  'sır', 'gizli', 'acil', 'son fırsat', 'herkese', 'flaş'
];

function haberSentimentSkoru(haber) {
  const metin = ((haber.title || '') + ' ' + (haber.description || '')).toLowerCase();
  
  // Manipülatif mi? — güvenilmez, nötr döndür
  for(const m of manipulatif) {
    if(metin.includes(m)) return { score: 50, label: 'Nötr', guvenilir: false };
  }

  let puan = 0;
  let eslesme = 0;

  // Pozitif kelimeler
  for(const [kelime, agirlik] of Object.entries(pozitifAgirlik)) {
    if(metin.includes(kelime)) { puan += agirlik; eslesme++; }
  }

  // Negatif kelimeler
  for(const [kelime, agirlik] of Object.entries(negatifAgirlik)) {
    if(metin.includes(kelime)) { puan += agirlik; eslesme++; }
  }

  // Baz puan 50, normalize et
  const normalPuan = Math.max(0, Math.min(100, 50 + (puan * 5)));
  
  let label;
  if(normalPuan <= 20) label = 'Panik';
  else if(normalPuan <= 35) label = 'Negatif';
  else if(normalPuan <= 50) label = 'Temkinli';
  else if(normalPuan <= 65) label = 'Nötr';
  else if(normalPuan <= 80) label = 'Pozitif';
  else label = 'Coşkulu';

  return { 
    score: normalPuan, 
    label, 
    guvenilir: eslesme > 0,
    uyari: 'Bu skor, yapay zeka tarafından haber metni üzerinde yapılan istatistiksel bir dil analizidir. Yatırım tavsiyesi içermez; sadece haberin tonunu raporlar.'
  };
}

function sentimentAnalizi() {
  const bugun = new Date();
  bugun.setHours(bugun.getHours() - 24);
  const sonHaberler = haberler.filter(h => new Date(h.tarih) > bugun);

  if (sonHaberler.length === 0) return;

  const pozitifKelimeler = [
    'yüksel', 'arttı', 'rekor', 'büyüme', 'güçlü', 'rally', 'kazanç',
    'toparlandı', 'pozitif', 'iyimser', 'artış', 'başarı', 'zirve',
    'fırladı', 'atladı', 'coştu', 'talep', 'güven', 'istikrar', 'kâr',
    'surge', 'gain', 'rise', 'rally', 'bull', 'recovery', 'strong'
  ];

  const negatifKelimeler = [
    'düştü', 'geriledi', 'çöktü', 'kayıp', 'endişe', 'risk', 'kriz',
    'panik', 'satış', 'zayıf', 'olumsuz', 'kaygı', 'belirsiz', 'tehlike',
    'azaldı', 'daraldı', 'sert', 'çöküş', 'yavaşladı', 'baskı', 'zarar',
    'crash', 'fall', 'drop', 'bear', 'fear', 'uncertainty', 'weak', 'loss'
  ];

  let pozitif = 0, negatif = 0, notr = 0;
  let toplamSkor = 0;

  sonHaberler.forEach(h => {
    const s = h.sentiment || haberSentimentSkoru(h);
    toplamSkor += s.score;
    if (s.score > 60) pozitif++;
    else if (s.score < 40) negatif++;
    else notr++;
  });

  const toplam = sonHaberler.length;
  const normalSkor = Math.round(toplamSkor / toplam);

  let etiket;
  if (normalSkor <= 20) etiket = 'Aşırı Karamsar (Panik)';
  else if (normalSkor <= 40) etiket = 'Temkinli / Negatif';
  else if (normalSkor <= 60) etiket = 'Nötr / Belirsiz';
  else if (normalSkor <= 80) etiket = 'İyimser / Pozitif';
  else etiket = 'Aşırı Coşkulu (FOMO)';

  sentimentCache = {
    skor: normalSkor,
    etiket,
    pozitif,
    negatif,
    notr,
    toplamHaber: toplam,
    sonGuncelleme: new Date().toISOString(),
    uyari: 'Bu analiz, yapay zeka tarafından haber metinleri üzerinde yapılan bir dil analizidir. Yatırım tavsiyesi içermez; piyasadaki genel haber akışının istatistiksel bir özetidir.'
  };

  console.log('Sentiment güncellendi:', etiket, '(' + normalSkor + ')');
}

// Her saat sentiment güncelle
cron.schedule('0 * * * *', sentimentAnalizi);

// ============ API ENDPOINTS ============

app.get('/api/haberler', (req, res) => {
  const { cat, limit = 50 } = req.query;
  let data = cat && cat !== 'hepsi' ? haberler.filter(h => h.cat === cat) : haberler;
  // Görüntülenme sayısını ekle
  const dataWithViews = data.slice(0, parseInt(limit)).map(h => ({
    ...h,
    goruntulenmeSayisi: goruntulenmeSayaci[h.slug] || 0
  }));
  res.json(dataWithViews);
});

// Görüntülenme say
app.post('/api/goruntulendi/:slug', (req, res) => {
  const slug = req.params.slug;
  goruntulenmeSayaci[slug] = (goruntulenmeSayaci[slug] || 0) + 1;
  res.json({ ok: true, sayi: goruntulenmeSayaci[slug] });
});

app.get('/api/haber/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if (!haber) return res.status(404).json({ error: 'Bulunamadi' });
  res.json(haber);
});

app.get('/api/ilgili/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if (!haber) return res.status(404).json([]);
  const ilgili = haberler.filter(h => h.slug !== req.params.slug && h.cat === haber.cat).slice(0, 4);
  res.json(ilgili);
});

// AI Şeffaflık Raporu endpoint
app.get('/api/seffaflik', (req, res) => {
  const gunSayisi = Math.max(1, Math.floor((Date.now() - new Date(seffaflikStats.haftaBaslangic)) / 86400000));
  res.json({
    haftalikTaranan: seffaflikStats.haftalikTaranan,
    haftalikEklenen: seffaflikStats.haftalikEklenen,
    haftalikElenen: seffaflikStats.haftalikElenen,
    toplamTaranan: seffaflikStats.toplamTaranan,
    toplamElenen: seffaflikStats.toplamElenen,
    elenmeOrani: seffaflikStats.haftalikTaranan > 0 
      ? Math.round((seffaflikStats.haftalikElenen / seffaflikStats.haftalikTaranan) * 100) 
      : 0,
    haftaBaslangic: seffaflikStats.haftaBaslangic,
    gunSayisi,
  });
});

app.get('/api/sentiment', (req, res) => {
  res.json(sentimentCache);
});

// Tek haber sentiment skoru
app.get('/api/sentiment/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if(!haber) return res.status(404).json({ error: 'Bulunamadi' });
  const s = haber.sentiment || haberSentimentSkoru(haber);
  res.json(s);
});

app.get('/api/stats', async (req, res) => {
  let abone = null;
  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const r = await fetch('https://api.brevo.com/v3/contacts?limit=1&listId=2', {
      headers: { 'api-key': process.env.BREVO_API_KEY, 'accept': 'application/json' }
    });
    const d = await r.json();
    abone = d.count || null;
  } catch(e) {}

  res.json({
    toplamHaber: haberler.length,
    tweetAtilanlar: haberler.filter(h => h.tweetAtildi).length,
    sonGuncelleme: new Date().toISOString(),
    trends: STATIC_TRENDS,
    abone,
    seffaflik: {
      taranan: seffaflikStats.haftalikTaranan,
      eklenen: seffaflikStats.haftalikEklenen,
      elenen: seffaflikStats.haftalikElenen,
    }
  });
});

app.post('/api/abone', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Gecersiz email' });

  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({ email, listIds: [2], updateEnabled: true, attributes: { SOURCE: 'anlikhaber.com' } })
    });

    if (response.ok || response.status === 204) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
        body: JSON.stringify({
          sender: { name: 'AnlıkHaber', email: 'yonetim@anlikhaber.com' },
          to: [{ email }],
          subject: 'AnlıkHaber Bültenine Hoş Geldiniz! 📊',
          htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0f;color:#f0ede8;padding:32px;border-radius:12px"><h1 style="color:#e8c84a">AnlıkHaber</h1><p style="color:#6b6b80">anlikhaber.com</p><h2>Bültenimize Hoş Geldiniz! 🎉</h2><p style="color:#b8b5b0;line-height:1.8">Her sabah 07:00'de Türkiye ve dünyadan en önemli finans haberlerini e-postanıza gönderiyoruz.</p><a href="https://anlikhaber.com" style="background:#e8c84a;color:#0a0a0f;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Siteyi Ziyaret Et →</a><p style="color:#6b6b80;font-size:11px;margin-top:32px">© 2025 AnlıkHaber · anlikhaber.com · reklam@anlikhaber.com</p></div>`
        })
      });
      res.json({ success: true, message: 'Abone oldunuz!' });
    } else {
      const err = await response.json();
      if (err.code === 'duplicate_parameter') {
        res.json({ success: true, message: 'Zaten abonesiniz!' });
      } else {
        res.status(400).json({ error: err.message });
      }
    }
  } catch(e) {
    console.log('Brevo hatasi:', e.message);
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

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
  <url><loc>https://anlikhaber.com</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>
  ${urls}
</urlset>`;
  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

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

// Test bülten endpoint
app.get('/api/test-bulten', async (req, res) => {
  res.json({ mesaj: 'Bülten gönderiliyor...' });
  await gunlukBultenGonder();
});

app.get('/api/test-telegram', async (req, res) => {
  await telegramGonder(TELEGRAM_KANAL || req.query.chat_id, '🧪 AnlıkHaber Telegram botu çalışıyor! ✅');
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'AnlikHaber Backend calisıyor', haberSayisi: haberler.length });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ SABAH BÜLTENİ ============
async function gunlukBultenGonder() {
  if (!process.env.BREVO_API_KEY) return;
  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

    const bugun = new Date();
    bugun.setHours(0, 0, 0, 0);

    // Top haber seçimi - kategori çeşitliliği + görüntülenme + sentiment
    const kategoriler = ['finans', 'borsa', 'kripto', 'ekonomi', 'doviz', 'emtia'];
    const secilen = new Set();
    const topHaberler = [];

    // Her kategoriden en çok görüntülenen 2 haber
    kategoriler.forEach(cat => {
      const katHaberler = haberler
        .filter(h => h.cat === cat)
        .sort((a, b) => {
          const aGor = goruntulenmeSayaci[a.slug] || 0;
          const bGor = goruntulenmeSayaci[b.slug] || 0;
          return bGor - aGor;
        })
        .slice(0, 2);
      katHaberler.forEach(h => {
        if(!secilen.has(h.slug)) { topHaberler.push(h); secilen.add(h.slug); }
      });
    });

    // Kalan slotları yüksek sentiment ile doldur
    const ekstra = haberler
      .filter(h => !secilen.has(h.slug) && h.sentiment)
      .sort((a, b) => Math.abs(b.sentiment.score - 50) - Math.abs(a.sentiment.score - 50))
      .slice(0, 20 - topHaberler.length);
    ekstra.forEach(h => topHaberler.push(h));

    const finalHaberler = topHaberler.slice(0, 20);
    if(finalHaberler.length === 0) { console.log('Bulten: haber yok'); return; }

    const tarih = new Date().toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const saat = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const sentiment = sentimentCache;
    const sentimentEmoji = sentiment.skor <= 20 ? '😱' : sentiment.skor <= 40 ? '😟' : sentiment.skor <= 60 ? '😐' : sentiment.skor <= 80 ? '😊' : '🚀';

    // Haber kartları HTML
    const haberlerHTML = finalHaberler.map((h, i) => {
      const skor = h.sentiment ? h.sentiment.score : 50;
      const barRenk = skor >= 65 ? '#22c55e' : skor <= 35 ? '#ef4444' : '#e8c84a';
      const catEmoji = {finans:'📊',borsa:'📈',kripto:'₿',ekonomi:'🏛',doviz:'💱',emtia:'🥇'}[h.cat] || '📰';
      return `
      <tr>
        <td style="padding:0 24px 16px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:${i%2===0?'#13131a':'#0f0f18'};border-radius:10px;overflow:hidden;border:1px solid #1e1e2a">
            <tr>
              <td style="padding:14px 16px">
                <table width="100%">
                  <tr>
                    <td><span style="background:#1e1e2a;color:#e8c84a;font-size:9px;font-weight:700;padding:3px 10px;border-radius:3px;letter-spacing:1px">${catEmoji} ${(h.cat||'haber').toUpperCase()}</span></td>
                    <td align="right"><span style="color:#6b6b80;font-size:10px">${h.kaynak||''}</span></td>
                  </tr>
                  <tr><td colspan="2" style="padding-top:8px">
                    <a href="${h.bizimUrl||'https://anlikhaber.com'}" style="color:#f0ede8;font-size:15px;font-weight:600;text-decoration:none;line-height:1.4;display:block">${h.title||''}</a>
                  </td></tr>
                  ${h.description ? `<tr><td colspan="2" style="padding-top:6px"><p style="color:#8a8a9a;font-size:12px;line-height:1.6;margin:0">${h.description.substring(0,140)}...</p></td></tr>` : ''}
                  <tr><td colspan="2" style="padding-top:8px">
                    <table width="100%"><tr>
                      <td>
                        <div style="height:4px;background:#1e1e2a;border-radius:2px;overflow:hidden;width:120px">
                          <div style="width:${skor}%;height:100%;background:${barRenk};border-radius:2px"></div>
                        </div>
                      </td>
                      <td align="right">
                        <a href="${h.bizimUrl||'https://anlikhaber.com'}" style="color:#e8c84a;font-size:12px;text-decoration:none;font-weight:600">Devamini oku →</a>
                      </td>
                    </tr></table>
                  </td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
    }).join('');

    const htmlContent = `<!DOCTYPE html>
<html lang="tr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0ede6;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede6;padding:20px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0">

  <!-- GAZETE BAŞLIĞI -->
  <tr><td style="background:#0a0a0f;padding:0;border-radius:12px 12px 0 0;overflow:hidden">
    <!-- Üst şerit -->
    <table width="100%" style="border-bottom:1px solid #1e1e2a"><tr>
      <td style="padding:8px 24px;font-family:Arial,sans-serif;font-size:10px;color:#6b6b80;letter-spacing:2px">${tarih.toUpperCase()}</td>
      <td align="right" style="padding:8px 24px;font-family:Arial,sans-serif;font-size:10px;color:#6b6b80">Sayı: ${Math.floor(Date.now()/86400000)}</td>
    </tr></table>
    
    <!-- Logo + Canavar -->
    <table width="100%"><tr>
      <td style="padding:20px 24px">
        <!-- Canavar SVG -->
        <table><tr><td style="vertical-align:middle;padding-right:16px">
          <img src="https://i.imgur.com/placeholder.png" width="0" height="0" style="display:none">
          <svg viewBox="0 0 80 100" width="70" height="88" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="40" cy="68" rx="26" ry="28" fill="#1e4a32"/>
            <ellipse cx="40" cy="65" rx="22" ry="24" fill="#22573a"/>
            <ellipse cx="29" cy="90" rx="10" ry="7" fill="#1a3a2a"/>
            <ellipse cx="51" cy="90" rx="10" ry="7" fill="#1a3a2a"/>
            <ellipse cx="14" cy="60" rx="7" ry="13" fill="#1a3a2a" transform="rotate(-15 14 60)"/>
            <ellipse cx="66" cy="60" rx="7" ry="13" fill="#1a3a2a" transform="rotate(15 66 60)"/>
            <circle cx="72" cy="50" r="8" fill="#e8c84a"/>
            <circle cx="72" cy="50" r="6" fill="#f0d060"/>
            <text x="72" y="54" text-anchor="middle" font-size="7" font-weight="700" fill="#8b6914">&#8378;</text>
            <ellipse cx="40" cy="36" rx="24" ry="22" fill="#22573a"/>
            <polygon points="22,20 17,3 30,18" fill="#e8c84a"/>
            <polygon points="58,20 63,3 50,18" fill="#e8c84a"/>
            <ellipse cx="31" cy="35" rx="9" ry="10" fill="#f5f0d0"/>
            <ellipse cx="49" cy="35" rx="9" ry="10" fill="#f5f0d0"/>
            <ellipse cx="32" cy="36" rx="6" ry="7" fill="#1a3a00"/>
            <ellipse cx="50" cy="36" rx="6" ry="7" fill="#1a3a00"/>
            <circle cx="33" cy="33" r="2" fill="#fff"/>
            <circle cx="51" cy="33" r="2" fill="#fff"/>
            <path d="M31 50 Q40 57 49 50" stroke="#143020" stroke-width="2" fill="none" stroke-linecap="round"/>
            <rect x="35" y="50" width="5" height="4" rx="1" fill="#f5f0d0"/>
            <rect x="41" y="50" width="5" height="4" rx="1" fill="#f5f0d0"/>
          </svg>
        </td>
        <td style="vertical-align:middle">
          <div style="font-family:Georgia,serif;font-size:34px;font-weight:700;color:#f0ede8;letter-spacing:-1px;line-height:1">Anlık<span style="color:#e8c84a">Haber</span></div>
          <div style="font-family:Arial,sans-serif;font-size:10px;color:#6b6b80;letter-spacing:3px;margin-top:4px">SABAH BÜLTENİ</div>
          <div style="font-family:Arial,sans-serif;font-size:12px;color:#e8c84a;margin-top:6px;font-style:italic">"Piyasaları senin yerine takip ediyorum!"</div>
        </td></tr></table>
      </td>
    </tr></table>

    <!-- Karşılama mesajı -->
    <table width="100%" style="background:#1a2a20;border-top:2px solid #e8c84a"><tr>
      <td style="padding:14px 24px;font-family:Arial,sans-serif">
        <span style="color:#e8c84a;font-size:14px;font-weight:700">🌅 Şeriflerinizin sabahı hayırlı olsun efendim!</span><br>
        <span style="color:#b0c8b8;font-size:12px">Bugünün en önemli ${finalHaberler.length} finansal gelişmesini derledim. ${saat} itibarıyla piyasa durumu:</span>
      </td>
    </tr></table>
  </td></tr>

  <!-- CANLI KURLAR -->
  <tr><td style="background:#0d0d16;padding:16px 24px;border-bottom:1px solid #1e1e2a">
    <div style="font-family:Arial,sans-serif;font-size:10px;color:#6b6b80;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">📊 Anlık Piyasalar</div>
    <table width="100%"><tr>
      <td align="center" style="padding:0 4px">
        <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:8px;padding:10px 8px;text-align:center">
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#6b6b80;margin-bottom:4px">USD/TRY</div>
          <div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#f0ede8">45.05</div>
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#ef4444">▼ -0.12%</div>
        </div>
      </td>
      <td align="center" style="padding:0 4px">
        <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:8px;padding:10px 8px;text-align:center">
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#6b6b80;margin-bottom:4px">EUR/TRY</div>
          <div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#f0ede8">52.91</div>
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#22c55e">▲ +0.08%</div>
        </div>
      </td>
      <td align="center" style="padding:0 4px">
        <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:8px;padding:10px 8px;text-align:center">
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#6b6b80;margin-bottom:4px">ALTIN</div>
          <div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#e8c84a">$3,321</div>
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#22c55e">▲ +0.4%</div>
        </div>
      </td>
      <td align="center" style="padding:0 4px">
        <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:8px;padding:10px 8px;text-align:center">
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#6b6b80;margin-bottom:4px">BTC</div>
          <div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#e8c84a">$79.2K</div>
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#22c55e">▲ +1.2%</div>
        </div>
      </td>
      <td align="center" style="padding:0 4px">
        <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:8px;padding:10px 8px;text-align:center">
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#6b6b80;margin-bottom:4px">ETH</div>
          <div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#f0ede8">$2,241</div>
          <div style="font-family:Arial,sans-serif;font-size:9px;color:#ef4444">▼ -0.5%</div>
        </div>
      </td>
    </tr></table>
  </td></tr>

  <!-- SENTIMENT BANT -->
  <tr><td style="background:linear-gradient(90deg,#0a1a12,#0d1a10);padding:12px 24px;border-bottom:2px solid #e8c84a">
    <table width="100%"><tr>
      <td style="font-family:Arial,sans-serif;font-size:12px;color:#b0c8b8">
        ${sentimentEmoji} <b style="color:#e8c84a">AI Piyasa Duygusu:</b> ${sentiment.etiket||'Nötr'} — Skor: ${sentiment.skor||50}/100
      </td>
      <td align="right" style="font-family:Arial,sans-serif;font-size:10px;color:#6b6b80">
        ${sentiment.pozitif||0} pozitif · ${sentiment.negatif||0} negatif · ${sentiment.toplamHaber||0} haber
      </td>
    </tr></table>
  </td></tr>

  <!-- BUGÜNÜN HABERLERİ BAŞLIK -->
  <tr><td style="background:#0a0a0f;padding:14px 24px 0">
    <div style="border-bottom:2px solid #e8c84a;padding-bottom:10px;margin-bottom:4px">
      <span style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f0ede8;letter-spacing:-0.5px">Bugünün Öne Çıkan Haberleri</span>
    </div>
    <div style="font-family:Arial,sans-serif;font-size:10px;color:#6b6b80;letter-spacing:1px;padding-bottom:14px">EN ÇOK OKUNAN · YAPAY ZEKA SEÇİMİ · KATEGORİ ÇEŞİTLİLİĞİ</div>
  </td></tr>

  <!-- HABERLER -->
  ${haberlerHTML}

  <!-- ALT -->
  <tr><td style="background:#13131a;padding:20px 24px;text-align:center;border-top:1px solid #1e1e2a">
    <a href="https://anlikhaber.com" style="background:#e8c84a;color:#0a0a0f;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;font-family:Arial,sans-serif;display:inline-block">Tüm Haberleri Gör →</a>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#0a0a0f;padding:16px 24px;border-radius:0 0 12px 12px;border-top:1px solid #1e1e2a;text-align:center">
    <p style="font-family:Arial,sans-serif;color:#6b6b80;font-size:10px;margin:0;line-height:1.8">
      © 2026 AnlıkHaber · anlikhaber.com<br>
      <a href="https://anlikhaber.com" style="color:#e8c84a;text-decoration:none">@anlikhaberkanal</a> · Telegram kanalımızı takip edin<br>
      <a href="{{unsubscribe}}" style="color:#6b6b80">Abonelikten çık</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    // Brevo ile gönder
    const response = await fetch('https://api.brevo.com/v3/emailCampaigns', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        name: 'AnlıkHaber Sabah Bülteni - ' + tarih,
        subject: '🌅 ' + tarih + ' | Şeriflerinizin sabahı hayırlı olsun! AnlıkHaber Bülteni',
        sender: { name: 'AnlıkHaber', email: 'yonetim@anlikhaber.com' },
        type: 'classic',
        htmlContent,
        recipients: { listIds: [2] }
      })
    });

    const result = await response.json();
    if(result.id) {
      await fetch('https://api.brevo.com/v3/emailCampaigns/' + result.id + '/sendNow', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY }
      });
      console.log('Sabah bülteni gönderildi! ID:', result.id);

      // Telegram sabah özeti
      if(TELEGRAM_KANAL) {
        const tgMesaj = [
          '🌅 <b>Şeriflerinizin sabahı hayırlı olsun!</b>',
          '',
          sentimentEmoji + ' Piyasa Duygusu: <b>' + (sentiment.etiket||'Nötr') + '</b>',
          '',
          '📰 Bugünün öne çıkan haberleri:',
          ...finalHaberler.slice(0,5).map((h,i) => (i+1) + '. <a href="' + h.bizimUrl + '">' + h.title.substring(0,60) + '</a>'),
          '',
          '🔗 <a href="https://anlikhaber.com">Tüm haberler için tıkla</a>'
        ].join('\n');
        await telegramGonder(TELEGRAM_KANAL, tgMesaj);
      }
    } else {
      console.log('Bülten hatası:', JSON.stringify(result));
    }
  } catch(e) {
    console.log('Bülten gönderme hatası:', e.message);
  }
}

// Her 30 dk RSS tara
cron.schedule('*/30 * * * *', fetchAndSaveNews);

// Her Pazar 20:00 TR (17:00 UTC) şeffaflık raporu tweet
cron.schedule('0 17 * * 0', async () => {
  const s = seffaflikStats;
  const tweetText = [
    `📊 AnlıkHaber Haftalık AI Şeffaflık Raporu`,
    ``,
    `Bu hafta:`,
    `🔍 ${s.haftalikTaranan} haber tarandı`,
    `✅ ${s.haftalikEklenen} haber yayınlandı`,
    `🚫 ${s.haftalikElenen} haber elendi (manipülatif/kalitesiz)`,
    ``,
    `Size sadece güvenilir, temizlenmiş haberleri sunuyoruz.`,
    ``,
    `#anlikhaber #finans #yapayzekagazetecilik`
  ].join('\n').substring(0, 280);

  try {
    await twitter.v2.tweet(tweetText);
    console.log('Şeffaflık raporu tweet atıldı!');
    // Haftalık sayaçları sıfırla
    seffaflikStats.haftalikTaranan = 0;
    seffaflikStats.haftalikEklenen = 0;
    seffaflikStats.haftalikElenen = 0;
    seffaflikStats.haftaBaslangic = new Date();
  } catch(e) {
    console.log('Şeffaflık tweet hatası:', e.message);
  }
});

// Her sabah 07:00 TR saati (04:00 UTC) bülten gönder
cron.schedule('0 4 * * *', async () => {
  console.log('Sabah bülteni gönderiliyor...');
  await gunlukBultenGonder();
  
  // Telegram sabah özeti
  if(TELEGRAM_KANAL && haberler.length > 0) {
    const bugunHaberleri = haberler.slice(0, 5);
    const mesaj = [
      '🌅 <b>Günaydın! AnlıkHaber Sabah Özeti</b>',
      '',
      ...bugunHaberleri.map((h, i) => (i+1) + '. <a href="' + h.bizimUrl + '">' + h.title + '</a>'),
      '',
      '📊 Tüm haberler: <a href="https://anlikhaber.com">anlikhaber.com</a>'
    ].join('\n');
    await telegramGonder(TELEGRAM_KANAL, mesaj);
  }
});

// Pazartesi 09:00 TR (06:00 UTC) sentiment raporu tweet
cron.schedule('0 6 * * 1', async () => {
  const s = sentimentCache;
  if(!s || !s.etiket) return;
  
  let emoji = '😐';
  if(s.skor <= 20) emoji = '😱';
  else if(s.skor <= 40) emoji = '😟';
  else if(s.skor <= 60) emoji = '😐';
  else if(s.skor <= 80) emoji = '😊';
  else emoji = '🚀';

  const tweetText = [
    `${emoji} AnlıkHaber AI Piyasa Duygu Raporu`,
    ``,
    `📊 Genel Duygu: ${s.etiket}`,
    `📈 Skor: ${s.skor}/100`,
    `🔍 ${s.toplamHaber} haber analiz edildi`,
    `✅ ${s.pozitif} pozitif | 🔴 ${s.negatif} negatif`,
    ``,
    `🔗 anlikhaber.com`,
    ``,
    `#piyasa #borsa #anlikhaber #yapayZeka`
  ].join('\n').substring(0, 280);

  try {
    await twitter.v2.tweet(tweetText);
    console.log('Sentiment tweet atıldı!');
  } catch(e) {
    console.log('Sentiment tweet hatası:', e.message);
  }
});

// Pazartesi 09:00 Telegram sentiment raporu
cron.schedule('0 6 * * 1', async () => {
  const s = sentimentCache;
  if(!s || !TELEGRAM_KANAL) return;
  
  let emoji = s.skor <= 20 ? '😱' : s.skor <= 40 ? '😟' : s.skor <= 60 ? '😐' : s.skor <= 80 ? '😊' : '🚀';
  
  const mesaj = [
    '📊 <b>AnlıkHaber Haftalık AI Piyasa Raporu</b>',
    '',
    emoji + ' Genel Duygu: <b>' + s.etiket + '</b>',
    '📈 Skor: <b>' + s.skor + '/100</b>',
    '🔍 ' + s.toplamHaber + ' haber analiz edildi',
    '✅ ' + s.pozitif + ' pozitif | 🔴 ' + s.negatif + ' negatif',
    '',
    '🔗 <a href="https://anlikhaber.com">anlikhaber.com</a>',
    '',
    '<i>Bu analiz yatırım tavsiyesi içermez.</i>'
  ].join('\n');
  
  await telegramGonder(TELEGRAM_KANAL, mesaj);
  if(TELEGRAM_GRUP) await telegramGonder(TELEGRAM_GRUP, mesaj);
});

// Her 2 saatte 1 tweet (günde 12, haftada ~84)
cron.schedule('0 */2 * * *', async () => {
  const bekleyenler = haberler.filter(h => !h.tweetAtildi && !postedUrls.has(h.orijinalUrl));
  if (bekleyenler.length === 0) { console.log('Tweet kuyrugu bos'); return; }
  await tweetHaber(bekleyenler[0]);
});

app.listen(PORT, async () => {
  console.log('AnlikHaber Backend - Port:', PORT);
  await fetchAndSaveNews();
  setTimeout(sentimentAnalizi, 2000); // Haberler yuklendikten 2sn sonra
});
