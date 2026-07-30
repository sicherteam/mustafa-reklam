const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// --- CONFIGURATION ---
const INBOX_URL = 'https://ads.google.com/aw/servicemads/inbox';
const USER_DATA_DIR = '/home/yasin2celik/mustafa-reklam/user_data';
const CHROME_BINARY = '/usr/bin/google-chrome';
const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');

// Telegram Bilgileri (Gerekliyse doldur)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('❌ Telegram mesajı gönderilemedi:', err.message);
  }
}

(async () => {
  // 1. İndirme Klasörü Hazırlığı
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  console.log(`[${new Date().toLocaleString()}] ℹ️ INFO: LSA Paneline bağlanılıyor...`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_BINARY,
    userDataDir: USER_DATA_DIR,
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-first-run',
      '--no-service-autorun',
      '--password-store=basic'
    ]
  });

  const page = await browser.newPage();

  try {
    // CDP İndirme İznini Aktif Et
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });

    // Sayfaya Yönlendirme (networkidle0 ile arka plan yönlendirmelerinin oturmasını bekle)
    console.log("ℹ️ Sayfaya gidiliyor ve tam yüklenme bekleniyor...");
    await page.goto(INBOX_URL, { waitUntil: 'networkidle0', timeout: 90000 });
    
    // SPA / iFrame tam oturması için stabilizasyon beklemesi
    await new Promise(r => setTimeout(r, 10000));

    console.log("ℹ️ 'Herunterladen' butonu taranıyor...");

    // Detached frame hatasını önlemek için mainFrame() üzerinden doğrudan DOM tetikleme
    const downloadSuccess = await page.mainFrame().evaluate(() => {
      // 1. Öncelik: F12'de gördüğümüz nokta atışı jsname ve role eşleşmesi
      let btn = document.querySelector('div[role="button"][jsname="I5dMCd"]');
      
      // 2. Öncelik: İçinde 'Herunterladen' geçen role="button" veya button etiketleri
      if (!btn) {
        const allElements = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"]'));
        btn = allElements.find(el => {
          const txt = (el.textContent || el.innerText || '').trim();
          return txt.includes('Herunterladen') || txt.includes('HERUNTERLADEN') || txt.includes('Download');
        });
      }

      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (downloadSuccess) {
      console.log("✅ 'Herunterladen' butonuna başarıyla tıklandı. Dosya indiriliyor...");
      await new Promise(r => setTimeout(r, 6000)); // Dosyanın diske yazılması için bekle
    } else {
      console.warn("⚠️ 'Herunterladen' butonu bulunamadı! Ekran görüntüsü alınıyor (debug_page.png)...");
      await page.screenshot({ path: 'debug_page.png', fullPage: true });
      throw new Error("Download button not found in DOM");
    }

    // 3. İndirilen CSV Dosyasını Bulma
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error("Klasörde işlenecek CSV dosyası bulunamadı!");
    }

    // En güncel CSV dosyasını seç
    const latestFile = files.map(f => ({
      name: f,
      time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime.getTime()
    })).sort((a, b) => b.time - a.time)[0].name;

    const csvFilePath = path.join(DOWNLOAD_DIR, latestFile);
    console.log(`📄 İşlenen Dosya: ${csvFilePath}`);

    // 4. CSV Okuma ve İşleme
    const results = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        console.log(`✅ CSV başarıyla okundu. Toplam Kayıt: ${results.length}`);
        
        // Verileri data.json dosyasına yaz
        const dataJsonPath = path.resolve(__dirname, 'data.json');
        fs.writeFileSync(dataJsonPath, JSON.stringify(results, null, 2));
        console.log("💾 Veriler data.json dosyasına kaydedildi.");

        await browser.close();
        process.exit(0);
      });

  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] ❌ ERROR: Hata: ${error.message}`);
    await page.screenshot({ path: 'error_state.png', fullPage: true }).catch(() => {});
    await browser.close();
    process.exit(1);
  }
})();
