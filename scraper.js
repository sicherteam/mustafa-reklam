const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
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

    if (!process.env.GOOGLE_COOKIES) {
      throw new Error("GOOGLE_COOKIES secret değişkeni bulunamadı!");
    }

    const rawCookies = JSON.parse(process.env.GOOGLE_COOKIES);
    const cookies = rawCookies.map(cookie => {
      const cleaned = { ...cookie };
      if (cleaned.sameSite === 'no_restriction' || cleaned.sameSite === 'unspecified') {
        delete cleaned.sameSite;
      }
      return cleaned;
    });

    await page.setCookie(...cookies);

    const targetUrl = 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT';
    console.log("LSA Inbox sayfasına gidiliyor...");
    
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    const pageTitle = await page.title();
    console.log("Sayfa Başlığı:", pageTitle);

    if (pageTitle.includes("Anmelden") || pageTitle.includes("Sign in")) {
      throw new Error("Oturum açılamadı! GOOGLE_COOKIES süresi dolmuş veya geçersiz.");
    }

    // Taze çerezleri kaydet
    try {
      const freshCookies = await page.cookies();
      fs.writeFileSync('updated_cookies.json', JSON.stringify(freshCookies, null, 2));
      console.log("Güncellenmiş taze çerezler 'updated_cookies.json' dosyasına kaydedildi.");
    } catch (cookieErr) {
      console.warn("Çerezler güncellenirken hata oluştu:", cookieErr.message);
    }

    console.log("Sayfa içeriğinin yüklenmesi ve scroll yapılması bekleniyor...");
    await new Promise(resolve => setTimeout(resolve, 6000));

    // Tablonun tamamı yüklensin diye yumuşak scroll yap
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        let distance = 300;
        let timer = setInterval(() => {
          let scrollHeight = document.body.scrollHeight;
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

    // 1. AŞAMA: SADECE GERÇEK LEAD SATIRLARINI VE İNDEKSLLERİNİ TESPİT ET
    const validRowsIndices = await page.evaluate(() => {
      const allRows = Array.from(document.querySelectorAll('[role="row"], tr'));
      const valid = [];

      allRows.forEach((row, idx) => {
        const text = row.innerText || '';
        const cells = Array.from(row.querySelectorAll('td, div[role="gridcell"]'));
        
        if (cells.length >= 4) {
          const firstCol = cells[0]?.innerText?.trim() || '';
          
          // "Kunde", "Telefon" başlıklarını veya takvim rakamlarını ele
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

    console.log(`Gerçek Lead Sayısı: ${validRowsIndices.length}`);

    let leads = [];

    // 2. AŞAMA: HER BİR GERÇEK SATIR İÇİN DÖNGÜYE GİR VE MESAJLARI ÇEK
    for (const item of validRowsIndices) {
      let messageText = "-";

      if (item.isMessage) {
        try {
          console.log(`[${item.phone}] Mesaj paneli açılıyor...`);

          // JavaScript Mouse Event'i ile hücresine GERÇEK TIKLAMA simüle et
          const clickSuccess = await page.evaluate((index) => {
            const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
            const targetRow = rows[index];
            if (!targetRow) return false;

            const clickTarget = targetRow.querySelector('td, div[role="gridcell"]') || targetRow;
            
            // Native Event tetikle
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
            // Sağ panelin açılması ve içeriğin Google API'den çekilmesi için bekle
            await new Promise(resolve => setTimeout(resolve, 4500));

            // Mesaj içeriğini yakala
            messageText = await page.evaluate(() => {
              // 1. Yöntem: Google LSA Mesajlaşma Gövdesi
              const conversationElements = Array.from(document.querySelectorAll('div, section, article'));
              
              // "Unterhaltung" veya mesaj içeriğinin yer aldığı ana bloğu bul
              const chatBlock = conversationElements.find(el => {
                const txt = el.innerText || '';
                return (txt.includes('Unterhaltung') || txt.includes('Kundennachricht')) && txt.length > 20;
              });

              if (chatBlock) {
                return chatBlock.innerText.trim();
              }

              // 2. Yöntem: Sağ paneli tümüyle al
              const sideDrawer = document.querySelector('[role="region"], .conversation-view, .detail-view, drawer-content');
              if (sideDrawer && sideDrawer.innerText.length > 10) {
                return sideDrawer.innerText.trim();
              }

              return "-";
            });

            console.log(` -> [${item.phone}] MESAJ BAŞARIYLA ÇEKİLDİ:`, messageText.replace(/\n/g, ' ').substring(0, 45) + "...");
          }

        } catch (err) {
          console.warn(` -> [${item.phone}] Mesaj çekme hatası:`, err.message);
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

    // Verileri data.json dosyasına yaz
    const outputData = {
      updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
      leads: adjustedLeads
    };

    fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
    console.log(`İŞLEM TAMAM! Toplam ${adjustedLeads.length} lead ve tüm mesaj içerikleri data.json'a yazıldı.`);

    await browser.close();
  } catch (error) {
    console.error("Scraper hatası:", error.message);
    process.exit(1);
  }
})();
