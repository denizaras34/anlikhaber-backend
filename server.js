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

async function telegramGonder(chatId, mesaj) {
  if(!TELEGRAM_TOKEN || !chatId) return;
  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mesaj,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });
    const d = await r.json();
    if(!d.ok) console.log('Telegram hata:', JSON.stringify(d));
    else console.log('Telegram OK:', chatId);
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

        // Telegram kanala gönder
        if(TELEGRAM_KANAL) {
          const tgMesaj = [
            haber.emoji + ' <b>' + haber.title + '</b>',
            '',
            (haber.description || '').substring(0, 200) + '...',
            '',
            '🔗 <a href="' + haber.bizimUrl + '">Devamını oku</a>',
            '📌 Kaynak: ' + haber.kaynak,
            '',
            '#' + (haber.cat || 'finans') + ' #anlikhaber'
          ].join('\n');
          setTimeout(() => telegramGonder(TELEGRAM_KANAL, tgMesaj), yeni * 2000);
        }
        if (haberler.length > 500) haberler = haberler.slice(0, 500);
        console.log('Haber eklendi:', turkishTitle.substring(0, 60));
      }
    } catch (e) {
      console.log('Feed hatasi (' + feed.kaynak + '):', e.message);
    }
  }
  console.log('RSS bitti. ' + yeni + ' yeni haber.');
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
    
    // Bugünün haberlerini al
    const bugun = new Date();
    bugun.setHours(0, 0, 0, 0);
    const bugunHaberleri = haberler
      .filter(h => new Date(h.tarih) >= bugun)
      .sort((a, b) => {
        // Önce görüntülenme sayısına göre sırala
        const aGor = goruntulenmeSayaci[a.slug] || 0;
        const bGor = goruntulenmeSayaci[b.slug] || 0;
        if(bGor !== aGor) return bGor - aGor;
        // Eşitse tarihe göre sırala
        return new Date(b.tarih) - new Date(a.tarih);
      })
      .slice(0, 20);

    if (bugunHaberleri.length === 0) {
      console.log('Bülten: Yeterli haber yok');
      return;
    }

    const tarih = new Date().toLocaleDateString('tr-TR', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });

    // Haber HTML'i oluştur
    const haberlerHTML = bugunHaberleri.map((h, i) => `
      <tr>
        <td style="padding:16px 32px;background:${i % 2 === 0 ? '#13131a' : '#0a0a0f'};border-bottom:1px solid #1e1e2a">
          <table width="100%">
            <tr>
              <td>
                <span style="background:#1e1e2a;color:#e8c84a;font-size:9px;font-weight:700;padding:3px 8px;border-radius:3px;letter-spacing:1px;text-transform:uppercase">
                  ${h.emoji || '📊'} ${(h.cat || 'haber').toUpperCase()}
                </span>
              </td>
              <td align="right">
                <span style="color:#6b6b80;font-size:10px">${h.kaynak || ''}</span>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding-top:8px">
                <a href="${h.bizimUrl || 'https://anlikhaber.com'}" style="color:#f0ede8;font-size:15px;font-weight:600;text-decoration:none;line-height:1.4;display:block">
                  ${h.title || ''}
                </a>
              </td>
            </tr>
            ${h.description ? `<tr><td colspan="2" style="padding-top:6px"><p style="color:#b8b5b0;font-size:12px;line-height:1.6;margin:0">${h.description.substring(0, 150)}...</p></td></tr>` : ''}
            <tr>
              <td colspan="2" style="padding-top:10px">
                <a href="${h.bizimUrl || 'https://anlikhaber.com'}" style="color:#e8c84a;font-size:12px;text-decoration:none;font-weight:500">
                  Devamını oku →
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`).join('');

    const htmlContent = `<!DOCTYPE html>
<html lang="tr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f2eb;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2eb;padding:20px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#0a0a0f;border-radius:12px;overflow:hidden">
  <tr><td style="background:#0a0a0f;padding:28px 32px;border-bottom:2px solid #e8c84a">
    <table width="100%"><tr>
      <td><span style="font-size:26px;font-weight:900;color:#f0ede8;font-family:Georgia,serif">Anlık<span style="color:#e8c84a">Haber</span></span><br>
      <span style="font-size:11px;color:#6b6b80;letter-spacing:1px">anlikhaber.com · Sabah Bülteni</span></td>
      <td align="right"><span style="font-size:12px;color:#6b6b80">${tarih}</span><br>
      <span style="background:#ef4444;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px">● CANLI</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#c0392b;padding:10px 32px">
    <span style="font-size:11px;color:#fff;font-weight:500">🔴 Bugünün en önemli ${bugunHaberleri.length} haberi</span>
  </td></tr>
  <tr><td style="padding:20px 32px 8px;background:#13131a">
    <p style="color:#b8b5b0;font-size:14px;line-height:1.7;margin:0">
      Günaydın! Bugün piyasalarda öne çıkan gelişmeleri derledik.
    </p>
  </td></tr>
  ${haberlerHTML}
  <tr><td style="padding:24px 32px;background:#13131a;text-align:center">
    <a href="https://anlikhaber.com" style="background:#e8c84a;color:#0a0a0f;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block">
      Tüm Haberleri Gör →
    </a>
  </td></tr>
  <tr><td style="padding:20px 32px;background:#0a0a0f;border-top:1px solid #1e1e2a;text-align:center">
    <p style="color:#6b6b80;font-size:11px;margin:0;line-height:1.8">
      © 2025 AnlıkHaber · anlikhaber.com · reklam@anlikhaber.com<br>
      <a href="{{unsubscribe}}" style="color:#e8c84a">Abonelikten çık</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    // Brevo kampanya API ile gönder
    const response = await fetch('https://api.brevo.com/v3/emailCampaigns', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        name: `AnlıkHaber Sabah Bülteni - ${tarih}`,
        subject: `📊 ${tarih} - Bugünün Finans Haberleri`,
        sender: { name: 'AnlıkHaber', email: 'yonetim@anlikhaber.com' },
        type: 'classic',
        htmlContent,
        recipients: { listIds: [2] }
      })
    });

    const result = await response.json();
    
    if (result.id) {
      // Kampanyayı hemen gönder
      await fetch(`https://api.brevo.com/v3/emailCampaigns/${result.id}/sendNow`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': process.env.BREVO_API_KEY
        }
      });
      console.log('Sabah bülteni gönderildi! Kampanya ID:', result.id);
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
  sentimentAnalizi();
});
