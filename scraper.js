const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Stealth eklentisini aktif et (Google bot tespitini engeller)
puppeteer.use(StealthPlugin());

const LSA_URL = 'https://ads.google.com/local-services-ads/inbox/';

// Ham panel metninden MÜŞTERİ BİLGİSİ ve SADECE GERÇEK MESAJI süzen fonksiyon
function parseCleanMessage(rawText) {
  if (!rawText || rawText === '-' || !rawText.includes('Unterhaltung')) {
    return rawText;
  }

  // 1. En üstteki müşteri ismi ve numarasını yakala
  let customerHeader = "";
  const headerMatch = rawText.match(/(?:Potenzieller Kunde|[A-Z][a-z]+\s+[A-Z][a-z]+)\s+[\d\s]+/i);
  if (headerMatch) {
    customerHeader = headerMatch[0].trim();
  }

  // 2. "Unterhaltung" kelimesinden sonrasını kesip al
  let parts = rawText.split('Unterhaltung');
  let chatContent = parts[parts.length - 1];

  // 3. Alt sistem yazılarını ve butonları temizle
  chatContent = chatContent
    .split('Wird geladen')[0]
    .split('Audioinhalte')[0]
    .split('Hier dem Kunden')[0]
    .trim();

  // 4. Mesajın başındaki profil harfini (P), Potenzieller Kunde yazısını ve tarihi temizle
  chatContent = chatContent
    .replace(/^P\s+/gi, '')
    .replace(/^Potenzieller Kunde\s+/gi, '')
    .replace(/^\d{2}\.\d{2}\.\d{2}\s+/gi, '')
    .trim();

  if (customerHeader && chatContent) {
    return `[${customerHeader}]\n${chatContent}`;
  }

  return chatContent.length > 0 ? chatContent : rawText;
}

// Sadece GitHub Secrets üzerindeki GOOGLE_COOKIES değerini yükleyen fonksiyon
async function loadCookies(page) {
  if (!process.env.GOOGLE_COOKIES || process.env.GOOGLE_COOKIES.trim() === '') {
    throw new Error("❌ GOOGLE_COOKIES secret değişkeni GitHub depoda bulunamadı!");
  }

  console.log("📌 GitHub Secrets üzerindeki GOOGLE_COOKIES okunuyor...");
  
  try {
    const rawCookies = JSON.parse(process.env.GOOGLE_COOKIES);
    
    // Puppeteer'ın hata vermesini önlemek için SameSite alanlarını temizle
    const cookies = rawCookies.map(cookie => {
      const cleaned = { ...cookie };
      if (cleaned.sameSite === 'no_restriction' || cleaned.sameSite === 'unspecified' || !cleaned.sameSite) {
        delete cleaned.sameSite;
      }
      return cleaned;
    });

    await page.setCookie(...cookies);
    console.log(`✅ ${cookies.length} adet çerez tarayıcıya yüklendi.`);
  } catch (err) {
    throw new Error(`❌ GOOGLE_COOKIES parse edilemedi: ${err.message}`);
  }
}

(async () => {
  let browser;
  try {
    console.log("🚀 GitHub Actions Runner üzerinde Scraper başlatılıyor...");

    // GitHub Actions ortamına özel Puppeteer parametreleri
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/google-chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
        '--lang=de-AT,de'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'de-AT,de;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Çerezleri yükle
    await loadCookies(page);

    console.log("🌐 LSA Inbox sayfasına gidiliyor...");
    await page.goto(LSA_URL, { waitUntil: 'networkidle2' });

    const pageTitle = await page.title();
    console.log(`📄 Sayfa Başlığı: ${pageTitle}`);

    if (pageTitle.includes('Anmelden') || pageTitle.includes('Sign in') || page.url().includes('accounts.google.com')) {
      throw new Error("❌ Oturum açılamadı! GOOGLE_COOKIES süresi dolmuş veya geçersiz.");
    }

    console.log("✅ LSA Paneline başarıyla giriş yapıldı. Veriler taranıyor...");

    await page.waitForSelector('amp-lead-inbox-item, .lead-item, table tbody tr', { timeout: 30000 }).catch(() => {
      console.log("⚠️ Veri elemanları beklenirken zaman aşımı yaşandı, mevcut sayfa taranıyor...");
    });

    // Panel verilerini topla
    const leads = await page.evaluate(() => {
      const extractedLeads = [];
      const items = document.querySelectorAll('amp-lead-inbox-item, .lead-item');

      items.forEach(item => {
        const phoneEl = item.querySelector('.phone-number, [data-phone]');
        const jobEl = item.querySelector('.job-type, .service-name');
        const locEl = item.querySelector('.location-name, .address');
        const statusEl = item.querySelector('.status-badge, .lead-status');
        const dateEl = item.querySelector('.date-text, .lead-date');
        const rawMsgEl = item.innerText || "";

        if (phoneEl) {
          extractedLeads.push({
            phone: phoneEl.innerText.trim(),
            jobType: jobEl ? jobEl.innerText.trim() : '-',
            location: locEl ? locEl.innerText.trim() : '-',
            status: statusEl ? statusEl.innerText.trim() : '-',
            date: dateEl ? dateEl.innerText.trim() : '-',
            rawMessage: rawMsgEl
          });
        }
      });

      return extractedLeads;
    });

    // Mesaj içeriklerini temizle
    const cleanedLeads = leads.map(lead => ({
      ...lead,
      messageText: parseCleanMessage(lead.rawMessage)
    }));

    cleanedLeads.forEach(l => delete l.rawMessage);

    console.log(`📊 Toplam ${cleanedLeads.length} adet lead başarıyla işlendi.`);

    // data.json çıktısını yaz
    const outputData = {
      updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
      leads: cleanedLeads
    };

    fs.writeFileSync('./data.json', JSON.stringify(outputData, null, 2), 'utf8');
    console.log("💾 Veriler data.json dosyasına yazıldı.");

    // Oturum tazelemek için çerezleri kaydet
    const currentCookies = await page.cookies();
    fs.writeFileSync('./updated_cookies.json', JSON.stringify(currentCookies, null, 2), 'utf8');
    console.log("🔄 Güncel çerezler updated_cookies.json dosyasına kaydedildi.");

  } catch (error) {
    console.error(`💥 Scraper hatası: ${error.message}`);
    if (browser) await browser.close();
    process.exit(1);
  }

  if (browser) await browser.close();
  console.log("🎉 İşlem başarıyla tamamlandı.");
})();
