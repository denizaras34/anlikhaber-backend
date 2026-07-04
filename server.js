require('dotenv').config();
// v2 modülleri devre dışı — monolitle devam (bkz. server_patch.js / modules/)
// const { anlikHaberModulleriniBaslat } = require('./server_patch');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const Parser = require('rss-parser');
const slugify = require('slugify');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb, haberEkle, haberGuncelle, sonHaberler, haberSayisi } = require('./db/init');
const app = express();

// Top-level fetch — her fonksiyonda tekrar tanımlamaktan kaçın
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Model sabitleri — tek yerden yönet
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-5';  // Derin analiz / premium içerik

// Yardımcı: retry wrapper (max 2 deneme, 3sn bekleme)
async function withRetry(fn, retries = 2, delayMs = 3000) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      console.log(`[retry ${i+1}/${retries}]`, e.message);
      await sleep(delayMs);
    }
  }
}

// Yardımcı: JSON bloğunu metinden çıkar (iç içe JSON'u da yakalar)
function extractJSON(text) {
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON bloğu bulunamadı');
  return JSON.parse(text.slice(start, end + 1));
}
const PORT = process.env.PORT || 3000;
// Telegram Bot
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_KANAL = process.env.TELEGRAM_KANAL;
const TELEGRAM_GRUP = process.env.TELEGRAM_GRUP;
let telegramRateLimit = 0;
async function telegramGonder(chatId, mesaj) {
  if(!TELEGRAM_TOKEN || !chatId) return;
  const now = Date.now();
  if(now < telegramRateLimit) {
    console.log('Telegram rate limit - bekleniyor...');
    return;
  }
  try {
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
  const yabanciKarakteler = /[؀-ۿݐ-ݿ֐-׿一-鿿぀-ヿ가-힯]/;
  if(yabanciKarakteler.test(text)) return false;
  const trChars = /[çğıöşüÇĞİÖŞÜ]/;
  if(trChars.test(text)) return true;
  const enWords = /(the |and |for |that |this |with |from |have |been |will |said |says |were |they |their |which |would |could |about |after |before |during |market|stock|shares|trading|investors|percent|billion|million)/i;
  if(enWords.test(text)) return false;
  return true;
}
function createSlug(title) {
  return slugify(title, { lower: true, strict: true, trim: true }).substring(0, 80);
}
async function generateTurkishContent(haber) {
  if (!anthropic) return { title: haber.title, content: haber.description || '' };
  try {
    const gun = new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
    const response = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Türk finans editörü. SADECE JSON döndür.
Başlık: ${haber.title.substring(0, 120)}
İçerik: ${(haber.description || '').substring(0, 200)}
Kaynak: ${haber.kaynak} | Kategori: ${haber.cat || 'finans'} | Tarih: ${gun}
{"title":"SEO başlık tarih içersin max 80 karakter","content":"3 cümle özet","metaDesc":"150 karakter meta","imagePrompt":"fintech dark gold 16:9 cinematic"}`
      }]
    });
    const parsed = extractJSON(response.content[0].text.trim());
    return {
      title:       (parsed.title || haber.title).substring(0, 200),
      content:     (parsed.content || haber.description || '').substring(0, 600),
      metaDesc:    (parsed.metaDesc || '').substring(0, 160),
      imagePrompt: parsed.imagePrompt || ''
    };
  } catch(e) {
    console.log('[AI içerik] hata:', e.message);
    return { title: haber.title, content: haber.description || '', metaDesc: '', imagePrompt: '' };
  }
}
// og:image çekme — sadece RSS'te resim bulunamayan haberler için (tarama başına maks OG_FETCH_LIMIT)
const OG_FETCH_LIMIT = 10;
let ogFetchCount = 0;
async function fetchOgImage(url) {
  if (!url || !url.startsWith('http')) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (AnlikHaberBot)' } });
    if (!r.ok) return null;
    const html = await r.text();
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (og && og[1]) return og[1];
    const tw = html.match(/<meta[^>]+(?:name|property)=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']twitter:image["']/i);
    if (tw && tw[1]) return tw[1];
    return null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let fetchRunning = false;
async function fetchAndSaveNews() {
  if (fetchRunning) { console.log('[RSS] Önceki tarama devam ediyor, atlanıyor.'); return; }
  fetchRunning = true;
  ogFetchCount = 0;
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
        if (feed.checkTr && !isTurkish(title)) continue;
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
        } else if (feed.lang === 'tr' && anthropic) {
          try {
            const aiContent = await generateTurkishContent({ title, description: turkishContent, kaynak: feed.kaynak, cat: feed.cat });
            turkishTitle = aiContent.title || title;
            turkishContent = aiContent.content || turkishContent;
            metaDesc = aiContent.metaDesc || turkishContent.substring(0, 160);
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
        const isValidImg = (url) => url && url.startsWith('http') && !url.includes('base64') && !url.endsWith('=.jpg') && !url.includes('=.jpg?');
        if (item.enclosure && item.enclosure.url && isValidImg(item.enclosure.url)) resim = item.enclosure.url;
        else if (item['media:content'] && item['media:content']['$'] && isValidImg(item['media:content']['$'].url)) resim = item['media:content']['$'].url;
        else if (item.image && isValidImg(item.image)) resim = item.image;
        if (!resim && ogFetchCount < OG_FETCH_LIMIT) {
          ogFetchCount++;
          const og = await fetchOgImage(orijinalUrl);
          if (og && isValidImg(og)) resim = og;
        }
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
        haber.sentiment = haberSentimentSkoru(haber);
        if (!haber.content || !haber.content.trim()) {
          console.log('[RSS] Govde bos, atlandi:', (haber.title||'').substring(0,50));
          continue;
        }
        haberler.unshift(haber);
        try { haberEkle(haber); } catch(e) { console.log('[DB] haberEkle hata:', e.message); }
        yeni++;
        seffaflikStats.haftalikEklenen++;
        if(TELEGRAM_KANAL && yeni <= 3) {
          const tgMesaj = [
            haber.emoji + ' <b>' + haber.title + '</b>',
            '',
            (haber.description || '').substring(0, 150) + '...',
            '',
            '🔗 <a href="' + haber.bizimUrl + '">Devamını oku</a>',
            '📌 ' + haber.kaynak,
            '#' + (haber.cat || 'finans') + ' #anlikhaber'
          ].join('\n');
          setTimeout(() => telegramGonder(TELEGRAM_KANAL, tgMesaj), yeni * 5000);
          if(TELEGRAM_GRUP) setTimeout(() => telegramGonder(TELEGRAM_GRUP, tgMesaj), yeni * 5000 + 1000);
        }
        if (haberler.length > 500) haberler = haberler.slice(0, 500);
        console.log('Haber eklendi:', turkishTitle.substring(0, 60));
      }
    } catch (e) {
      console.log('Feed hatasi (' + feed.kaynak + '):', e.message);
    }
  }
  console.log('RSS bitti. ' + yeni + ' yeni haber.');
  fetchRunning = false;
  if(yeni > 0) setTimeout(sentimentAnalizi, 1000);
}
async function generateAnalitikThread(haber) {
  if (!anthropic) return;
  try {
    const response = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `X thread yaz. SADECE JSON.
Haber: ${haber.title.substring(0, 100)}
{"thread":"🧵 Başlık\n\n1️⃣ etki\n2️⃣ etki\n3️⃣ etki\n\n#finans #anlikhaber"}`
      }]
    });
    const parsed = extractJSON(response.content[0].text.trim());
    if (parsed) {
      if (parsed.thread) {
        haber.analitikThread = parsed.thread.substring(0, 280);
        console.log('Analitik thread oluşturuldu:', haber.title.substring(0, 40));
      }
    }
  } catch(e) {}
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
    try { haberGuncelle(haber.slug, { tweetAtildi: true }); } catch(e) {}
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
// ============ ANKET SİSTEMİ ============
let anketler = [];
let anketOylar = {};
const ANKET_DURUM = { TASLAK: 'taslak', ONAYLANDI: 'onaylandi', REDDEDILDI: 'reddedildi', YAYINDA: 'yayinda', TAMAMLANDI: 'tamamlandi' };
async function anketSorusuUret() {
  if (!anthropic) { console.log('[anket] Claude API kapalı (CLAUDE_API_KEY eksik)'); return null; }
  try {
    const gundem = haberler.slice(0, 20).map(h => h.title).filter(Boolean).join('\n');
    // Haberler henüz yüklenmediyse varsayılan gündem kullan
    const gundemMetni = gundem.length > 10
      ? gundem.substring(0, 500)
      : 'Dolar/TL kuru, altın fiyatları, Bitcoin, BIST100, Merkez Bankası faiz kararı, enflasyon';

    const response = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: `Türk finans haberleri için bir anket sorusu üret.

Güncel haberler / gündem:
${gundemMetni}

Kurallar:
- Soru altın, BTC, dolar/TL, faiz veya emtia hakkında olsun
- Akademik, tarafsız Türkçe kullan
- Seçenekler sabit: Katılıyorum / Katılmıyorum / Kararsızım

Şu JSON formatında yanıt ver (başka hiçbir şey yazma):
{"soru":"...","konu":"altin","aciklama":"..."}`
      }]
    });

    const raw = response.content[0]?.text?.trim() || '';
    console.log('[anket] Ham yanıt:', raw.substring(0, 120));
    const parsed = extractJSON(raw);
    if (!parsed?.soru) throw new Error('soru alanı eksik');
    return parsed;
  } catch(e) {
    console.error('[anket] Üretim hatası:', e.message);
    return null;
  }
}
cron.schedule('0 15 * * 0', async () => {
  console.log('Haftalık anket soruları üretiliyor...');
  const sorular = [];
  const konular = ['altin', 'btc', 'usd', 'eur', 'emtia'];
  for(const konu of konular) {
    await sleep(2000);
    const soru = await anketSorusuUret();
    if(soru) {
      const anket = {
        id: 'anket_' + Date.now() + '_' + konu,
        soru: soru.soru,
        konu: soru.konu || konu,
        aciklama: soru.aciklama || '',
        durum: ANKET_DURUM.TASLAK,
        olusturmaTarihi: new Date().toISOString(),
        yayinTarihi: null,
        tweetId: null,
        oylar: { katiliyorum: 0, katilmiyorum: 0, kararsizim: 0 },
        adminNotu: ''
      };
      anketler.push(anket);
      sorular.push(anket);
      console.log('Anket taslak:', anket.soru.substring(0, 50));
    }
  }
  if(TELEGRAM_KANAL && sorular.length > 0) {
    const mesaj = [
      '📋 <b>Yeni Anket Soruları Admin Onayı Bekliyor</b>',
      '',
      sorular.map((s, i) => `${i+1}. ${s.soru.substring(0, 80)}...`).join('\n'),
      '',
      '⚠️ Onaylamak için admin paneline girin.',
      '🔗 anlikhaber.com/admin'
    ].join('\n');
    await telegramGonder(TELEGRAM_KANAL, mesaj);
  }
  console.log(`${sorular.length} anket sorusu oluşturuldu, admin onayı bekliyor.`);
});
cron.schedule('0 6 * * *', async () => {
  const bugun = new Date().getDay();
  const gunSirasi = { 1: 0, 3: 1, 5: 2, 0: 3, 2: 4 };
  const siraNo = gunSirasi[bugun];
  if(siraNo === undefined) return;
  const onaylilar = anketler
    .filter(a => a.durum === ANKET_DURUM.ONAYLANDI)
    .sort((a, b) => new Date(a.olusturmaTarihi) - new Date(b.olusturmaTarihi));
  if(onaylilar.length === 0) return;
  const anket = onaylilar[0];
  if(process.env.X_API_KEY) {
    try {
      const konuEmoji = { altin: '🥇', btc: '₿', usd: '💵', eur: '💶', emtia: '🛢', faiz: '📈' };
      const emoji = konuEmoji[anket.konu] || '📊';
      const tweetText = [
        `${emoji} AnlıkHaber Haftalık Anket`,
        ``,
        `📌 ${anket.soru}`,
        ``,
        `1️⃣ Katılıyorum`,
        `2️⃣ Katılmıyorum`,
        `3️⃣ Kararsızım`,
        ``,
        `#${anket.konu} #anket #finans #anlikhaber`
      ].join('\n').substring(0, 280);
      const tweet = await twitter.v2.tweet(tweetText);
      anket.tweetId = tweet.data.id;
      anket.durum = ANKET_DURUM.YAYINDA;
      anket.yayinTarihi = new Date().toISOString();
      console.log('Anket tweeti atıldı:', anket.soru.substring(0, 50));
    } catch(e) {
      console.log('Anket tweet hatası:', e.message);
    }
  }
});
cron.schedule('0 * * * *', async () => {
  const simdi = new Date();
  const yayindakiler = anketler.filter(a => {
    if(a.durum !== ANKET_DURUM.YAYINDA || !a.yayinTarihi) return false;
    const fark = (simdi - new Date(a.yayinTarihi)) / (1000 * 60 * 60);
    return fark >= 72;
  });
  for(const anket of yayindakiler) {
    const oylar = anketOylar[anket.id] || { katiliyorum: 0, katilmiyorum: 0, kararsizim: 0 };
    const toplam = oylar.katiliyorum + oylar.katilmiyorum + oylar.kararsizim;
    if(toplam === 0) { anket.durum = ANKET_DURUM.TAMAMLANDI; continue; }
    const pKati = Math.round(oylar.katiliyorum / toplam * 100);
    const pKatil = Math.round(oylar.katilmiyorum / toplam * 100);
    const pKarar = 100 - pKati - pKatil;
    const konuEmoji = { altin: '🥇', btc: '₿', usd: '💵', eur: '💶', emtia: '🛢', faiz: '📈' };
    const emoji = konuEmoji[anket.konu] || '📊';
    const tweetText = [
      `${emoji} AnlıkHaber Anket Sonucu`,
      ``,
      `"${anket.soru.substring(0, 100)}"`,
      ``,
      `✅ Katılıyorum: %${pKati}`,
      `❌ Katılmıyorum: %${pKatil}`,
      `🤔 Kararsızım: %${pKarar}`,
      ``,
      `👥 Toplam ${toplam} oy`,
      ``,
      `#${anket.konu} #anketsonucu #finans #anlikhaber`
    ].join('\n').substring(0, 280);
    try {
      await twitter.v2.tweet(tweetText);
      anket.durum = ANKET_DURUM.TAMAMLANDI;
      anket.sonuclar = { pKati, pKatil, pKarar, toplam };
      console.log('Anket sonuç tweeti atıldı:', anket.soru.substring(0, 50));
      if(TELEGRAM_KANAL) await telegramGonder(TELEGRAM_KANAL, tweetText);
    } catch(e) {
      console.log('Sonuç tweet hatası:', e.message);
    }
    await sleep(3000);
  }
});
// ============ ANKET API ============
app.get('/api/anketler', (req, res) => {
  res.json(anketler.map(a => ({ ...a, oylar: anketOylar[a.id] || { katiliyorum: 0, katilmiyorum: 0, kararsizim: 0 } })));
});
app.get('/api/anket/aktif', (req, res) => {
  const aktif = anketler.find(a => a.durum === ANKET_DURUM.YAYINDA);
  if(!aktif) return res.json(null);
  const oylar = anketOylar[aktif.id] || { katiliyorum: 0, katilmiyorum: 0, kararsizim: 0 };
  const toplam = oylar.katiliyorum + oylar.katilmiyorum + oylar.kararsizim;
  res.json({ ...aktif, oylar, toplam });
});
app.post('/api/anket/:id/oy', (req, res) => {
  const { oy } = req.body;
  const anket = anketler.find(a => a.id === req.params.id);
  if(!anket || anket.durum !== ANKET_DURUM.YAYINDA) return res.status(400).json({ error: 'Anket aktif değil' });
  if(!['katiliyorum','katilmiyorum','kararsizim'].includes(oy)) return res.status(400).json({ error: 'Geçersiz oy' });
  if(!anketOylar[anket.id]) anketOylar[anket.id] = { katiliyorum: 0, katilmiyorum: 0, kararsizim: 0 };
  anketOylar[anket.id][oy]++;
  res.json({ ok: true, oylar: anketOylar[anket.id] });
});
app.post('/api/anket/:id/onayla', (req, res) => {
  const anket = anketler.find(a => a.id === req.params.id);
  if(!anket) return res.status(404).json({ error: 'Bulunamadı' });
  anket.durum = ANKET_DURUM.ONAYLANDI;
  anket.adminNotu = req.body.not || '';
  res.json({ ok: true });
});
app.post('/api/anket/:id/reddet', (req, res) => {
  const anket = anketler.find(a => a.id === req.params.id);
  if(!anket) return res.status(404).json({ error: 'Bulunamadı' });
  anket.durum = ANKET_DURUM.REDDEDILDI;
  anket.adminNotu = req.body.not || '';
  res.json({ ok: true });
});
app.get('/api/anket/uret', async (req, res) => {
  try {
    const soru = await anketSorusuUret();
    if (!soru || !soru.soru) {
      const neden = !anthropic ? 'CLAUDE_API_KEY tanımlı değil' : 'AI geçerli JSON döndürmedi — Railway loglarını kontrol et';
      return res.status(500).json({ error: neden });
    }
    const anket = {
      id: 'anket_' + Date.now(),
      soru: soru.soru, konu: soru.konu, aciklama: soru.aciklama || '',
      durum: ANKET_DURUM.TASLAK,
      olusturmaTarihi: new Date().toISOString(),
      yayinTarihi: null, tweetId: null,
      oylar: { katiliyorum: 0, katilmiyorum: 0, kararsizim: 0 },
      adminNotu: ''
    };
    anketler.push(anket);
    console.log('[anket] Manuel üretildi:', anket.soru.substring(0, 50));
    res.json({ ok: true, anket });
  } catch(e) {
    console.error('[anket/uret] hata:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ============ DERİN ANALİZ ============
let derinAnalizler = [];
async function derinAnalizUret() {
  if(!anthropic) return;
  const onemliHaberler = haberler
    .filter(h => h.sentiment && h.title)
    .filter(h => ['ekonomi','borsa','doviz','finans','kripto'].includes(h.cat))
    .sort((a, b) => Math.abs(b.sentiment.score - 50) - Math.abs(a.sentiment.score - 50))
    .slice(0, 5);
  if(onemliHaberler.length === 0) return;
  const yeniAnalizler = [];
  for(const haber of onemliHaberler) {
    if(derinAnalizler.find(a => a.haberSlug === haber.slug)) continue;
    try {
      await sleep(2000);
      const analiz = await withRetry(async () => {
        const response = await anthropic.messages.create({
          model: MODEL_SONNET,
          max_tokens: 900,
          messages: [{
            role: 'user',
            content: `Türk finans analisti. Haber için "AnlıkHaber Yorumu" üret, SADECE JSON döndür.
ÖNEMLİ: Geçmişe dair spesifik tarih, rakam veya yüzde UYDURMA; haberde geçmeyen sayısal veri verme. izlenecekGostergeler alanında yalnızca yatırımcının GELECEKTE takip etmesi gereken olay/veri türlerini yaz, kesin tarih verme (örn. "sonraki Fed toplantısı", "açıklanacak TCMB faiz kararı").
Başlık: ${haber.title.substring(0, 120)}
Özet: ${(haber.description || '').substring(0, 200)}
Kategori: ${haber.cat} | Duygu: ${haber.sentiment.score}/100
{"giris":"2-3 cümle, haberi bağlama oturtan açıklayıcı giriş","turkYatirimciEtki":"2-3 cümle, Türk yatırımcı için somut etki kanalları","riskler":"2-3 cümle olası riskler","firsatlar":"2-3 cümle olası fırsatlar","izlenecekGostergeler":["gelecekte izlenecek olay/veri türü 1","tür 2","tür 3"],"xThread":"max 200 karakter emoji ile","uyari":"Bu yorum yatırım tavsiyesi değildir."}`
          }]
        });
        return extractJSON(response.content[0].text.trim());
      });
      const derinAnaliz = {
        id: 'analiz_' + Date.now(),
        haberSlug: haber.slug,
        haberTitle: haber.title,
        haberCat: haber.cat,
        sentimentSkor: haber.sentiment.score,
        sentimentLabel: haber.sentiment.label,
        tarih: new Date().toISOString(),
        ...analiz
      };
      derinAnalizler.unshift(derinAnaliz);
      yeniAnalizler.push(derinAnaliz);
      if(derinAnalizler.length > 20) derinAnalizler = derinAnalizler.slice(0, 20);
      // haber, haberler dizisindeki canlı referansın kendisi (filter referans korur) — doğrudan iliştir (xThread hariç)
      haber.yorum = {
        giris: analiz.giris,
        turkYatirimciEtki: analiz.turkYatirimciEtki,
        riskler: analiz.riskler,
        firsatlar: analiz.firsatlar,
        izlenecekGostergeler: analiz.izlenecekGostergeler,
        uyari: analiz.uyari
      };
      try { haberGuncelle(haber.slug, { yorum: haber.yorum }); } catch(e) {}
      console.log('Derin analiz üretildi:', haber.title.substring(0, 50));
      if(analiz.xThread && process.env.X_API_KEY) {
        try {
          await sleep(3000);
          const tweetText = (analiz.xThread + '\n\n🔗 ' + haber.bizimUrl + '\n#anlikhaber #analiz').substring(0, 280);
          await twitter.v2.tweet(tweetText);
        } catch(e) { console.log('Analiz tweet hatası:', e.message); }
      }
      if(TELEGRAM_KANAL && analiz.giris) {
        const konuEmoji = {finans:'📊',borsa:'📈',kripto:'₿',ekonomi:'🏛',doviz:'💱',emtia:'🥇'};
        const emoji = konuEmoji[haber.cat] || '📊';
        const tgMesaj = [
          emoji + ' <b>AnlıkHaber Yorumu</b>',
          '',
          '<b>' + haber.title + '</b>',
          '',
          '📝 ' + analiz.giris,
          '',
          '📈 Türk yatırımcı için etki:',
          analiz.turkYatirimciEtki || '',
          '',
          '⚠️ ' + analiz.uyari,
          '',
          '🔗 <a href="' + haber.bizimUrl + '">Haberi oku</a>'
        ].join('\n');
        await telegramGonder(TELEGRAM_KANAL, tgMesaj);
        if(TELEGRAM_GRUP) await telegramGonder(TELEGRAM_GRUP, tgMesaj);
      }
    } catch(e) {
      console.error('[derinAnaliz] HATA:', e.message, '| Haber:', haber.title.substring(0, 60));
    }
  }
  return yeniAnalizler;
}
cron.schedule('0 */4 * * *', derinAnalizUret);
app.get('/api/analizler', (req, res) => res.json(derinAnalizler));
app.get('/api/analiz/:slug', (req, res) => {
  const analiz = derinAnalizler.find(a => a.haberSlug === req.params.slug);
  if(!analiz) return res.status(404).json(null);
  res.json(analiz);
});
app.get('/api/analiz-uret', async (req, res) => {
  res.json({ mesaj: 'Analiz üretiliyor...' });
  derinAnalizUret();
});
// ============ SENTIMENT ============
const pozitifAgirlik = {
  'kâr artışı': 3, 'beklenti üstü': 3, 'ihracat rekoru': 3, 'rekor kâr': 3,
  'stratejik iş birliği': 3, 'yabancı ilgisi': 3, 'büyüme rekoru': 3,
  'yükseldi': 2, 'arttı': 2, 'rekor': 2, 'güçlü': 2, 'toparlandı': 2,
  'pozitif': 2, 'büyüdü': 2, 'kârlı': 2, 'başarı': 2, 'rally': 2,
  'aştı': 2, 'üzerinde': 2, 'tahmin üstü': 2, 'ivme': 2,
  'istikrar': 1, 'güven': 1, 'artış': 1, 'fırsat': 1, 'talep': 1,
  'yatırım': 1, 'ihracat': 1, 'büyüme': 1, 'kâr': 1, 'temettü': 1,
};
const negatifAgirlik = {
  'maliyet artışı': -3, 'arz daralması': -3, 'jeopolitik risk': -3,
  'enflasyon baskısı': -3, 'düşüş trendi': -3, 'iflas': -3, 'batık': -3,
  'düştü': -2, 'geriledi': -2, 'kayıp': -2, 'risk': -2, 'kriz': -2,
  'panik': -2, 'zayıf': -2, 'endişe': -2, 'baskı': -2, 'daraldı': -2,
  'zararda': -2, 'tahmin altı': -2, 'sert düşüş': -2,
  'belirsiz': -1, 'yavaşladı': -1, 'azaldı': -1, 'olumsuz': -1,
  'sorun': -1, 'güçlük': -1, 'faiz artışı': -1, 'enflasyon': -1,
};
const manipulatif = ['şok', 'bomba', 'inanılmaz', 'garantili', 'kesin kazan', 'milyoner', 'sır', 'gizli', 'acil', 'son fırsat', 'herkese', 'flaş'];
function haberSentimentSkoru(haber) {
  const metin = ((haber.title || '') + ' ' + (haber.description || '')).toLowerCase();
  for(const m of manipulatif) {
    if(metin.includes(m)) return { score: 50, label: 'Nötr', guvenilir: false };
  }
  let puan = 0, eslesme = 0;
  for(const [kelime, agirlik] of Object.entries(pozitifAgirlik)) {
    if(metin.includes(kelime)) { puan += agirlik; eslesme++; }
  }
  for(const [kelime, agirlik] of Object.entries(negatifAgirlik)) {
    if(metin.includes(kelime)) { puan += agirlik; eslesme++; }
  }
  let normalPuan = Math.max(5, Math.min(95, 50 + (puan * 6)));
  if(normalPuan > 50 && normalPuan < 60) normalPuan = Math.min(92, normalPuan + 8);
  else if(normalPuan < 50 && normalPuan > 40) normalPuan = Math.max(8, normalPuan - 8);
  else if(normalPuan === 50) normalPuan = puan >= 0 ? 55 : 45;
  normalPuan = Math.round(normalPuan);
  let label;
  if(normalPuan <= 20) label = 'Panik';
  else if(normalPuan <= 38) label = 'Negatif';
  else if(normalPuan <= 62) label = 'Nötr';
  else if(normalPuan <= 80) label = 'Pozitif';
  else label = 'Coşkulu';
  return { score: normalPuan, label, guvenilir: eslesme > 0, uyari: 'Bu skor istatistiksel dil analizidir. Yatırım tavsiyesi içermez.' };
}
function sentimentAnalizi() {
  const bugun = new Date();
  bugun.setHours(bugun.getHours() - 24);
  const sonHaberler = haberler.filter(h => new Date(h.tarih) > bugun);
  if (sonHaberler.length === 0) return;
  let pozitif = 0, negatif = 0, notr = 0, toplamSkor = 0;
  sonHaberler.forEach(h => {
    const s = h.sentiment || haberSentimentSkoru(h);
    toplamSkor += s.score;
    if (s.score > 60) pozitif++;
    else if (s.score < 40) negatif++;
    else notr++;
  });
  const toplam = sonHaberler.length;
  let normalSkor = Math.round(toplamSkor / toplam);
  if (normalSkor > 50) normalSkor = Math.min(85, Math.round(50 + (normalSkor - 50) * 1.6));
  else if (normalSkor < 50) normalSkor = Math.max(15, Math.round(50 - (50 - normalSkor) * 1.6));
  else normalSkor = pozitif >= negatif ? 54 : 46;
  let etiket;
  if (normalSkor <= 20) etiket = 'Aşırı Karamsar (Panik)';
  else if (normalSkor <= 40) etiket = 'Temkinli / Negatif';
  else if (normalSkor <= 60) etiket = 'Nötr / Belirsiz';
  else if (normalSkor <= 80) etiket = 'İyimser / Pozitif';
  else etiket = 'Aşırı Coşkulu (FOMO)';
  sentimentCache = { skor: normalSkor, etiket, pozitif, negatif, notr, toplamHaber: toplam, sonGuncelleme: new Date().toISOString(), uyari: 'Bu analiz yatırım tavsiyesi içermez.' };
  console.log('Sentiment güncellendi:', etiket, '(' + normalSkor + ')');
}
cron.schedule('0 * * * *', sentimentAnalizi);
// ============ API ENDPOINTS ============
app.get('/api/haberler', (req, res) => {
  const { cat, limit = 50 } = req.query;
  let data = cat && cat !== 'hepsi' ? haberler.filter(h => h.cat === cat) : haberler;
  res.json(data.slice(0, parseInt(limit)).map(h => ({ ...h, goruntulenmeSayisi: goruntulenmeSayaci[h.slug] || 0 })));
});
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
  res.json(haberler.filter(h => h.slug !== req.params.slug && h.cat === haber.cat).slice(0, 4));
});
app.get('/api/seffaflik', (req, res) => {
  const gunSayisi = Math.max(1, Math.floor((Date.now() - new Date(seffaflikStats.haftaBaslangic)) / 86400000));
  res.json({
    haftalikTaranan: seffaflikStats.haftalikTaranan,
    haftalikEklenen: seffaflikStats.haftalikEklenen,
    haftalikElenen: seffaflikStats.haftalikElenen,
    toplamTaranan: seffaflikStats.toplamTaranan,
    toplamElenen: seffaflikStats.toplamElenen,
    elenmeOrani: seffaflikStats.haftalikTaranan > 0 ? Math.round((seffaflikStats.haftalikElenen / seffaflikStats.haftalikTaranan) * 100) : 0,
    haftaBaslangic: seffaflikStats.haftaBaslangic,
    gunSayisi,
  });
});
app.get('/api/sentiment', (req, res) => res.json(sentimentCache));
app.get('/api/sentiment/:slug', (req, res) => {
  const haber = haberler.find(h => h.slug === req.params.slug);
  if(!haber) return res.status(404).json({ error: 'Bulunamadi' });
  res.json(haber.sentiment || haberSentimentSkoru(haber));
});
let piyasaCache = {};
let piyasaSonGuncelleme = 0;
async function piyasaGuncelle() {
  const result = {};

  // ── Kripto (Binance) ──────────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT"]');
    if (r.ok) {
      const data = await r.json();
      data.forEach(d => {
        const price = parseFloat(d.lastPrice);
        const chg   = parseFloat(d.priceChangePercent).toFixed(2);
        if (d.symbol === 'BTCUSDT') { result.btc = Math.round(price); result.btcChg = chg; }
        if (d.symbol === 'ETHUSDT') { result.eth = Math.round(price); result.ethChg = chg; }
      });
    }
  } catch(e) { console.log('[piyasa] Binance:', e.message); }

  // ── Döviz kurları ─────────────────────────────────────────────────────────
  const dovizKaynaklari = [
    'https://open.er-api.com/v6/latest/USD',
    'https://api.frankfurter.app/latest?from=USD&to=TRY,EUR,GBP',
  ];
  for (const url of dovizKaynaklari) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const d = await r.json();
      const rates = d.rates || {};
      const tryRate = rates.TRY;
      if (tryRate) {
        result.usdtry = tryRate.toFixed(2);
        result.eurtry = rates.EUR ? (tryRate / rates.EUR).toFixed(2) : null;
        result.gbptry = rates.GBP ? (tryRate / rates.GBP).toFixed(2) : null;
        result._tryRate = tryRate; // gram altın hesabı için iç kullanım
        break;
      }
    } catch(e) { /* sonraki kaynağa geç */ }
  }

  // ── Ons altın (USD) ───────────────────────────────────────────────────────
  const goldKaynaklari = [
    async () => {
      const r = await fetch('https://api.metals.live/v1/spot/gold');
      if (!r.ok) throw new Error('metals.live ' + r.status);
      const d = await r.json();
      return (d && d[0] && d[0].gold) ? Math.round(d[0].gold) : null;
    },
    async () => {
      // Frankfurter XAU/USD
      const r = await fetch('https://api.frankfurter.app/latest?from=XAU&to=USD');
      if (!r.ok) throw new Error('frankfurter XAU ' + r.status);
      const d = await r.json();
      return (d.rates && d.rates.USD) ? Math.round(1 / d.rates.USD) : null;
    },
  ];
  for (const fn of goldKaynaklari) {
    try {
      const gold = await fn();
      if (gold) { result.gold = gold; break; }
    } catch(e) { /* sonraki */ }
  }

  // ── Gram altın (TL) — hesaplama ───────────────────────────────────────────
  if (result.gold && result._tryRate) {
    result.gramAltin = Math.round((result.gold * result._tryRate) / 31.1035);
  }
  delete result._tryRate; // iç alan temizle

  // ── BIST100 (Yahoo Finance) ───────────────────────────────────────────────
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/XU100.IS?interval=1d&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (r.ok) {
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        result.bist100     = Math.round(meta.regularMarketPrice);
        result.bist100Chg  = meta.regularMarketPrice && meta.previousClose
          ? ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100).toFixed(2)
          : null;
      }
    }
  } catch(e) { console.log('[piyasa] BIST100:', e.message); }

  // ── S&P 500 + Nasdaq (Yahoo Finance) ──────────────────────────────────────
  try {
    const symbols = ['^GSPC', '^IXIC'];
    const r = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (r.ok) {
      const d = await r.json();
      (d?.quoteResponse?.result || []).forEach(q => {
        const chg = q.regularMarketChangePercent?.toFixed(2);
        if (q.symbol === '^GSPC')  { result.sp500   = Math.round(q.regularMarketPrice); result.sp500Chg  = chg; }
        if (q.symbol === '^IXIC')  { result.nasdaq  = Math.round(q.regularMarketPrice); result.nasdaqChg = chg; }
      });
    }
  } catch(e) { console.log('[piyasa] Yahoo endeksler:', e.message); }

  result.guncelleme = new Date().toISOString();
  piyasaCache       = result;
  piyasaSonGuncelleme = Date.now();
  console.log('[piyasa] Güncellendi — BTC:', result.btc, '| USDTRY:', result.usdtry, '| ONS:', result.gold, '| GRAM:', result.gramAltin, '| BIST:', result.bist100);
  return result;
}
cron.schedule('*/5 * * * *', piyasaGuncelle);
app.get('/api/piyasa', async (req, res) => {
  if(Date.now() - piyasaSonGuncelleme > 5 * 60 * 1000 || !piyasaCache.btc) await piyasaGuncelle();
  res.json(piyasaCache);
});
app.get('/api/stats', async (req, res) => {
  let abone = null;
  try {
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
    seffaflik: { taranan: seffaflikStats.haftalikTaranan, eklenen: seffaflikStats.haftalikEklenen, elenen: seffaflikStats.haftalikElenen }
  });
});
app.post('/api/abone', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Gecersiz email' });
  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({ email, listIds: [2], updateEnabled: true, attributes: { SOURCE: 'anlikhaber.com' } })
    });
    if (response.ok || response.status === 204) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
        body: JSON.stringify({
          sender: { name: 'AnlıkHaber', email: 'yonetim@anlikhaber.com' },
          to: [{ email }],
          subject: 'AnlıkHaber Bültenine Hoş Geldiniz! 📊',
          htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0f;color:#f0ede8;padding:32px;border-radius:12px"><h1 style="color:#e8c84a">AnlıkHaber</h1><h2>Bültenimize Hoş Geldiniz! 🎉</h2><p style="color:#b8b5b0;line-height:1.8">Her sabah 07:00'de en önemli finans haberlerini e-postanıza gönderiyoruz.</p><a href="https://anlikhaber.com" style="background:#e8c84a;color:#0a0a0f;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Siteyi Ziyaret Et →</a></div>`
        })
      });
      res.json({ success: true, message: 'Abone oldunuz!' });
    } else {
      const err = await response.json();
      if (err.code === 'duplicate_parameter') res.json({ success: true, message: 'Zaten abonesiniz!' });
      else res.status(400).json({ error: err.message });
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
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://anlikhaber.com</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>${urls}</urlset>`);
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
  res.set('Content-Type', 'application/rss+xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>AnlıkHaber - Son Dakika Finans Haberleri</title><link>https://anlikhaber.com</link><description>Türkiye ve dünyadan anlık finans haberleri</description><language>tr</language>${items}</channel></rss>`);
});
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
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', haberSayisi: haberler.length, ts: new Date().toISOString() });
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// ============ SABAH BÜLTENİ ============
async function gunlukBultenGonder() {
  if (!process.env.BREVO_API_KEY) return;
  try {
    const kategoriler = ['finans', 'borsa', 'kripto', 'ekonomi', 'doviz', 'emtia'];
    const secilen = new Set();
    const topHaberler = [];
    kategoriler.forEach(cat => {
      haberler.filter(h => h.cat === cat)
        .sort((a, b) => (goruntulenmeSayaci[b.slug] || 0) - (goruntulenmeSayaci[a.slug] || 0))
        .slice(0, 2)
        .forEach(h => { if(!secilen.has(h.slug)) { topHaberler.push(h); secilen.add(h.slug); } });
    });
    haberler.filter(h => !secilen.has(h.slug) && h.sentiment)
      .sort((a, b) => Math.abs(b.sentiment.score - 50) - Math.abs(a.sentiment.score - 50))
      .slice(0, 20 - topHaberler.length)
      .forEach(h => topHaberler.push(h));
    const finalHaberler = topHaberler.slice(0, 20);
    if(finalHaberler.length === 0) { console.log('Bulten: haber yok'); return; }
    const tarih = new Date().toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const saat = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const sentiment = sentimentCache;
    const sentimentEmoji = sentiment.skor <= 20 ? '😱' : sentiment.skor <= 40 ? '😟' : sentiment.skor <= 60 ? '😐' : sentiment.skor <= 80 ? '😊' : '🚀';
    const haberlerHTML = finalHaberler.map((h, i) => {
      const skor = h.sentiment ? h.sentiment.score : 50;
      const barRenk = skor >= 65 ? '#22c55e' : skor <= 35 ? '#ef4444' : '#e8c84a';
      const catEmoji = {finans:'📊',borsa:'📈',kripto:'₿',ekonomi:'🏛',doviz:'💱',emtia:'🥇'}[h.cat] || '📰';
      return `<tr><td style="padding:0 24px 16px"><table width="100%" cellpadding="0" cellspacing="0" style="background:${i%2===0?'#13131a':'#0f0f18'};border-radius:10px;border:1px solid #1e1e2a"><tr><td style="padding:14px 16px"><span style="background:#1e1e2a;color:#e8c84a;font-size:9px;font-weight:700;padding:3px 10px;border-radius:3px">${catEmoji} ${(h.cat||'haber').toUpperCase()}</span><br><a href="${h.bizimUrl||'https://anlikhaber.com'}" style="color:#f0ede8;font-size:15px;font-weight:600;text-decoration:none">${h.title||''}</a>${h.description?`<p style="color:#8a8a9a;font-size:12px;margin:6px 0">${h.description.substring(0,140)}...</p>`:''}<br><a href="${h.bizimUrl||'https://anlikhaber.com'}" style="color:#e8c84a;font-size:12px;text-decoration:none;font-weight:600">Devamını oku →</a></td></tr></table></td></tr>`;
    }).join('');
    const htmlContent = `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f0ede6;font-family:Georgia,serif"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 0"><table width="600" cellpadding="0" cellspacing="0"><tr><td style="background:#0a0a0f;padding:24px;border-radius:12px 12px 0 0"><div style="font-size:28px;font-weight:700;color:#f0ede8">Anlık<span style="color:#e8c84a">Haber</span></div><div style="color:#6b6b80;font-size:11px;letter-spacing:2px">SABAH BÜLTENİ · ${tarih.toUpperCase()}</div></td></tr><tr><td style="background:#1a2a20;padding:12px 24px;border-top:2px solid #e8c84a"><span style="color:#e8c84a;font-weight:700">🌅 Şeriflerinizin sabahı hayırlı olsun!</span><br><span style="color:#b0c8b8;font-size:12px">${sentimentEmoji} Piyasa Duygusu: <b>${sentiment.etiket||'Nötr'}</b> — Skor: ${sentiment.skor||50}/100</span></td></tr><tr><td style="background:#0a0a0f;padding:14px 24px 0"><div style="border-bottom:2px solid #e8c84a;padding-bottom:10px;margin-bottom:4px"><span style="font-size:20px;font-weight:700;color:#f0ede8">Bugünün Öne Çıkan Haberleri</span></div></td></tr>${haberlerHTML}<tr><td style="background:#13131a;padding:16px 24px;text-align:center"><a href="https://anlikhaber.com" style="background:#e8c84a;color:#0a0a0f;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:700">Tüm Haberleri Gör →</a></td></tr><tr><td style="background:#0a0a0f;padding:12px 24px;border-radius:0 0 12px 12px;text-align:center"><p style="color:#6b6b80;font-size:10px;margin:0">© 2026 AnlıkHaber · anlikhaber.com<br><a href="{{unsubscribe}}" style="color:#6b6b80">Abonelikten çık</a></p></td></tr></table></td></tr></table></body></html>`;
    const response = await fetch('https://api.brevo.com/v3/emailCampaigns', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        name: 'AnlıkHaber Sabah Bülteni - ' + tarih,
        subject: '🌅 ' + tarih + ' | AnlıkHaber Sabah Bülteni',
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
      if(TELEGRAM_KANAL) {
        const tgMesaj = ['🌅 <b>Şeriflerinizin sabahı hayırlı olsun!</b>', '', sentimentEmoji + ' Piyasa: <b>' + (sentiment.etiket||'Nötr') + '</b>', '', '📰 Bugünün haberleri:', ...finalHaberler.slice(0,5).map((h,i) => (i+1) + '. <a href="' + h.bizimUrl + '">' + h.title.substring(0,60) + '</a>'), '', '🔗 <a href="https://anlikhaber.com">Tüm haberler</a>'].join('\n');
        await telegramGonder(TELEGRAM_KANAL, tgMesaj);
        if(TELEGRAM_GRUP) await telegramGonder(TELEGRAM_GRUP, tgMesaj);
      }
    } else {
      console.log('Bülten hatası:', JSON.stringify(result));
    }
  } catch(e) {
    console.log('Bülten gönderme hatası:', e.message);
  }
}
// ============ CRON JOBS ============
cron.schedule('*/30 * * * *', fetchAndSaveNews);
cron.schedule('0 4 * * *', async () => {
  console.log('Sabah bülteni gönderiliyor...');
  await gunlukBultenGonder();
});
cron.schedule('0 17 * * 0', async () => {
  const s = seffaflikStats;
  const tweetText = [`📊 AnlıkHaber Haftalık AI Şeffaflık Raporu`, ``, `Bu hafta:`, `🔍 ${s.haftalikTaranan} haber tarandı`, `✅ ${s.haftalikEklenen} haber yayınlandı`, `🚫 ${s.haftalikElenen} haber elendi`, ``, `#anlikhaber #finans #yapayzekagazetecilik`].join('\n').substring(0, 280);
  try {
    await twitter.v2.tweet(tweetText);
    seffaflikStats.haftalikTaranan = 0; seffaflikStats.haftalikEklenen = 0; seffaflikStats.haftalikElenen = 0; seffaflikStats.haftaBaslangic = new Date();
  } catch(e) { console.log('Şeffaflık tweet hatası:', e.message); }
});
cron.schedule('0 6 * * 1', async () => {
  const s = sentimentCache;
  if(!s || !s.etiket) return;
  const emoji = s.skor <= 20 ? '😱' : s.skor <= 40 ? '😟' : s.skor <= 60 ? '😐' : s.skor <= 80 ? '😊' : '🚀';
  const tweetText = [`${emoji} AnlıkHaber AI Piyasa Duygu Raporu`, ``, `📊 Genel Duygu: ${s.etiket}`, `📈 Skor: ${s.skor}/100`, `🔍 ${s.toplamHaber} haber analiz edildi`, ``, `🔗 anlikhaber.com`, ``, `#piyasa #borsa #anlikhaber`].join('\n').substring(0, 280);
  try { await twitter.v2.tweet(tweetText); } catch(e) { console.log('Sentiment tweet hatası:', e.message); }
  if(TELEGRAM_KANAL) {
    const mesaj = ['📊 <b>AnlıkHaber Haftalık AI Piyasa Raporu</b>', '', emoji + ' Genel Duygu: <b>' + s.etiket + '</b>', '📈 Skor: <b>' + s.skor + '/100</b>', '🔍 ' + s.toplamHaber + ' haber analiz edildi', '', '🔗 <a href="https://anlikhaber.com">anlikhaber.com</a>', '', '<i>Bu analiz yatırım tavsiyesi içermez.</i>'].join('\n');
    await telegramGonder(TELEGRAM_KANAL, mesaj);
    if(TELEGRAM_GRUP) await telegramGonder(TELEGRAM_GRUP, mesaj);
  }
});
cron.schedule('0 */2 * * *', async () => {
  const bekleyenler = haberler.filter(h => !h.tweetAtildi && !postedUrls.has(h.orijinalUrl));
  if (bekleyenler.length === 0) return;
  await tweetHaber(bekleyenler[0]);
});
// ============ MERKEZI ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error('[Express]', req.method, req.path, '→', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Sunucu hatası' });
});

// Yakalanmamış hataları logla, process'i düşürme
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

// ============ BAŞLAT ============
app.listen(PORT, async () => {
  // v2 modülleri devre dışı — monolitle devam
  // anlikHaberModulleriniBaslat(app, twitter);
  console.log('AnlikHaber Backend - Port:', PORT);
  try {
    getDb();
    haberler = sonHaberler(500);
    console.log('[DB] Hidrasyon:', haberler.length, 'haber yüklendi (DB toplam:', haberSayisi() + ')');
  } catch(e) {
    console.log('[DB] Hidrasyon hata:', e.message);
  }
  await fetchAndSaveNews();
  setTimeout(sentimentAnalizi, 2000);
});
