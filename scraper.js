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

    const targetUrl = 'https://ads.google.com/localservices/inbox?cid=2903573653&bid=10985702078&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT';
    console.log("LSA Inbox sayfasına gidiliyor...");
    
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    const pageTitle = await page.title();
    console.log("Sayfa Başlığı:", pageTitle);

    if (pageTitle.includes("Anmelden") || pageTitle.includes("Sign in")) {
      throw new Error("Oturum açılamadı! GOOGLE_COOKIES süresi dolmuş veya geçersiz.");
    }

    // Taze çerezleri sakla
    try {
      const freshCookies = await page.cookies();
      fs.writeFileSync('updated_cookies.json', JSON.stringify(freshCookies, null, 2));
      console.log("Güncellenmiş taze çerezler 'updated_cookies.json' dosyasına kaydedildi.");
    } catch (cookieErr) {
      console.warn("Çerezler güncellenirken hata oluştu:", cookieErr.message);
    }

    console.log("İçeriğin yüklenmesi bekleniyor...");
    await new Promise(resolve => setTimeout(resolve, 8000));

    // TABLO SATIRLARINI VE MESAJ BİLGİLERİNİ ÇEKME
    let leads = [];
    const totalRowsCount = await page.$$eval('[role="row"], tr', rows => rows.length);
    console.log(`Toplam ${totalRowsCount} adet satır elementi tespit edildi.`);

    for (let i = 0; i < totalRowsCount; i++) {
      // DOM değişken nesneleri için elemanları her döngüde taze seçiyoruz
      const currentRows = await page.$$('[role="row"], tr');
      if (!currentRows[i]) continue;

      const row = currentRows[i];

      // Satırdaki verileri oku
      const rowData = await row.evaluate(el => {
        const cells = Array.from(el.querySelectorAll('td, div[role="gridcell"]'));
        if (cells.length < 5) return null;

        const rowText = el.innerText || '';
        const phoneOrName = cells[0]?.innerText?.trim() || '';
        const jobType = cells[1]?.innerText?.trim() || '-';
        const location = cells[3]?.innerText?.trim() || '-';
        
        // Satır içinde "Nachricht" veya "Message" geçiyor mu?
        const isMessage = /nachricht|message/i.test(rowText);

        let rawStatus = cells[5]?.innerText?.trim() || cells[4]?.innerText?.trim() || '-';
        const status = rawStatus.split('\n')[0].trim();

        const date = cells[6]?.innerText?.trim() || cells[5]?.innerText?.trim() || '-';

        // 'Kunde' veya tablo başlıkları değilse kabul et (İsim veya Numara fark etmeksizin)
        if (phoneOrName && phoneOrName !== 'Kunde' && !phoneOrName.includes('Telefon')) {
          return { phone: phoneOrName, jobType, location, isMessage, status, date };
        }
        return null;
      });

      if (!rowData) continue;

      let messageText = "-";

      // Eğer satır mesaj içeriyorsa tıkla ve sağ panelden metni çek
      if (rowData.isMessage) {
        try {
          console.log(`[${rowData.phone}] Mesaj detayına tıklanıyor...`);

          // Garanti tıklama için ilk hücreye veya satıra tıkla
          const cellToClick = await row.$('td, div[role="gridcell"]');
          if (cellToClick) {
            await cellToClick.click();
          } else {
            await row.click();
          }
          
          // Panel içeriğinin değişmesi için 3.5 saniye bekle
          await new Promise(resolve => setTimeout(resolve, 3500));

          // Detay panelinden "Unterhaltung" metnini yakala
          messageText = await page.evaluate(() => {
            const allBoxes = Array.from(document.querySelectorAll('div, section'));
            
            // "Unterhaltung" kelimesini içeren ana kutuyu bul
            const chatBox = allBoxes.find(b => {
              const txt = b.innerText || '';
              return txt.includes('Unterhaltung') && txt.length > 25;
            });

            if (chatBox) {
              const fullText = chatBox.innerText;
              const parts = fullText.split('Unterhaltung');
              if (parts.length > 1) {
                return parts[1].trim();
              }
              return fullText.trim();
            }

            // Alternatif kapsayıcı kontrolü
            const conversationEl = document.querySelector('.conversation-view, [role="region"]');
            if (conversationEl) {
              return conversationEl.innerText.trim();
            }

            return "-";
          });

          console.log(` -> [${rowData.phone}] Mesaj çekildi: ${messageText.substring(0, 35)}...`);

        } catch (clickErr) {
          console.warn(` -> [${rowData.phone}] Tıklama hatası:`, clickErr.message);
        }
      }

      leads.push({
        phone: rowData.phone,
        jobType: rowData.jobType,
        location: rowData.location,
        status: rowData.status,
        date: rowData.date,
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

    // Verileri data.json dosyasına yaz
    const outputData = {
      updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
      leads: adjustedLeads
    };

    fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
    console.log(`Başarıyla ${adjustedLeads.length} adet veri (Christian Poterucha dahil) data.json dosyasına yazıldı!`);

    await browser.close();
  } catch (error) {
    console.error("Scraper çalışırken hata oluştu:", error.message);
    process.exit(1);
  }
})();
