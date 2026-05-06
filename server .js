require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const analysisLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analyses requested. Please wait an hour and try again.' }
});

// ─────────────────────────────────────────────
// ANTHROPIC CLIENT
// ─────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─────────────────────────────────────────────
// PUPPETEER — fetch EPD data from angus.org
// ─────────────────────────────────────────────
async function fetchAnimalData(regNum) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to the search page
    const searchUrl = `https://www.angus.org/Find-An-Animal`;
    console.log(`Navigating to search page for ${regNum}...`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    // ── Step 1: Dismiss cookie consent if present ──
    try {
      const acceptBtn = await page.$('button[onclick*="Accept"], button[data-cky-tag="accept-button"], .cky-btn-accept');
      if (acceptBtn) {
        await acceptBtn.click();
        console.log('Clicked cookie accept button');
        await new Promise(r => setTimeout(r, 1000));
      } else {
        // Try finding by text content
        await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button')];
          const accept = buttons.find(b => b.textContent.trim().includes('Accept All'));
          if (accept) accept.click();
        });
        await new Promise(r => setTimeout(r, 1000));
        console.log('Dismissed cookie popup via text search');
      }
    } catch(e) {
      console.log('No cookie popup found or could not dismiss:', e.message);
    }

    // ── Step 2: Fill the registration number field (confirmed field name) ──
    await page.waitForSelector('#EpdPedSearchRequest_sAnimalRegNum', { timeout: 10000 });
    await page.click('#EpdPedSearchRequest_sAnimalRegNum');
    await page.type('#EpdPedSearchRequest_sAnimalRegNum', regNum);
    console.log(`Typed reg number: ${regNum}`);

    // ── Step 3: Submit the form ──
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('input[type="submit"]')
    ]);
    console.log('Form submitted, waiting for results...');
    await new Promise(r => setTimeout(r, 2000));

    // ── Step 4: We're already on the animal's EPD page after form submit ──
    // When searching by exact reg number, angus.org redirects directly to the detail page
    // Verify we landed on an EPD detail page
    const currentUrl = page.url();
    console.log(`Current URL after search: ${currentUrl}`);

    if (!currentUrl.includes('EpdPedDtl')) {
      // Not on detail page yet — try clicking the first result link
      const firstLink = await page.$('a[href*="EpdPedDtl"]');
      if (firstLink) {
        const href = await page.evaluate(el => el.href, firstLink);
        console.log(`Not on detail page, navigating to: ${href}`);
        await page.goto(href, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));
      } else {
        const bodyPreview = await page.evaluate(() => document.body.innerText.slice(0, 300));
        throw new Error(`Could not reach EPD detail page. Current URL: ${currentUrl}. Body: ${bodyPreview}`);
      }
    }
    await new Promise(r => setTimeout(r, 3000));

    // ── Step 5: Wait for EPD data to render ──
    await page.waitForFunction(
      () => document.body.innerText.includes('$C') && document.body.innerText.includes('Marb'),
      { timeout: 30000 }
    );

    // ── Step 6: Extract clean structured text ──
    const pageData = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);

      // Remove all noise
      clone.querySelectorAll(
        'script, style, nav, header, footer, iframe, ' +
        '[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], ' +
        '[class*="cky"], [id*="cky"], iframe, ' +
        '[class*="nav"], [class*="menu"], [class*="header"], [class*="footer"], ' +
        '[class*="social"], [class*="share"], [class*="banner"]'
      ).forEach(el => el.remove());

      // Get all text nodes with actual content, skip empty whitespace
      const walker = document.createTreeWalker(
        clone,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const text = node.textContent.trim();
            if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
            // Skip pure whitespace or single chars
            if (/^\s+$/.test(text)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      const lines = [];
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text) lines.push(text);
      }

      return lines.join('\n');
    });

    // Log a preview to confirm we got the right animal
    console.log(`Data preview for ${regNum}:\n${pageData.slice(0, 300)}`);
    console.log(`Total data length: ${pageData.length}`);

    return { success: true, regNum, data: pageData };

  } catch (err) {
    console.error(`Puppeteer error for ${regNum}:`, err.message);
    return { success: false, regNum, error: err.message };
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error('Browser close error:', e));
    }
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert Black Angus seedstock breeding advisor. Analyze mating decisions using the EPD and pedigree data provided.

PARENTAGE RULES (apply in order):
1. DISQUALIFIER: Bull and cow share the same sire or dam.
2. DISQUALIFIER: Bull's direct parent appears as a grandparent of the cow, or vice versa — same ancestor at two generational levels in the calf's pedigree.
3. ALLOWABLE: One shared grandparent maximum, appearing only as a great-grandparent on both sides of the calf.
4. DISQUALIFIER: Two or more separately-shared ancestors.

EPD PERCENTILES: Lower = better. 1% = top of breed. Applies to ALL traits including Claw, Angle, Doc, HS.

$C MARKET: $450+ = premium; $500+ = top dollar. Expected calf $C = (cow $C + bull $C) / 2.

EXPECTED CALF EPD: For each trait, midpoint = (cow EPD + bull EPD) / 2. Convert to approximate breed percentile.

THRESHOLD FLAGS (informational only — never disqualifiers):
- Flag ANY trait where expected calf percentile is 90th or worse (bottom 10%)
- Flag CED, MH, or Milk where expected calf percentile is 10th or better (too extreme favorable)
- Flag CED or BW where expected calf percentile is 5th or better (extremely low BW or extreme CE can produce narrow/weak calves)

OUTPUT FORMAT — output ONLY the data block below. You may reason first, but your final output must end with this exact block starting with the line "===DATA===":

===DATA===
COW_NAME: [name]
COW_REG: [reg number]
COW_C: [value]
COW_C_PCT: [percentile]
COW_MARB: [value]
COW_MARB_PCT: [percentile]
COW_CW: [value]
COW_CW_PCT: [percentile]
COW_RE: [value]
COW_RE_PCT: [percentile]
COW_WW: [value]
COW_WW_PCT: [percentile]
COW_YW: [value]
COW_YW_PCT: [percentile]
COW_BW: [value]
COW_BW_PCT: [percentile]
COW_CED: [value]
COW_CED_PCT: [percentile]
COW_CLAW_PCT: [percentile]
COW_ANGLE_PCT: [percentile]
COW_DOC_PCT: [percentile]
COW_HS_PCT: [percentile]
COW_MILK: [value]
COW_MILK_PCT: [percentile]
COW_SC_PCT: [percentile]
BULL1_NAME: [name]
BULL1_REG: [reg number]
BULL1_PARENTAGE: [PASS or FAIL]
BULL1_PARENTAGE_REASON: [one sentence if FAIL, leave blank if PASS]
BULL1_C: [value]
BULL1_C_PCT: [percentile]
BULL1_MARB: [value]
BULL1_MARB_PCT: [percentile]
BULL1_CW: [value]
BULL1_CW_PCT: [percentile]
BULL1_RE: [value]
BULL1_RE_PCT: [percentile]
BULL1_WW: [value]
BULL1_WW_PCT: [percentile]
BULL1_YW: [value]
BULL1_YW_PCT: [percentile]
BULL1_BW: [value]
BULL1_BW_PCT: [percentile]
BULL1_CED: [value]
BULL1_CED_PCT: [percentile]
BULL1_CLAW_PCT: [percentile]
BULL1_ANGLE_PCT: [percentile]
BULL1_DOC_PCT: [percentile]
BULL1_HS_PCT: [percentile]
BULL1_MILK: [value]
BULL1_MILK_PCT: [percentile]
BULL1_SC_PCT: [percentile]
BULL1_MIDPOINT_C: [expected calf $C midpoint number only]
BULL1_FLAG: [flag text or leave blank]
BULL1_FLAG: [additional flag if needed, repeat this line for each flag]
===END===

For multiple bulls, repeat BULL1_ block as BULL2_, BULL3_, etc.
Use numbers only for values and percentiles — no $ signs, no % signs, no extra text on data lines.`;

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Diagnostic endpoint — check where chromium is installed
app.get('/api/check-chromium', (req, res) => {
  const { execSync } = require('child_process');
  const checks = {};
  const paths = [
    'which chromium',
    'which chromium-browser',
    'which google-chrome',
    'which google-chrome-stable',
    'ls /usr/bin/chrom*',
    'ls /nix/store/ | grep chrom | head -5',
    'find /nix -name "chromium" -type f 2>/dev/null | head -5',
    'find /usr -name "chrom*" -type f 2>/dev/null | head -5'
  ];
  for (const cmd of paths) {
    try {
      checks[cmd] = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    } catch(e) {
      checks[cmd] = `not found: ${e.message.slice(0, 50)}`;
    }
  }
  res.json(checks);
});

// Diagnostic endpoint — test Puppeteer fetch for a single reg number
// Usage: /api/test-fetch/21179283
app.get('/api/test-fetch/:regNum', async (req, res) => {
  const { regNum } = req.params;
  console.log(`Test fetch for: ${regNum}`);
  const result = await fetchAnimalData(regNum);
  res.json({
    success: result.success,
    regNum: result.regNum,
    error: result.error || null,
    dataLength: result.data ? result.data.length : 0,
    dataStart: result.data ? result.data.slice(0, 500) : null,
    dataMiddle: result.data ? result.data.slice(3000, 6000) : null,
    dataEnd: result.data ? result.data.slice(-2000) : null
  });
});

app.post('/api/analyze', analysisLimiter, async (req, res) => {
  const { cow, cowNotes, bulls, outputMode, priorityValues } = req.body;

  if (!cow || !bulls || !Array.isArray(bulls) || bulls.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const filledBulls = bulls.filter(b => b && b.trim());
  if (filledBulls.length === 0) {
    return res.status(400).json({ error: 'Please enter at least one bull.' });
  }

  const priorities = (priorityValues && priorityValues.length > 0)
    ? priorityValues.join(', ') : '$C';

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  try {
    // ── STEP 1: Fetch all animal data via Puppeteer ──
    sendEvent('status', { message: 'Looking up cow on angus.org...' });
    const cowResult = await fetchAnimalData(cow.trim());

    const bullResults = [];
    for (let i = 0; i < filledBulls.length; i++) {
      sendEvent('status', { message: `Looking up bull ${i + 1} of ${filledBulls.length}...` });
      const result = await fetchAnimalData(filledBulls[i].trim());
      bullResults.push(result);
    }

    // ── STEP 2: Build prompt with real data ──
    sendEvent('status', { message: 'Running breeding analysis...' });

    const cowSection = cowResult.success
      ? `COW (Reg# ${cowResult.regNum}):\n${cowResult.data}`
      : `COW (Reg# ${cow}): Data retrieval failed — ${cowResult.error}. Please verify the registration number.`;

    const bullSections = bullResults.map((r, i) =>
      r.success
        ? `BULL ${i + 1} (Reg# ${r.regNum}):\n${r.data}`
        : `BULL ${i + 1} (Reg# ${filledBulls[i]}): Data retrieval failed — ${r.error}. Please verify the registration number.`
    ).join('\n\n---\n\n');

    const userPrompt = `Analyze this breeding scenario using the EPD and pedigree data below.
${cowNotes ? `Producer notes: ${cowNotes}` : ''}
PRIORITY $VALUES: ${priorities}

${cowSection}

---

${bullSections}

Apply all parentage rules, compare EPDs weighted toward priority $Values, assess foot structure contextually, and give your recommendation.`;

    // ── STEP 3: Claude analysis (no web search needed) ──
    const runStream = async (attempt = 1) => {
      try {
        const stream = anthropic.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }]
        });

        let fullText = '';

        stream.on('text', (text) => {
          fullText += text;
          sendEvent('text', { text });
        });

        stream.on('message', () => {
          console.log('Claude response preview:', fullText.slice(0, 200));

          // Extract the data block between ===DATA=== and ===END===
          const dataMatch = fullText.match(/===DATA===([\s\S]*?)===END===/);
          if (dataMatch) {
            const dataBlock = dataMatch[1];
            console.log('Data block found, length:', dataBlock.length);

            // Parse key-value pairs
            const get = (key) => {
              const match = dataBlock.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
              return match ? match[1].trim() : null;
            };
            const getAll = (key) => {
              const regex = new RegExp(`^${key}:\\s*(.+)$`, 'gm');
              const results = [];
              let m;
              while ((m = regex.exec(dataBlock)) !== null) results.push(m[1].trim());
              return results;
            };
            const num = (key) => { const v = get(key); return v ? parseFloat(v) : null; };
            const pct = (key) => { const v = get(key); return v ? parseInt(v) : null; };

            // Build structured data object
            const parsed = {
              cow: {
                name: get('COW_NAME'),
                regNum: get('COW_REG'),
                epds: {
                  '$C': num('COW_C'), '$C_pct': pct('COW_C_PCT'),
                  'Marb': num('COW_MARB'), 'Marb_pct': pct('COW_MARB_PCT'),
                  'CW': num('COW_CW'), 'CW_pct': pct('COW_CW_PCT'),
                  'RE': num('COW_RE'), 'RE_pct': pct('COW_RE_PCT'),
                  'WW': num('COW_WW'), 'WW_pct': pct('COW_WW_PCT'),
                  'YW': num('COW_YW'), 'YW_pct': pct('COW_YW_PCT'),
                  'BW': num('COW_BW'), 'BW_pct': pct('COW_BW_PCT'),
                  'CED': num('COW_CED'), 'CED_pct': pct('COW_CED_PCT'),
                  'Claw_pct': pct('COW_CLAW_PCT'),
                  'Angle_pct': pct('COW_ANGLE_PCT'),
                  'Doc_pct': pct('COW_DOC_PCT'),
                  'HS_pct': pct('COW_HS_PCT'),
                  'Milk': num('COW_MILK'), 'Milk_pct': pct('COW_MILK_PCT'),
                  'SC_pct': pct('COW_SC_PCT'),
                }
              },
              bulls: [],
              recommendation: { expectedCalfC: '' }
            };

            // Parse bulls (support up to 6)
            for (let i = 1; i <= 6; i++) {
              const prefix = `BULL${i}`;
              const name = get(`${prefix}_NAME`);
              if (!name) break;
              const midC = num(`${prefix}_MIDPOINT_C`);
              parsed.bulls.push({
                name,
                regNum: get(`${prefix}_REG`),
                parentageResult: get(`${prefix}_PARENTAGE`),
                parentageReason: get(`${prefix}_PARENTAGE_REASON`) || '',
                expectedMidpointC: midC,
                flags: getAll(`${prefix}_FLAG`).filter(f => f && f.length > 2),
                epds: {
                  '$C': num(`${prefix}_C`), '$C_pct': pct(`${prefix}_C_PCT`),
                  'Marb': num(`${prefix}_MARB`), 'Marb_pct': pct(`${prefix}_MARB_PCT`),
                  'CW': num(`${prefix}_CW`), 'CW_pct': pct(`${prefix}_CW_PCT`),
                  'RE': num(`${prefix}_RE`), 'RE_pct': pct(`${prefix}_RE_PCT`),
                  'WW': num(`${prefix}_WW`), 'WW_pct': pct(`${prefix}_WW_PCT`),
                  'YW': num(`${prefix}_YW`), 'YW_pct': pct(`${prefix}_YW_PCT`),
                  'BW': num(`${prefix}_BW`), 'BW_pct': pct(`${prefix}_BW_PCT`),
                  'CED': num(`${prefix}_CED`), 'CED_pct': pct(`${prefix}_CED_PCT`),
                  'Claw_pct': pct(`${prefix}_CLAW_PCT`),
                  'Angle_pct': pct(`${prefix}_ANGLE_PCT`),
                  'Doc_pct': pct(`${prefix}_DOC_PCT`),
                  'HS_pct': pct(`${prefix}_HS_PCT`),
                  'Milk': num(`${prefix}_MILK`), 'Milk_pct': pct(`${prefix}_MILK_PCT`),
                  'SC_pct': pct(`${prefix}_SC_PCT`),
                }
              });
            }

            // Set recommendation expectedCalfC from first eligible bull
            const firstEligible = parsed.bulls.find(b => b.parentageResult === 'PASS');
            if (firstEligible) {
              parsed.recommendation.expectedCalfC = `~$${firstEligible.expectedMidpointC}`;
            }

            console.log('Parsed:', parsed.cow?.name, parsed.bulls.length, 'bulls');
            sendEvent('done', { parsed });
          } else {
            console.log('No ===DATA=== block found in response');
            console.log('Full response:', fullText.slice(0, 1000));
            sendEvent('error', { message: 'Could not extract data from analysis. Please try again.' });
          }
          res.end();
        });

        stream.on('error', async (err) => {
          if (err.status === 429 && attempt < 2) {
            sendEvent('status', { message: 'Rate limit — retrying in 15 seconds...' });
            await new Promise(r => setTimeout(r, 15000));
            return runStream(attempt + 1);
          }
          sendEvent('error', {
            message: err.status === 429
              ? 'Rate limit reached. Please wait 60 seconds and try again.'
              : err.message
          });
          res.end();
        });

      } catch (err) {
        sendEvent('error', { message: err.message });
        res.end();
      }
    };

    runStream();

  } catch (err) {
    console.error('Analysis error:', err);
    sendEvent('error', { message: err.message });
    res.end();
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Angus Breeding Analyzer running on port ${PORT}`);
  console.log(`API key: ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING'}`);
});
