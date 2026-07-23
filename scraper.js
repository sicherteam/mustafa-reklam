const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

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

  // Müşteri bilgisi bulunduysa mesajın başına ekle
  if (customerHeader && chatContent) {
    return `[${customerHeader}]\n${chatContent}`;
  }

  return chatContent.length > 0 ? chatContent : rawText;
}

(async () => {
  try {
    const userDataPath = path.join(__dirname, 'user_data');

    const browser = await puppeteer.launch({
      headless: false, // 👈 Xvfb ile çalıştıracağımız için false yapıyoruz
      executablePath: '/usr/bin/google-chrome',
      userDataDir: userDataPath, // /home/ubuntu/mustafa-reklam/user_data
      args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--profile-directory=Default', // 👈 Artık Default klasörünü okuyacak
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

    // ❌ loadCookies(page) ÇAĞRISI KALDIRILDI (Artık oturum doğrudan user_data/Profile 8 dizininden okunuyor)

    const targetUrl = 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT';
    console.log("LSA Inbox sayfasına gidiliyor...");
    
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    const pageTitle = await page.title();
    console.log("Sayfa Başlığı:", pageTitle);

    // Genişletilmiş hata başlığı kontrolü
    if (
      pageTitle.includes("Anmelden") || 
      pageTitle.includes("Sign in") || 
      pageTitle.includes("YouTube") || 
      pageTitle.includes("Error") || 
      pageTitle.includes("504") || 
      pageTitle.includes("Serverfehler")
    ) {
      throw new Error(`❌ Oturum açılamadı veya Google engelledi! Başlık: ${pageTitle}`);
    }

    console.log("Sayfa içeriğinin yüklenmesi ve yumuşak scroll bekleniyor...");
    await new Promise(resolve => setTimeout(resolve, 6000));

    // Alt satırların tam yüklenmesi için yumuşak scroll
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        let distance = 300;
        let timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= 1200) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
    });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 1. AŞAMA: GERÇEK SATIRLARI VE İNDEKSLLERİNİ TESPİT ET
    const validRowsIndices = await page.evaluate(() => {
      const allRows = Array.from(document.querySelectorAll('[role="row"], tr'));
      const valid = [];

      allRows.forEach((row, idx) => {
        const text = row.innerText || '';
        const cells = Array.from(row.querySelectorAll('td, div[role="gridcell"]'));
        
        if (cells.length >= 4) {
          const firstCol = cells[0]?.innerText?.trim() || '';
          
          if (firstCol && 
              firstCol !== 'Kunde' && 
              !firstCol.includes('Telefon') && 
              firstCol.length > 2) {
            
            const isMessage = /nachricht|message/i.test(text);
            const jobType = cells[1]?.innerText?.trim() || '-';
            const location = cells[3]?.innerText?.trim() || '-';
            
            let rawStatus = cells[5]?.innerText?.trim() || cells[4]?.innerText?.trim() || '-';
            const status = rawStatus.split('\n')[0].trim();
            const date = cells[6]?.innerText?.trim() || cells[5]?.innerText?.trim() || '-';

            valid.push({
              domIndex: idx,
              phone: firstCol,
              jobType,
              location,
              status,
              date,
              isMessage
            });
          }
        }
      });

      return valid;
    });

    console.log(`📊 Gerçek Lead Sayısı: ${validRowsIndices.length}`);

    // 0 Veri Kontrolü (Koruma Kalkanı)
    if (validRowsIndices.length === 0) {
      throw new Error("❌ Sayfada hiçbir mesaj bulunamadı! Sayfa tam yüklenmemiş veya Google engellemiş olabilir. Eski verileri korumak için işlem iptal ediliyor.");
    }

    let leads = [];

    // 2. AŞAMA: SATIRLARA TIKLA VE TEMİZ MESAJLARI AL
    for (const item of validRowsIndices) {
      let messageText = "-";

      if (item.isMessage) {
        try {
          console.log(`[${item.phone}] Mesaj paneli açılıyor...`);

          const clickSuccess = await page.evaluate((index) => {
            const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
            const targetRow = rows[index];
            if (!targetRow) return false;

            const clickTarget = targetRow.querySelector('td, div[role="gridcell"]') || targetRow;
            
            ['mousedown', 'mouseup', 'click'].forEach(eventType => {
              const evt = new MouseEvent(eventType, {
                bubbles: true,
                cancelable: true,
                view: window
              });
              clickTarget.dispatchEvent(evt);
            });
            return true;
          }, item.domIndex);

          if (clickSuccess) {
            await new Promise(resolve => setTimeout(resolve, 4500));

            let rawMessageText = await page.evaluate(() => {
              const conversationElements = Array.from(document.querySelectorAll('div, section, article'));
              const chatBlock = conversationElements.find(el => {
                const txt = el.innerText || '';
                return txt.includes('Unterhaltung') && txt.length > 20;
              });

              if (chatBlock) return chatBlock.innerText.trim();

              const sideDrawer = document.querySelector('[role="region"], .conversation-view, .detail-view, drawer-content');
              if (sideDrawer && sideDrawer.innerText.length > 10) {
                return sideDrawer.innerText.trim();
              }

              return "-";
            });

            messageText = parseCleanMessage(rawMessageText);
            console.log(` -> [${item.phone}] ÇEKİLEN MESAJ:`, messageText.replace(/\n/g, ' ').substring(0, 60) + "...");
          }

        } catch (err) {
          console.warn(` -> [${item.phone}] Hata:`, err.message);
        }
      }

      leads.push({
        phone: item.phone,
        jobType: item.jobType,
        location: item.location,
        status: item.status,
        date: item.date,
        messageText: messageText
      });
    }

    // Tarih/Saat Formatlama (Viyana Saati)
    const adjustedLeads = leads.map(lead => {
      if (lead.date && lead.date.includes(':')) {
        const match = lead.date.match(/(\d{2})\.(\d{2})\.(\d{2})\s(\d{1,2}):(\d{2})\s?(AM|PM)?/i);
        if (match) {
          let [ , day, month, year, hours, minutes, ampm ] = match;
          hours = parseInt(hours, 10);
          if (ampm) {
            if (ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
            if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
          }
          
          const dateObj = new Date(2000 + parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), hours + 2, parseInt(minutes, 10));
          return {
            ...lead,
            date: `${String(dateObj.getDate()).padStart(2, '0')}.${String(dateObj.getMonth() + 1).padStart(2, '0')}.${String(dateObj.getFullYear()).slice(-2)} ${String(dateObj.getHours()).padStart(2, '0')}:${String(dateObj.getMinutes()).padStart(2, '0')}`
          };
        }
      }
      return lead;
    });

    const outputData = {
      updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
      leads: adjustedLeads
    };

    // Verileri Kaydet
    fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
    console.log(`🎉 İŞLEM TAMAM! Toplam ${adjustedLeads.length} veri temiz bir şekilde data.json dosyasına yazıldı.`);

    // ❌ ÇEREZLERİ DOSYAYA KAYDETME ADIMI KALDIRILDI (Canlı profil çerezleri user_data içinde saklanıyor)

    // --- GIT PUSH ADIMI ---
    console.log("🚀 GitHub'a güncel veriler push ediliyor...");
    try {
      execSync('git add data.json'); // updated_cookies.json kaldırıldığı için sadece data.json ekleniyor
      execSync('git commit -m "Auto-update data.json [cron]"');
      execSync('git pull --rebase origin main');
      execSync('git push origin main');
      console.log("✅ GitHub'a başarıyla push edildi!");
    } catch (gitErr) {
      console.error("⚠️ Git push hatası:", gitErr.message);
    }

    await browser.close();
  } catch (error) {
    console.error("💥 Scraper hatası:", error.message);
    process.exit(1);
  }
})();
