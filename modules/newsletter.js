/**
 * modules/newsletter.js — Görev 4: Otomatik Brevo Haber Bülteni
 *
 * Her sabah 08:00'de:
 *   1. Son 24 saatin top 5 haberini seç
 *   2. Tek Haiku çağrısıyla özetleri üret
 *   3. HTML e-posta oluştur
 *   4. Brevo API ile Liste ID=2'ye gönder
 *   5. Hata → Telegram grubuna uyarı
 *
 * Kurulum: npm install @getbrevo/brevo
 *
 * Kullanım:
 *   const newsletter = require('./modules/newsletter');
 *   newsletter.init(haberlerFn); // haberlerFn() → son 24 saatin haberleri
 *   await newsletter.gonder(); // Manuel tetikleme
 */

const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/init');

const claudeClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const TELEGRAM_GRUP = process.env.TELEGRAM_GRUP;

let _haberlerFn = null;

// ── Top 5 haber seçimi ─────────────────────────────────────────────────────

function top5HaberSec(haberler) {
  // Etkileşim skoru + kategori çeşitliliği ağırlıklı seçim
  const kategoriler = new Set();
  const secilen = [];

  // Önce engagement skoru en yüksek haberler (DB'den)
  const db = getDb();
  const engagementData = db.prepare(`
    SELECT haber_slug, MAX(impressions + views) as skor
    FROM engagement_metrics
    WHERE olusturuldu_at >= datetime('now', '-24 hours')
    GROUP BY haber_slug ORDER BY skor DESC LIMIT 20
  `).all();

  const skorMap = Object.fromEntries(engagementData.map(e => [e.haber_slug, e.skor]));

  // Haberleri sırala
  const sirali = [...haberler].sort((a, b) => {
    const skorA = skorMap[a.slug] || 0;
    const skorB = skorMap[b.slug] || 0;
    return skorB - skorA;
  });

  for (const haber of sirali) {
    if (secilen.length >= 5) break;
    // Kategori çeşitliliği: aynı kategoriden max 2
    const katSayisi = [...kategoriler].filter(k => k === haber.kategori).length;
    if (katSayisi < 2) {
      secilen.push(haber);
      kategoriler.add(haber.kategori);
    }
  }

  // Yeterlice çeşit yoksa kalan haberlerden tamamla
  if (secilen.length < 5) {
    for (const haber of sirali) {
      if (secilen.length >= 5) break;
      if (!secilen.find(s => s.slug === haber.slug)) secilen.push(haber);
    }
  }

  return secilen.slice(0, 5);
}

// ── Haiku ile özetleme ─────────────────────────────────────────────────────

async function haberOzetleriUret(haberler) {
  const haberMetni = haberler.map((h, i) =>
    `${i + 1}. Başlık: ${h.baslik}\n   İçerik: ${(h.icerik || h.baslik).substring(0, 300)}\n   Link: ${h.link}\n   Kategori: ${h.kategori || 'genel'}`
  ).join('\n\n');

  const prompt = `AnlıkHaber için günlük e-posta bülteni haberleri:

${haberMetni}

Her haber için aşağıdaki JSON formatını doldur. Sadece JSON array döndür:

[
  {
    "baslik": "Dikkat çekici başlık (max 60 karakter)",
    "ozet": "Okuyucuyu siteye çeken 1-2 cümle özet",
    "link": "haberden gelen link",
    "emoji": "kategoriyle uyumlu tek emoji",
    "kategori_etiketi": "BIST / KRİPTO / DÖVİZ / EKONOMİ"
  }
]

Özet Türkçe olsun, merak uyandırsın, "tıkla ve öğren" hissi versin.`;

  const response = await claudeClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Özet JSON parse hatası');
  return JSON.parse(jsonMatch[0]);
}

// ── HTML e-posta şablonu ───────────────────────────────────────────────────

function htmlSablonOlustur(ozetler, tarih) {
  const haberKartlari = ozetler.map(h => `
    <tr>
      <td style="padding:16px 0; border-bottom:1px solid #f0f0f0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:12px; vertical-align:top; font-size:24px; width:36px;">${h.emoji}</td>
            <td>
              <span style="display:inline-block; background:#fff3e0; color:#e65100; font-size:11px;
                font-weight:600; padding:2px 8px; border-radius:4px; margin-bottom:6px;">
                ${h.kategori_etiketi}
              </span>
              <h3 style="margin:4px 0 8px; font-size:17px; color:#1a1a1a; line-height:1.3;">
                ${h.baslik}
              </h3>
              <p style="margin:0 0 10px; font-size:14px; color:#555; line-height:1.6;">
                ${h.ozet}
              </p>
              <a href="${h.link}?utm_source=newsletter&utm_medium=email&utm_campaign=daily"
                style="display:inline-block; background:#1a73e8; color:#fff; text-decoration:none;
                padding:8px 18px; border-radius:6px; font-size:13px; font-weight:600;">
                Devamını Oku →
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AnlıkHaber Günlük Özet</title>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
  <tr><td align="center" style="padding:24px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff; border-radius:12px;
      box-shadow:0 2px 8px rgba(0,0,0,0.08); max-width:600px; width:100%;">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,#1a73e8,#0d47a1); border-radius:12px 12px 0 0; padding:28px 32px;">
          <h1 style="margin:0; color:#fff; font-size:22px; font-weight:700;">📰 AnlıkHaber</h1>
          <p style="margin:4px 0 0; color:rgba(255,255,255,0.8); font-size:13px;">
            Günlük Finans Özeti · ${tarih}
          </p>
        </td>
      </tr>

      <!-- İçerik -->
      <tr>
        <td style="padding:24px 32px;">
          <p style="margin:0 0 20px; color:#333; font-size:15px;">Merhaba,</p>
          <p style="margin:0 0 24px; color:#555; font-size:14px; line-height:1.6;">
            Bugünün en önemli 5 finans haberi aşağıda. Tüm detaylar için başlığa tıkla.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${haberKartlari}
          </table>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f8f9fa; border-radius:0 0 12px 12px; padding:20px 32px; text-align:center;">
          <p style="margin:0 0 8px; font-size:12px; color:#888;">
            Bu e-postayı almak istemiyorsanız
            <a href="{unsubscribe_url}" style="color:#1a73e8;">abonelikten çıkın</a>.
          </p>
          <p style="margin:0; font-size:12px; color:#aaa;">
            © ${new Date().getFullYear()} AnlıkHaber · yonetim@anlikhaber.com
          </p>
          <div style="margin-top:12px;">
            <a href="https://anlikhaber.com" style="color:#1a73e8; text-decoration:none; font-size:12px; margin:0 8px;">Site</a>
            <a href="https://t.me/anlikhaberkanal" style="color:#1a73e8; text-decoration:none; font-size:12px; margin:0 8px;">Telegram</a>
            <a href="https://x.com/anlikhaber22" style="color:#1a73e8; text-decoration:none; font-size:12px; margin:0 8px;">X</a>
          </div>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Brevo gönderimi ────────────────────────────────────────────────────────

async function brevoGonder(htmlIcerik, konu, tarih) {
  const payload = {
    sender: { name: 'AnlıkHaber', email: 'yonetim@anlikhaber.com' },
    to: [{ email: 'yonetim@anlikhaber.com' }], // Liste için aşağıyı kullan
    listIds: [2],  // Brevo Liste ID
    subject: konu,
    htmlContent: htmlIcerik,
    params: { tarih },
    tags: ['gunluk-bulten'],
  };

  const res = await fetch('https://api.brevo.com/v3/emailCampaigns', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo API hatası ${res.status}: ${err}`);
  }

  const data = await res.json();

  // Kampanyayı hemen gönder
  if (data.id) {
    await fetch(`https://api.brevo.com/v3/emailCampaigns/${data.id}/sendNow`, {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY },
    });
  }

  return data;
}

// ── Ana gönderim fonksiyonu ────────────────────────────────────────────────

async function gonder() {
  console.log('[Newsletter] Günlük bülten hazırlanıyor...');
  const tarih = new Date().toLocaleDateString('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const db = getDb();

  try {
    // Son 24 saatin haberlerini al
    let haberler = [];
    if (_haberlerFn) {
      haberler = await _haberlerFn();
    } else {
      // DB'den slug listesi + temel bilgi
      haberler = db.prepare(`
        SELECT DISTINCT haber_slug as slug, haber_baslik as baslik,
          haber_json, olusturuldu_at
        FROM publish_queue
        WHERE olusturuldu_at >= datetime('now', '-24 hours')
          AND durum = 'yayinlandi'
        ORDER BY oncelik_skoru DESC LIMIT 20
      `).all().map(r => {
        const obj = JSON.parse(r.haber_json || '{}');
        return { ...obj, slug: r.slug, baslik: r.baslik || obj.baslik };
      });
    }

    if (haberler.length === 0) {
      console.log('[Newsletter] Haber bulunamadı, bülten atlandı.');
      return;
    }

    const top5 = top5HaberSec(haberler);
    const ozetler = await haberOzetleriUret(top5);
    const konu = `📰 AnlıkHaber Günlük Özet — ${tarih}`;
    const html = htmlSablonOlustur(ozetler, tarih);
    const brevoYanit = await brevoGonder(html, konu, tarih);

    // Log
    db.prepare(`
      INSERT INTO newsletter_log (gonderim_tarihi, konu, haber_sluglar, brevo_message_id, durum)
      VALUES (?, ?, ?, ?, 'gonderildi')
    `).run(
      new Date().toISOString(),
      konu,
      JSON.stringify(top5.map(h => h.slug)),
      brevoYanit.id?.toString()
    );

    console.log(`[Newsletter] ✅ Bülten gönderildi: ${konu} | Brevo ID: ${brevoYanit.id}`);

  } catch (err) {
    console.error('[Newsletter] ❌ Hata:', err.message);

    // Telegram uyarısı
    if (TELEGRAM_GRUP && process.env.TELEGRAM_TOKEN) {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_GRUP,
          text: `⚠️ *Günlük bülten gönderilemedi*\n\n❗ ${err.message}`,
          parse_mode: 'Markdown',
        }),
      });
    }

    // Hata logu
    const db2 = getDb();
    db2.prepare(`
      INSERT INTO newsletter_log (gonderim_tarihi, konu, durum, hata_mesaji)
      VALUES (?, 'Günlük bülten', 'hata', ?)
    `).run(new Date().toISOString(), err.message);
  }
}

// ── Başlatıcı ──────────────────────────────────────────────────────────────

function init(haberlerFn = null) {
  _haberlerFn = haberlerFn;

  // Her sabah 08:00'de gönder
  cron.schedule('0 8 * * *', gonder, { timezone: 'Europe/Istanbul' });

  console.log('[Newsletter] Başlatıldı. Her sabah 08:00 TR saatiyle gönderim aktif.');
}

module.exports = { init, gonder };
