# AnlıkHaber Backend

## Railway.app'e Kurulum

### 1. GitHub'a yükle
1. github.com'a git → ücretsiz hesap aç
2. "New repository" → adı: `anlikhaber-backend`
3. Bu klasördeki dosyaları yükle

### 2. Railway.app kurulum
1. railway.app → "Start a New Project"
2. "Deploy from GitHub repo" seç
3. anlikhaber-backend reposunu seç
4. Otomatik deploy başlar

### 3. Environment Variables ekle
Railway dashboard → Variables sekmesi → şunları ekle:
```
X_API_KEY = Consumer Key'in
X_API_SECRET = Secret Key'in
X_ACCESS_TOKEN = Access Token'ın
X_ACCESS_SECRET = Access Token Secret'ın
```

### 4. URL'ini al
Railway sana şöyle bir URL verir:
`https://anlikhaber-backend-production.up.railway.app`

Bu URL'i Netlify sitene ekle (index.html'de API_URL değişkeni)

## API Endpoints
- GET /api/haberler — tüm haberler
- GET /api/haberler?cat=kripto — kategori filtreli
- GET /api/haber/:slug — tek haber
- GET /api/stats — istatistikler
