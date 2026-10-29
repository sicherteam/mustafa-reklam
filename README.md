# Mustafa Reklam: Google Ads LSA Lead Sync & Dashboard

Bu repo, Mustafa Reklam (Wiener-RaeumungsprofiS / Schnellpack) için Google Ads Local Services Ads (LSA) müşteri taleplerini ve mesajlarını otomatik olarak senkronize eder ve web paneli üzerinden sunar.

---

## 🚀 Özellikler

- **Google Ads API v26 Entegrasyonu:** Puppeteer, Chrome veya kırılgan çerezler (cookies) olmadan doğrudan resmi API üzerinden 2 saniyede çalışır.
- **Otomatik GitHub Actions:** Her 10 dakikada bir arka planda otomatik çalışır, yeni lead'leri çeker ve `data.json` dosyasını günceller.
- **Telegram Bildirimleri:** Yeni müşteri talepleri ve mesajlar geldiğinde Telegram botu üzerinden anında bildirim gönderir.
- **PWA Web Paneli (`index.html`):** GitHub Pages üzerinden mobil uyumlu arayüz sunar.

---

## 🔐 GitHub Actions Secrets (Gereksinimler)

GitHub Actions'ın arka planda çalışabilmesi için deponuzun **Settings > Secrets and variables > Actions** sayfasına şu Repository Secret'ları eklenmelidir:

| Secret Adı | Açıklama |
| :--- | :--- |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth Client Secret |
| `GOOGLE_REFRESH_TOKEN` | OAuth ile alınan Refresh Token |
| `GOOGLE_ADS_CUSTOMER_ID` | Google Ads Müşteri ID (örn: `4889362380`) |
| `TELEGRAM_BOT_TOKEN` | (İsteğe bağlı) Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | (İsteğe bağlı) Telegram Chat ID |
| `SKIP_TELEGRAM` | `false` (Bildirimleri açmak için) veya `true` |

---

## 🛠️ Yerel Çalıştırma

```bash
# Senkronizasyonu doğrudan çalıştırın
node scraper-api.js

# Bağlantı testi
npm run check

# Yeni token almak için OAuth sihirbazı
npm run auth
```
