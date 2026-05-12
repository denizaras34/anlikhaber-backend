/**
 * modules/multiformat.js — Görev 3: Tek-Haiku-Çok-Format Pipeline
 *
 * Tek bir Haiku çağrısında 4 platform formatını paralel üretir:
 *   - Web başlık + özet
 *   - X tweet veya thread
 *   - Telegram mesajı (Markdown)
 *   - Telegram anketi (kripto/döviz/bist için)
 *   - Brevo email snippet
 *
 * Kullanım:
 *   const { generateMultiFormat } = require('./modules/multiformat');
 *   const formats = await generateMultiFormat(article);
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const POLL_KATEGORILER = ['kripto', 'döviz', 'bist'];

/**
 * Ana fonksiyon — tek Haiku çağrısı, tüm formatlar
 * @param {Object} article - { baslik, icerik, link, slug, kategori, kaynak }
 * @returns {Object} MultiFormat çıktısı
 */
async function generateMultiFormat(article) {
  const { baslik, icerik, link, slug, kategori = 'genel', kaynak } = article;
  const pollAktif = POLL_KATEGORILER.includes(kategori?.toLowerCase());

  const prompt = `Sen AnlıkHaber adlı Türkçe finans haber sitesinin içerik asistanısın.
Aşağıdaki haberi farklı platformlar için formatla. Tüm çıktıları geçerli JSON olarak ver.

HABER:
Başlık: ${baslik}
Kaynak: ${kaynak || 'Bilinmiyor'}
İçerik: ${icerik?.substring(0, 1500) || baslik}
Link: ${link}
Kategori: ${kategori}

GÖREV: Aşağıdaki JSON şemasını doldur. Sadece JSON döndür, açıklama ekleme.

{
  "web_baslik": "SEO dostu başlık, 60 karakter altı",
  "web_ozet": "2-3 cümle özet, merak uyandırsın, Türkçe finans okuyucusuna hitap etsin",
  "oncelik": "breaking | onemli | rutin",
  "oncelik_skor": 0.0,
  "tek_tweet_mi": true,
  "x_tweet": "≤270 karakter, hook + 1 emoji + ilgili hashtag. tek_tweet_mi=true ise dolu, false ise boş string",
  "x_thread": [
    "1/ Dikkat çekici kanca tweet (≤260 karakter)",
    "2/ Temel veri veya argüman (≤260 karakter)",
    "3/ Bağlam veya analiz (≤260 karakter)",
    "4/ 🔗 Detaylı analiz: ${link} | @anlikhaber22 (≤260 karakter)"
  ],
  "telegram_md": "*Başlık*\\n\\nGövde 2-3 cümle...\\n\\n[📰 Devamını oku](${link})",
  "telegram_poll": ${pollAktif ? `{
    "soru": "Konuyla ilgili soru",
    "secenekler": ["Seçenek 1", "Seçenek 2", "Seçenek 3"],
    "sure_saat": 24
  }` : 'null'},
  "email_snippet": "Brevo bülteni için 1-2 cümle, okuyucuyu siteye çeksin",
  "etiketler": ["etiket1", "etiket2"]
}

KURALLAR:
- tek_tweet_mi: içerik 270 karaktere sığıyorsa true, sığmıyorsa false
- oncelik_skor: 0.0-1.0 arası. breaking=0.9-1.0, onemli=0.5-0.8, rutin=0.0-0.4
- telegram_md içinde \\n kullan (gerçek yeni satır değil)
- x_thread[3] her zaman linki içermeli
- Türkçe yazım kurallarına uyu`;

  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const latencyMs = Date.now() - startTime;
    const rawText = response.content[0].text.trim();

    // JSON bloğunu çıkar
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Geçerli JSON bulunamadı');

    const parsed = JSON.parse(jsonMatch[0]);

    // Maliyet tahmini (Haiku: $0.25/M input, $1.25/M output token)
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const maliyetUsd = (inputTokens * 0.00000025) + (outputTokens * 0.00000125);

    return {
      ...parsed,
      _meta: {
        model: 'claude-haiku-4-5-20251001',
        latency_ms: latencyMs,
        model_cost_usd: maliyetUsd,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        haber_slug: slug,
        kategori,
        poll_aktif: pollAktif,
      },
    };

  } catch (err) {
    console.error('[MultiFormat] Hata:', err.message);

    // Fallback: temel format
    return fallbackFormat(article, err.message);
  }
}

/**
 * API hatası durumunda basit fallback format
 */
function fallbackFormat(article, hataMesaji) {
  const { baslik, link, slug, kategori } = article;
  const kisaBaslik = baslik.length > 60 ? baslik.substring(0, 57) + '...' : baslik;

  return {
    web_baslik: kisaBaslik,
    web_ozet: baslik,
    oncelik: 'rutin',
    oncelik_skor: 0.3,
    tek_tweet_mi: true,
    x_tweet: `${baslik.substring(0, 220)} ${link} #AnlıkHaber`,
    x_thread: [],
    telegram_md: `*${baslik}*\n\n[📰 Devamını oku](${link})`,
    telegram_poll: null,
    email_snippet: baslik,
    etiketler: [kategori || 'genel'],
    _meta: {
      model: 'fallback',
      hata: hataMesaji,
      haber_slug: slug,
    },
  };
}

/**
 * Toplu işleme — birden fazla haberi sırayla işler (rate limit koruması)
 * @param {Array} articles
 * @param {number} aralikMs - İstekler arası bekleme
 */
async function generateMultiFormatBatch(articles, aralikMs = 200) {
  const sonuclar = [];
  for (const article of articles) {
    const sonuc = await generateMultiFormat(article);
    sonuclar.push(sonuc);
    if (aralikMs > 0) await new Promise(r => setTimeout(r, aralikMs));
  }
  return sonuclar;
}

/**
 * Maliyet & gecikme A/B karşılaştırma logu
 */
function logMetrik(meta) {
  const logSatiri = JSON.stringify({
    ts: new Date().toISOString(),
    model: meta.model,
    model_cost_usd: meta.model_cost_usd?.toFixed(6),
    total_latency_ms: meta.latency_ms,
    input_tokens: meta.input_tokens,
    output_tokens: meta.output_tokens,
    slug: meta.haber_slug,
    kategori: meta.kategori,
  });
  console.log('[MultiFormat:metrik]', logSatiri);
}

module.exports = {
  generateMultiFormat,
  generateMultiFormatBatch,
  logMetrik,
};
