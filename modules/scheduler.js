/**
 * modules/scheduler.js — Görev 1: Akıllı Yayın Zamanlayıcısı
 *
 * Haberleri "ilk gelene ilk yayınla" yerine:
 *   1. Breaking news → anında yayınla (kuyruğu atla)
 *   2. Önemli/rutin haberler → yayın pencerelerine göre kuyrukla
 *   3. Aynı 30 dakikada >4 haber → düşük önceliklileri birleştir/ertele
 *
 * Yayın pencereleri (BIST + Türkiye alışkanlıkları):
 *   X: 08:30–10:00, 12:30–14:00, 18:30–22:00
 *   Telegram: 09:00, 12:00, 15:00, 18:00, 21:00
 *
 * Kullanım:
 *   const scheduler = require('./modules/scheduler');
 *   scheduler.init(yayinFn); // yayınFn(haber, platform) fonksiyonunu al
 *   scheduler.kuyrugaEkle(haber, formatlar);
 */

const cron = require('node-cron');
const { kuyrugaEkle, bekleyenKuyruk, kuyrukTamamlandi } = require('../db/init');

// ── Yayın pencereleri ──────────────────────────────────────────────────────
// Her pencere: { baslangic: "HH:MM", bitis: "HH:MM" }

const X_PENCERELERI = [
  { baslangic: '08:30', bitis: '10:00' },
  { baslangic: '12:30', bitis: '14:00' },
  { baslangic: '18:30', bitis: '22:00' },
];

const TELEGRAM_SLOTLAR = ['09:00', '12:00', '15:00', '18:00', '21:00'];

// 30 dakika içi yoğunluk eşiği
const MAX_30DK_HABER = 4;

// Son 30 dakikada kuyruğa eklenen haberler (in-memory)
const sonYarımSaatSayaci = { count: 0, sifirAt: Date.now() };

// Yayın fonksiyonu referansı
let _yayinFn = null;

// ── Yardımcı: Saat karşılaştırma ──────────────────────────────────────────

function simdiTurkiyeSaati() {
  const now = new Date();
  const tr = new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return tr; // "HH:MM"
}

function dakikayaDonustur(saatStr) {
  const [h, m] = saatStr.split(':').map(Number);
  return h * 60 + m;
}

function xPenceresindeMi() {
  const simdi = dakikayaDonustur(simdiTurkiyeSaati());
  return X_PENCERELERI.some(p => {
    const bas = dakikayaDonustur(p.baslangic);
    const bit = dakikayaDonustur(p.bitis);
    return simdi >= bas && simdi <= bit;
  });
}

/**
 * X için bir sonraki yayın penceresinin başlangıç zamanını ver
 */
function sonrakiXPenceresi() {
  const simdi = dakikayaDonustur(simdiTurkiyeSaati());
  for (const p of X_PENCERELERI) {
    const bas = dakikayaDonustur(p.baslangic);
    if (bas > simdi) {
      const bugun = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
      return `${bugun} ${p.baslangic}`;
    }
  }
  // Yarın ilk pencere
  return `yarın ${X_PENCERELERI[0].baslangic}`;
}

/**
 * Telegram için bir sonraki slot
 */
function sonrakiTelegramSlot() {
  const simdi = dakikayaDonustur(simdiTurkiyeSaati());
  for (const slot of TELEGRAM_SLOTLAR) {
    if (dakikayaDonustur(slot) > simdi) return slot;
  }
  return TELEGRAM_SLOTLAR[0]; // Yarın ilk slot
}

// ── 30 dakika yoğunluk kontrolü ───────────────────────────────────────────

function yogunlukKontrol() {
  const simdi = Date.now();
  if (simdi - sonYarımSaatSayaci.sifirAt > 30 * 60 * 1000) {
    sonYarımSaatSayaci.count = 0;
    sonYarımSaatSayaci.sifirAt = simdi;
  }
  sonYarımSaatSayaci.count++;
  return sonYarımSaatSayaci.count;
}

// ── Ana fonksiyon: Kuyruğa ekle ───────────────────────────────────────────

async function kuyrugaEkleHaber(haber, formatlar) {
  const { oncelik = 'rutin', oncelik_skor = 0.3, slug, baslik } = formatlar || haber;

  // Breaking: anında yayınla
  if (oncelik === 'breaking') {
    console.log(`[Scheduler] 🚨 BREAKING — anında yayın: ${baslik}`);
    if (_yayinFn) {
      await _yayinFn({ ...haber, ...formatlar }, 'both');
    }
    return { tip: 'anlik', neden: 'breaking_news' };
  }

  // Yoğunluk kontrolü
  const saydim = yogunlukKontrol();
  if (saydim > MAX_30DK_HABER && oncelik === 'rutin') {
    console.log(`[Scheduler] ⏸ Yoğunluk eşiği: ${saydim} haber/30dk — düşük öncelikli ertele`);
    kuyrugaEkle({
      slug,
      baslik,
      platform: 'both',
      oncelik,
      skor: oncelik_skor - 0.2, // Ertelenenler sıranın arkasına düşer
      hedef_zaman: null,
      ...haber,
      ...formatlar,
    });
    return { tip: 'ertelendi', neden: 'yogunluk_esigi' };
  }

  // Normal kuyruk
  kuyrugaEkle({
    slug,
    baslik,
    platform: 'both',
    oncelik,
    skor: oncelik_skor,
    hedef_zaman: null,
    ...haber,
    ...formatlar,
  });

  console.log(`[Scheduler] 📋 Kuyruğa eklendi: "${baslik}" [${oncelik}] skor=${oncelik_skor}`);
  return { tip: 'kuyruk', neden: 'normal' };
}

// ── Kuyruk işleyici: X penceresi kontrolü ─────────────────────────────────

async function xKuyrugIsle() {
  if (!xPenceresindeMi()) return;
  if (!_yayinFn) return;

  const bekleyenler = bekleyenKuyruk('x');
  if (bekleyenler.length === 0) return;

  // En yüksek öncelikli haberi yayınla
  const haber = bekleyenler[0];
  const haberObj = JSON.parse(haber.haber_json);

  console.log(`[Scheduler] 📤 X yayını: "${haber.haber_baslik}"`);
  try {
    await _yayinFn(haberObj, 'x');
    kuyrukTamamlandi(haber.id);
  } catch (e) {
    console.error('[Scheduler] X yayın hatası:', e.message);
  }
}

// ── Kuyruk işleyici: Telegram slot kontrolü ───────────────────────────────

async function telegramKuyrugIsle() {
  if (!_yayinFn) return;

  const bekleyenler = bekleyenKuyruk('telegram');
  if (bekleyenler.length === 0) return;

  const haber = bekleyenler[0];
  const haberObj = JSON.parse(haber.haber_json);

  console.log(`[Scheduler] 📤 Telegram yayını: "${haber.haber_baslik}"`);
  try {
    await _yayinFn(haberObj, 'telegram');
    kuyrukTamamlandi(haber.id);
  } catch (e) {
    console.error('[Scheduler] Telegram yayın hatası:', e.message);
  }
}

// ── Başlatıcı ──────────────────────────────────────────────────────────────

function init(yayinFn) {
  _yayinFn = yayinFn;

  // X: Her 5 dakikada bir pencere kontrolü
  cron.schedule('*/5 * * * *', xKuyrugIsle, { timezone: 'Europe/Istanbul' });

  // Telegram: Belirlenen slotlarda çalış
  // 09:00, 12:00, 15:00, 18:00, 21:00
  cron.schedule('0 9,12,15,18,21 * * *', telegramKuyrugIsle, {
    timezone: 'Europe/Istanbul',
  });

  console.log('[Scheduler] Başlatıldı.');
  console.log(`  X pencereleri: ${X_PENCERELERI.map(p => `${p.baslangic}-${p.bitis}`).join(', ')}`);
  console.log(`  Telegram slotları: ${TELEGRAM_SLOTLAR.join(', ')}`);
}

function durum() {
  return {
    x_pencerede_mi: xPenceresindeMi(),
    sonraki_x: sonrakiXPenceresi(),
    sonraki_telegram: sonrakiTelegramSlot(),
    son_30dk_haber: sonYarımSaatSayaci.count,
    max_30dk_esik: MAX_30DK_HABER,
  };
}

module.exports = {
  init,
  kuyrugaEkleHaber,
  durum,
};
