require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

// --- TELEGRAM BİLDİRİM AYARLARI (.env üzerinden okunuyor) ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PROJECT_NAME = 'Mustafa Reklam'; // Proje ayrımı için

// Telegram Bildirim Fonksiyonu
function sendTelegramMessage(lead) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram bilgileri eksik! Lütfen .env dosyasını kontrol et.");
    return;
  }

  const message = `🔔 *YENİ LSA LEAD!* (${PROJECT_NAME})\n\n` +
                  `👤 *Müşteri:* ${lead.phone}\n` +
                  `📍 *Konum:* ${lead.location}\n` +
                  `💼 *Hizmet:* ${lead.jobType}\n` +
                  `📅 *Tarih:* ${lead.date}\n` +
                  `💬 *Mesaj:* ${lead.messageText}`;

  const data = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = https.request(options, (res) => {
    let responseString = '';
    res.on('data', chunk => { responseString += chunk; });
    res.on('end', () => {
      console.log('📱 Telegram bildirimi başarıyla gönderildi.');
    });
  });

  req.on('error', (error) => {
    console.error('⚠️ Telegram mesajı atılamadı:', error.message);
  });

  req.write(data);
  req.end();
}

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

(async () => {
  try {
    const userDataPath = '/home/ubuntu/mustafa-reklam/user_data';

    // 0. ÇAKIŞMA VE KİLİT DOSYALARINI TEMİZLE
    try {
      const singletonLock = path.join(userDataPath, 'SingletonLock');
      const singletonCookie = path.join(userDataPath, 'SingletonCookie');
      const singletonSocket = path.join(userDataPath, 'SingletonSocket');
      
      if (fs.existsSync(singletonLock)) fs.unlinkSync(singletonLock);
      if (fs.existsSync(singletonCookie)) fs.unlinkSync(singletonCookie);
      if (fs.existsSync(singletonSocket)) fs.unlinkSync(singletonSocket);
    } catch (cleanErr) {
      console.warn("⚠️ Kilit dosyaları temizlenirken ufak uyarı:", cleanErr.message);
    }

    // 1. TARAYICIYI BAŞLAT
    const browser = await puppeteer.launch({
      headless: "new",
      executablePath: '/usr/bin/google-chrome',
      userDataDir: userDataPath, 
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
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

    const targetUrl = 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT';
    console.log("LSA Inbox sayfasına gidiliyor...");
    
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    const pageTitle = await page.title();
    console.log("Sayfa Başlığı:", pageTitle);

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

    // 2. AŞAMA: GERÇEK SATIRLARI VE İÇERİKLERİNİ AKILLI TESPİT ET
    const validRowsIndices = await page.evaluate(() => {
      const allRows = Array.from(document.querySelectorAll('[role="row"], tr'));
      const valid = [];

      allRows.forEach((row, idx) => {
        const text = row.innerText || '';
        
        // Sadece içinde hücre barındıran satırları al
        const rawCells = Array.from(row.querySelectorAll('td, div[role="gridcell"]'));
        
        // ÇÖP AKILLI FİLTRE: İçeriğinde sadece sayı olan (örneğin "2", "4") ilk hücreleri ve boşlukları ele
        const cleanCellTexts = rawCells
          .map(c => c.innerText ? c.innerText.trim() : '')
          .filter(txt => txt.length > 0 && !/^\d{1,3}$/.test(txt));

        if (cleanCellTexts.length >= 3) {
          const isHeader = text.includes('Gebührenstatus') || text.includes('Kunde') || text.includes('Kundenname');
          
          if (!isHeader) {
            const isMessage = /nachricht|message/i.test(text);

            // 1. MÜŞTERİ / TELEFON
            // Sayılardan arındırılmış ilk temiz hücellerden müşteri adını al
            let customerName = cleanCellTexts[0] || '-';
            if (/^\d{1,3}$/.test(customerName)) {
              customerName = cleanCellTexts[1] || '-';
            }

            // 2. HİZMET / JOB TYPE (Örn: Umzug, Entrümpelung vb.)
            let jobType = cleanCellTexts[1] || '-';

            // 3. KONUM (Avusturya PLZ veya Şehir adı yakalama)
            let location = '-';
            const locCell = cleanCellTexts.find(t => /\b(Wien|Graz|Linz|Salzburg|Innsbruck|Klagenfurt|\d{4})\b/i.test(t));
            if (locCell) {
              location = locCell;
            } else {
              location = cleanCellTexts[2] || '-';
            }

            // 4. DURUM (Status)
            let status = '-';
            const statusKeywords = ['neu', 'offen', 'gebucht', 'storniert', 'ausgeführt', 'kontaktier', 'anfrage'];
            const foundStatus = cleanCellTexts.find(t => statusKeywords.some(kw => t.toLowerCase().includes(kw)));
            if (foundStatus) {
              status = foundStatus.split('\n')[0].trim();
            } else {
              status = cleanCellTexts[3] || '-';
            }

            // 5. TARİH / LETZTE AKTIVITÄT
            let lastActivityDate = '-';
            const dateMatchCell = cleanCellTexts.find(t => /\d{2}\.\d{2}\.\d{2}/.test(t) || t.includes('Letzte Aktivität'));
            
            if (dateMatchCell) {
              lastActivityDate = dateMatchCell.replace('Letzte Aktivität', '').replace(':', '').trim();
            } else {
              // Dizinin son hücrelerinde tarih arama
              lastActivityDate = cleanCellTexts[cleanCellTexts.length - 1] || '-';
            }

            // Hayalet Satır Kontrolü
            if (customerName === '-' || (location === '-' && jobType === '-')) {
              return;
            }

            valid.push({
              domIndex: idx,
              phone: customerName,
              jobType: jobType,
              location: location,
              status: status,
              date: lastActivityDate,
              isMessage: isMessage
            });
          }
        }
      });

      return valid;
    });

    console.log(`📊 Gerçek Lead Sayısı: ${validRowsIndices.length}`);

    if (validRowsIndices.length === 0) {
      throw new Error("❌ Sayfada hiçbir mesaj bulunamadı! Sayfa tam yüklenmemiş veya Google engellemiş olabilir.");
    }

    let leads = [];

    // 3. AŞAMA: SATIRLARA TIKLA VE TEMİZ MESAJLARI AL
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
          
          const dateObj = new Date(2000 + parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), hours, parseInt(minutes, 10));
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

    // --- AKILLI GIT PUSH VE BİLDİRİM ADIMI ---
    try {
      const gitStatus = execSync('git status --porcelain data.json').toString().trim();

      if (!gitStatus) {
        console.log("ℹ️ 'data.json' içeriğinde yeni bir değişiklik yok. Git push pas geçildi.");
      } else {
        console.log("🚀 'data.json' güncellendi! GitHub'a push ediliyor...");
        execSync('git add data.json');
        execSync('git commit -m "Auto-update data.json [cron] [skip ci]"');
        execSync('git pull --rebase origin main');
        execSync('git push origin main');
        execSync('git push origin main');
        console.log("✅ GitHub'a başarıyla push edildi!");

        if (adjustedLeads.length > 0) {
          sendTelegramMessage(adjustedLeads[0]);
        }
      }
    } catch (gitErr) {
      console.error("⚠️ Git push hatası:", gitErr.message);
    }

    await browser.close();
  } catch (error) {
    console.error("💥 Scraper hatası:", error.message);
    process.exit(1);
  }
})();
