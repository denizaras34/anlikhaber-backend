/**
 * db/init.js — AnlıkHaber SQLite Veritabanı
 * Kurulum: npm install better-sqlite3
 *
 * Tablolar:
 *   engagement_metrics  → X + Telegram etkileşim verileri
 *   rss_sources         → Kaynak sağlık durumu + fallback
 *   newsletter_log      → Brevo gönderim geçmişi
 *   publish_queue       → Akıllı zamanlayıcı kuyruğu
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'anlikhaber.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');  // Eşzamanlı okuma için
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    -- ─── Etkileşim Metrikleri ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS engagement_metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id         TEXT NOT NULL,          -- Tweet ID veya Telegram message_id
      platform        TEXT NOT NULL,          -- 'x' | 'telegram'
      haber_slug      TEXT NOT NULL,
      kategori        TEXT,                   -- 'kripto' | 'döviz' | 'bist' | 'genel'
      etiketler       TEXT,                   -- JSON array: ["BIST", "dolar"]
      impressions     INTEGER DEFAULT 0,
      likes           INTEGER DEFAULT 0,
      retweets        INTEGER DEFAULT 0,
      bookmarks       INTEGER DEFAULT 0,
      views           INTEGER DEFAULT 0,      -- Telegram için
      forwards        INTEGER DEFAULT 0,      -- Telegram için
      olcum_saati     INTEGER NOT NULL,       -- 1 | 6 (saat sonrası)
      olusturuldu_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(post_id, platform, olcum_saati)
    );

    -- ─── Yayın Kuyruğu ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS publish_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      haber_slug      TEXT NOT NULL,
      haber_baslik    TEXT NOT NULL,
      haber_json      TEXT NOT NULL,          -- Tam haber objesi (JSON)
      platform        TEXT NOT NULL,          -- 'x' | 'telegram' | 'both'
      oncelik         TEXT DEFAULT 'rutin',   -- 'breaking' | 'onemli' | 'rutin'
      oncelik_skoru   REAL DEFAULT 0,
      durum           TEXT DEFAULT 'bekliyor',-- 'bekliyor' | 'yayinlandi' | 'iptal'
      hedef_zaman     TEXT,                   -- ISO datetime, null = ilk uygun pencere
      yayinlandi_at   TEXT,
      olusturuldu_at  TEXT DEFAULT (datetime('now'))
    );

    -- ─── RSS Kaynakları ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rss_sources (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL UNIQUE,
      isim            TEXT NOT NULL,
      kategori        TEXT NOT NULL,
      oncelik         INTEGER DEFAULT 1,      -- 1=yüksek, 2=orta, 3=düşük
      fallback_url    TEXT,
      aktif           INTEGER DEFAULT 1,      -- 1=aktif, 0=devre dışı
      fail_sayisi     INTEGER DEFAULT 0,
      son_basari_at   TEXT,
      son_hata_at     TEXT,
      son_hata_mesaji TEXT,
      olusturuldu_at  TEXT DEFAULT (datetime('now')),
      guncellendi_at  TEXT DEFAULT (datetime('now'))
    );

    -- ─── Newsletter Geçmişi ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS newsletter_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      gonderim_tarihi TEXT NOT NULL,
      konu            TEXT NOT NULL,
      alici_sayisi    INTEGER DEFAULT 0,
      haber_sluglar   TEXT,                   -- JSON array
      brevo_message_id TEXT,
      durum           TEXT DEFAULT 'bekliyor',-- 'gonderildi' | 'hata' | 'bekliyor'
      hata_mesaji     TEXT,
      olusturuldu_at  TEXT DEFAULT (datetime('now'))
    );

    -- ─── İndeksler ──────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_engagement_platform   ON engagement_metrics(platform, olusturuldu_at);
    CREATE INDEX IF NOT EXISTS idx_engagement_kategori   ON engagement_metrics(kategori);
    CREATE INDEX IF NOT EXISTS idx_engagement_slug       ON engagement_metrics(haber_slug);
    CREATE INDEX IF NOT EXISTS idx_queue_durum           ON publish_queue(durum, hedef_zaman);
    CREATE INDEX IF NOT EXISTS idx_rss_aktif             ON rss_sources(aktif, oncelik);
    CREATE INDEX IF NOT EXISTS idx_newsletter_tarih      ON newsletter_log(gonderim_tarihi);
  `);

  // Varsayılan RSS kaynaklarını ekle (yoksa)
  seedRssSources(db);

  console.log('[DB] Şema hazır:', DB_PATH);
}

function seedRssSources(db) {
  const count = db.prepare('SELECT COUNT(*) as c FROM rss_sources').get().c;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO rss_sources (url, isim, kategori, oncelik, fallback_url)
    VALUES (?, ?, ?, ?, ?)
  `);

  const kaynaklar = [
    ['https://www.bloomberght.com/rss', 'Bloomberg HT', 'genel', 1, null],
    ['https://feeds.feedburner.com/hurriyet/BNmJ', 'Hürriyet Ekonomi', 'genel', 1, null],
    ['https://www.haberturk.com/rss/ekonomi.xml', 'Habertürk Ekonomi', 'genel', 2, null],
    ['https://www.sabah.com.tr/rss/ekonomi.xml', 'Sabah Ekonomi', 'genel', 2, null],
    ['https://tr.investing.com/rss/news_14.rss', 'Investing.com Kripto', 'kripto', 1, null],
    ['https://tr.investing.com/rss/news_25.rss', 'Investing.com Forex', 'döviz', 1, null],
    ['https://tr.investing.com/rss/news_285.rss', 'Investing.com BIST', 'bist', 1, null],
    ['https://coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk', 'kripto', 2, null],
  ];

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(...row);
  });
  insertMany(kaynaklar);

  console.log('[DB] Varsayılan RSS kaynakları eklendi.');
}

// ── Yardımcı fonksiyonlar ──────────────────────────────────────────────────

function kaydetEngagement(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO engagement_metrics
      (post_id, platform, haber_slug, kategori, etiketler, impressions, likes,
       retweets, bookmarks, views, forwards, olcum_saati)
    VALUES
      (@post_id, @platform, @haber_slug, @kategori, @etiketler, @impressions,
       @likes, @retweets, @bookmarks, @views, @forwards, @olcum_saati)
  `);
  return stmt.run(data);
}

function topHaberler(gun = 7, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT
      haber_slug,
      kategori,
      platform,
      MAX(impressions + views)                    AS toplam_gorunum,
      MAX(likes + retweets + bookmarks + forwards) AS toplam_etkilesim,
      AVG(impressions + views)                    AS ort_gorunum
    FROM engagement_metrics
    WHERE olusturuldu_at >= datetime('now', '-' || ? || ' days')
    GROUP BY haber_slug, platform
    ORDER BY toplam_gorunum DESC
    LIMIT ?
  `).all(gun, limit);
}

function kuyrugaEkle(haber) {
  const db = getDb();
  return db.prepare(`
    INSERT OR IGNORE INTO publish_queue
      (haber_slug, haber_baslik, haber_json, platform, oncelik, oncelik_skoru, hedef_zaman)
    VALUES
      (@slug, @baslik, @json, @platform, @oncelik, @skor, @hedef_zaman)
  `).run({
    slug: haber.slug,
    baslik: haber.baslik,
    json: JSON.stringify(haber),
    platform: haber.platform || 'both',
    oncelik: haber.oncelik || 'rutin',
    skor: haber.skor || 0,
    hedef_zaman: haber.hedef_zaman || null,
  });
}

function bekleyenKuyruk(platform = null) {
  const db = getDb();
  const where = platform
    ? `durum = 'bekliyor' AND (platform = ? OR platform = 'both')`
    : `durum = 'bekliyor'`;
  const params = platform ? [platform] : [];
  return db.prepare(`
    SELECT * FROM publish_queue WHERE ${where}
    ORDER BY oncelik_skoru DESC, olusturuldu_at ASC
  `).all(...params);
}

function kuyrukTamamlandi(id) {
  return getDb().prepare(`
    UPDATE publish_queue SET durum = 'yayinlandi', yayinlandi_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

module.exports = {
  getDb,
  kaydetEngagement,
  topHaberler,
  kuyrugaEkle,
  bekleyenKuyruk,
  kuyrukTamamlandi,
};
