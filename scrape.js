import puppeteer from 'puppeteer';
import fs from 'fs';

async function scrapeYahooScores() {
    console.log("Launching headless browser...");
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        
        // Force Central Time zone emulation
        await page.emulateTimezone('America/Chicago');
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log("Navigating to Yahoo NFL Sports Scoreboard...");
        await page.goto('https://sports.yahoo.com/nfl/scoreboard/', { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });

        console.log("Waiting for game cards to load...");
        await page.waitForSelector('div[id^="nfl.g."]', { timeout: 15000 });

        // Give Yahoo's dynamic JS a brief moment to populate times, and odds into the DOM
        console.log("Waiting for metadata elements to render...");
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log("Extracting game cards...");
        const games = await page.evaluate(() => {
            const gameCards = document.querySelectorAll('div[id^="nfl.g."]');
            let results = [];
            let seenGames = new Set();

            gameCards.forEach(card => {
                const cardId = card.id || '';

                const teamContainers = card.querySelectorAll('div._ys_1gde6sj');
                if (teamContainers.length < 2) return;

                // Extract date string from grouped section headers safely by walking up/back in DOM
                let rawDate = '';
                let node = card;
                while (node && !rawDate) {
                    let prev = node.previousElementSibling;
                    while (prev && !rawDate) {
                        const text = prev.innerText.trim();
                        if (text && /^(MON|TUE|WED|THU|FRI|SAT|SUN)/i.test(text) && /\d{4}|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/i.test(text)) {
                            rawDate = text.split('\n')[0].trim();
                        }
                        prev = prev.previousElementSibling;
                    }
                    node = node.parentElement;
                }

                // Convert "Thu, September 24, 2026" into "Thu, 9/24" format
                let formattedDate = '';
                if (rawDate) {
                    try {
                        const parts = rawDate.split(',');
                        const dayOfWeek = parts[0].trim(); // e.g. "Thu"
                        const cleanDateStr = parts.slice(1).join(',').replace(/,\s*\d{4}/, '').trim(); // e.g. "September 24"
                        
                        const parsedDate = new Date(cleanDateStr + ' 2026');
                        if (!isNaN(parsedDate)) {
                            const month = parsedDate.getMonth() + 1;
                            const day = parsedDate.getDate();
                            formattedDate = `${dayOfWeek}, ${month}/${day}`;
                        } else {
                            formattedDate = rawDate;
                        }
                    } catch (e) {
                        formattedDate = rawDate;
                    }
                }

                // Extract time and broadcast channel from metadata elements
                const metaElements = card.querySelectorAll('._ys_qoenog, ._ys_aug67i');
                let rawTime = '';
                let broadcastChannel = '';

                metaElements.forEach(el => {
                    const text = el.innerText.trim();
                    const lower = text.toLowerCase();

                    if (text.includes('O/U') || (text.includes('-') && (text.includes('.') || text.length > 5))) {
                        return;
                    }

                    if ((text.includes(':') || lower.includes('pm') || lower.includes('am')) && !lower.includes('thu') && !lower.includes('fri') && !lower.includes('sat') && !lower.includes('sun')) {
                        rawTime = text;
                    } else if (text.length > 0 && text.length <= 6 && text === text.toUpperCase() && !text.includes('-') && !text.includes('/')) {
                        broadcastChannel = text;
                    }
                });

                // Fallback: If formattedDate is missing, grab today's date
                if (!formattedDate && rawTime) {
                    const now = new Date();
                    formattedDate = `${now.toLocaleDateString('en-US', { weekday: 'short' })}, ${now.getMonth() + 1}/${now.getDate()}`;
                }

                // Format datetime string
                let dateTimeDisplay = [formattedDate, rawTime].filter(Boolean).join(', ');
                if (dateTimeDisplay && !dateTimeDisplay.includes('CDT') && !dateTimeDisplay.includes('CST')) {
                    dateTimeDisplay += ' CDT';
                }

                const fullCardText = card.innerText.toLowerCase();
                const isFinal = fullCardText.includes('final');
                const isLive = fullCardText.includes('q1') || fullCardText.includes('q2') || fullCardText.includes('q3') || fullCardText.includes('q4') || fullCardText.includes('half') || fullCardText.includes('ot');
                const isLiveOrFinal = isFinal || isLive;

                let gameStatus = isFinal ? 'FINAL' : (isLive ? 'LIVE' : 'UPCOMING');

                const extractTeamData = (container) => {
                    const nameEl = container.querySelector('._ys_159h2dm');
                    const name = nameEl ? nameEl.innerText.trim() : '';
                    
                    // Extract record (e.g., "1-2" or "1-2-1" for NFL) or score
                    const allSpans = Array.from(container.querySelectorAll('span'));
                    let record = '';
                    let score = '';
                    
                    allSpans.forEach(span => {
                        const txt = span.innerText.trim();
                        if (/^[0-9]+-[0-9]+(?:-[0-9]+)?$/.test(txt)) {
                            record = txt;
                        }
                    });

                    if (isLiveOrFinal) {
                        const scoreEl = container.querySelector('._ys_1lqk2dn');
                        score = scoreEl ? scoreEl.innerText.trim() : '';
                    }

                    return { name, mascot: '', record, score, rank: '' };
                };

                const awayTeam = extractTeamData(teamContainers[0]);
                const homeTeam = extractTeamData(teamContainers[1]);

                if (!awayTeam.name || !homeTeam.name) return;

                // Logos
                const logos = card.querySelectorAll('img._ys_14fh01c');
                const awayLogo = logos[0] ? logos[0].src : '';
                const homeLogo = logos[1] ? logos[1].src : '';

                const uniqueKey = cardId ? cardId : `${awayTeam.name}-${homeTeam.name}`;
                if (seenGames.has(uniqueKey)) return;
                seenGames.add(uniqueKey);

                // Betting Odds
                const oddsElement = card.querySelector('._ys_ea8nnj');
                let odds = '';
                if (oddsElement) {
                    const text = oddsElement.innerText.trim();
                    if (text.length > 0) {
                        odds = text;
                    }
                }

                results.push({
                    datetime: dateTimeDisplay,
                    status: gameStatus,
                    odds: odds,
                    tv: broadcastChannel,
                    awayTeam: { 
                        name: awayTeam.name, 
                        mascot: awayTeam.mascot, 
                        rank: awayTeam.rank, 
                        record: awayTeam.record, 
                        score: awayTeam.score, 
                        logo: awayLogo 
                    },
                    homeTeam: { 
                        name: homeTeam.name, 
                        mascot: homeTeam.mascot, 
                        rank: homeTeam.rank, 
                        record: homeTeam.record, 
                        score: homeTeam.score, 
                        logo: homeLogo 
                    }
                });
            });

            return results;
        });

        fs.writeFileSync('games.json', JSON.stringify(games, null, 2));
        console.log(`Successfully scraped and saved ${games.length} NFL games to games.json!`);

    } catch (error) {
        console.error("CRITICAL SCRAPE ERROR:", error);
        process.exit(1);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

scrapeYahooScores();
