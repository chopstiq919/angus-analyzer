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
async function fetchAnimalData(regNum, attempt = 1) {
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

    // Navigate — domcontentloaded is faster than networkidle2
    await page.goto('https://www.angus.org/Find-An-Animal', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // ── Step 1: Dismiss cookie consent if present ──
    try {
      await page.waitForSelector('button, .cky-btn-accept', { timeout: 3000 });
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const accept = buttons.find(b =>
          b.textContent.trim().includes('Accept All') ||
          b.getAttribute('data-cky-tag') === 'accept-button'
        );
        if (accept) accept.click();
      });
      await new Promise(r => setTimeout(r, 300));
    } catch(e) { /* no cookie popup */ }

    // ── Step 2: Fill registration number ──
    await page.waitForSelector('#EpdPedSearchRequest_sAnimalRegNum', { timeout: 10000 });
    await page.type('#EpdPedSearchRequest_sAnimalRegNum', regNum);

    // ── Step 3: Submit form ──
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      page.click('input[type="submit"]')
    ]);

    // ── Step 4: Verify we're on the EPD detail page ──
    const currentUrl = page.url();
    if (!currentUrl.includes('EpdPedDtl')) {
      const firstLink = await page.$('a[href*="EpdPedDtl"]');
      if (firstLink) {
        const href = await page.evaluate(el => el.href, firstLink);
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } else {
        throw new Error(`Could not reach EPD page for ${regNum}`);
      }
    }

    // ── Step 5: Wait for EPD data (no fixed timeout — proceeds as soon as ready) ──
    await page.waitForFunction(
      () => document.body.innerText.includes('$C') && document.body.innerText.includes('Marb'),
      { timeout: 30000 }
    );

    // ── Step 6: Extract clean text, stripping token-wasting boilerplate ──
    const pageData = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);

      // Remove noise elements
      clone.querySelectorAll(
        'script, style, nav, header, footer, iframe, ' +
        '[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], ' +
        '[class*="cky"], [id*="cky"], ' +
        '[class*="nav"], [class*="menu"], [class*="header"], [class*="footer"], ' +
        '[class*="social"], [class*="share"], [class*="banner"]'
      ).forEach(el => el.remove());

      const walker = document.createTreeWalker(
        clone, NodeFilter.SHOW_TEXT,
        { acceptNode: (node) => {
          const t = node.textContent.trim();
          if (!t || t.length < 2 || /^\s+$/.test(t)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }}
      );

      const lines = [];
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim();
        if (t) lines.push(t);
      }

      const fullText = lines.join('\n');

      // Strip the genetic condition codes legend — it's ~2000 tokens of boilerplate
      // Everything after "The American Angus Association currently recognizes" is not needed
      const cutoff = fullText.indexOf('The American Angus Association currently recognizes');
      return cutoff > 0 ? fullText.slice(0, cutoff).trim() : fullText;
    });

    console.log(`Fetched ${regNum}: ${pageData.length} chars`);
    return { success: true, regNum, data: pageData };

  } catch (err) {
    console.error(`Puppeteer error for ${regNum} (attempt ${attempt}):`, err.message);
    // Retry once on timeout
    if (attempt < 2 && err.message.includes('timeout')) {
      console.log(`Retrying ${regNum}...`);
      if (browser) await browser.close().catch(() => {});
      return fetchAnimalData(regNum, 2);
    }
    return { success: false, regNum, error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert Black Angus seedstock breeding advisor.

PARENTAGE RULES:
1. DISQUALIFIER: Bull and cow share the same sire or dam.
2. DISQUALIFIER: Bull's direct parent appears as a grandparent of the cow, or vice versa.
3. ALLOWABLE: One shared grandparent maximum, appearing only as a great-grandparent on both sides of the calf.
4. DISQUALIFIER: Two or more separately-shared ancestors.

EPD PERCENTILES: Lower = better. 1% = top of breed.
$C MARKET: $450+ = premium; $500+ = top dollar.

!!! CRITICAL INSTRUCTION !!!
Do NOT write any reasoning, analysis, pedigree walkthrough, or explanation.
Output ONLY the ===DATA=== block. Nothing before it. Nothing after it.
Start your response with ===DATA=== on the very first line.

===DATA===
COW_NAME: [name]
COW_REG: [reg number]
COW_C: [value]
COW_C_PCT: [percentile]
COW_B: [value]
COW_B_PCT: [percentile]
COW_W: [value]
COW_W_PCT: [percentile]
COW_M: [value]
COW_M_PCT: [percentile]
COW_F: [value]
COW_F_PCT: [percentile]
COW_G: [value]
COW_G_PCT: [percentile]
COW_CED: [value]
COW_CED_PCT: [percentile]
COW_BW: [value]
COW_BW_PCT: [percentile]
COW_WW: [value]
COW_WW_PCT: [percentile]
COW_YW: [value]
COW_YW_PCT: [percentile]
COW_RADG: [value]
COW_RADG_PCT: [percentile]
COW_DMI: [value]
COW_DMI_PCT: [percentile]
COW_YH: [value]
COW_YH_PCT: [percentile]
COW_SC: [value]
COW_SC_PCT: [percentile]
COW_HP: [value]
COW_HP_PCT: [percentile]
COW_CEM: [value]
COW_CEM_PCT: [percentile]
COW_MILK: [value]
COW_MILK_PCT: [percentile]
COW_MKH: [value]
COW_MKH_PCT: [percentile]
COW_TEAT: [value]
COW_TEAT_PCT: [percentile]
COW_UDDR: [value]
COW_UDDR_PCT: [percentile]
COW_FL: [value]
COW_FL_PCT: [percentile]
COW_MW: [value]
COW_MW_PCT: [percentile]
COW_MH: [value]
COW_MH_PCT: [percentile]
COW_EN: [value]
COW_EN_PCT: [percentile]
COW_DOC_PCT: [percentile]
COW_CLAW_PCT: [percentile]
COW_ANGLE_PCT: [percentile]
COW_PAP_PCT: [percentile]
COW_HS_PCT: [percentile]
COW_CW: [value]
COW_CW_PCT: [percentile]
COW_MARB: [value]
COW_MARB_PCT: [percentile]
COW_RE: [value]
COW_RE_PCT: [percentile]
COW_FAT: [value]
COW_FAT_PCT: [percentile]
COW_AXH: [value]
COW_AXH_PCT: [percentile]
COW_AXJ: [value]
COW_AXJ_PCT: [percentile]
BULL1_NAME: [name]
BULL1_REG: [reg number]
BULL1_PARENTAGE: [PASS or FAIL]
BULL1_PARENTAGE_REASON: [one sentence if FAIL, blank if PASS]
BULL1_C: [value]
BULL1_C_PCT: [percentile]
BULL1_B: [value]
BULL1_B_PCT: [percentile]
BULL1_W: [value]
BULL1_W_PCT: [percentile]
BULL1_M: [value]
BULL1_M_PCT: [percentile]
BULL1_F: [value]
BULL1_F_PCT: [percentile]
BULL1_G: [value]
BULL1_G_PCT: [percentile]
BULL1_CED: [value]
BULL1_CED_PCT: [percentile]
BULL1_BW: [value]
BULL1_BW_PCT: [percentile]
BULL1_WW: [value]
BULL1_WW_PCT: [percentile]
BULL1_YW: [value]
BULL1_YW_PCT: [percentile]
BULL1_RADG: [value]
BULL1_RADG_PCT: [percentile]
BULL1_DMI: [value]
BULL1_DMI_PCT: [percentile]
BULL1_YH: [value]
BULL1_YH_PCT: [percentile]
BULL1_SC: [value]
BULL1_SC_PCT: [percentile]
BULL1_HP: [value]
BULL1_HP_PCT: [percentile]
BULL1_CEM: [value]
BULL1_CEM_PCT: [percentile]
BULL1_MILK: [value]
BULL1_MILK_PCT: [percentile]
BULL1_MKH: [value]
BULL1_MKH_PCT: [percentile]
BULL1_TEAT: [value]
BULL1_TEAT_PCT: [percentile]
BULL1_UDDR: [value]
BULL1_UDDR_PCT: [percentile]
BULL1_FL: [value]
BULL1_FL_PCT: [percentile]
BULL1_MW: [value]
BULL1_MW_PCT: [percentile]
BULL1_MH: [value]
BULL1_MH_PCT: [percentile]
BULL1_EN: [value]
BULL1_EN_PCT: [percentile]
BULL1_DOC_PCT: [percentile]
BULL1_CLAW_PCT: [percentile]
BULL1_ANGLE_PCT: [percentile]
BULL1_PAP_PCT: [percentile]
BULL1_HS_PCT: [percentile]
BULL1_CW: [value]
BULL1_CW_PCT: [percentile]
BULL1_MARB: [value]
BULL1_MARB_PCT: [percentile]
BULL1_RE: [value]
BULL1_RE_PCT: [percentile]
BULL1_FAT: [value]
BULL1_FAT_PCT: [percentile]
BULL1_AXH: [value]
BULL1_AXH_PCT: [percentile]
BULL1_AXJ: [value]
BULL1_AXJ_PCT: [percentile]
BULL1_MIDPOINT_C: [number]
===END===

For multiple bulls repeat BULL1_ as BULL2_, BULL3_, etc.
Numbers only — no $ signs, no % signs, no text on data lines.`;

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
    // ── STEP 1: Fetch animals sequentially (parallel causes memory timeouts) ──
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
          max_tokens: Math.min(3000 + (filledBulls.length * 800), 6000),
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
                  '$B': num('COW_B'), '$B_pct': pct('COW_B_PCT'),
                  '$W': num('COW_W'), '$W_pct': pct('COW_W_PCT'),
                  '$M': num('COW_M'), '$M_pct': pct('COW_M_PCT'),
                  '$F': num('COW_F'), '$F_pct': pct('COW_F_PCT'),
                  '$G': num('COW_G'), '$G_pct': pct('COW_G_PCT'),
                  'CED': num('COW_CED'), 'CED_pct': pct('COW_CED_PCT'),
                  'BW': num('COW_BW'), 'BW_pct': pct('COW_BW_PCT'),
                  'WW': num('COW_WW'), 'WW_pct': pct('COW_WW_PCT'),
                  'YW': num('COW_YW'), 'YW_pct': pct('COW_YW_PCT'),
                  'RADG': num('COW_RADG'), 'RADG_pct': pct('COW_RADG_PCT'),
                  'DMI': num('COW_DMI'), 'DMI_pct': pct('COW_DMI_PCT'),
                  'YH': num('COW_YH'), 'YH_pct': pct('COW_YH_PCT'),
                  'SC': num('COW_SC'), 'SC_pct': pct('COW_SC_PCT'),
                  'HP': num('COW_HP'), 'HP_pct': pct('COW_HP_PCT'),
                  'CEM': num('COW_CEM'), 'CEM_pct': pct('COW_CEM_PCT'),
                  'Milk': num('COW_MILK'), 'Milk_pct': pct('COW_MILK_PCT'),
                  'MKH': num('COW_MKH'), 'MKH_pct': pct('COW_MKH_PCT'),
                  'Teat': num('COW_TEAT'), 'Teat_pct': pct('COW_TEAT_PCT'),
                  'UDDR': num('COW_UDDR'), 'UDDR_pct': pct('COW_UDDR_PCT'),
                  'FL': num('COW_FL'), 'FL_pct': pct('COW_FL_PCT'),
                  'MW': num('COW_MW'), 'MW_pct': pct('COW_MW_PCT'),
                  'MH': num('COW_MH'), 'MH_pct': pct('COW_MH_PCT'),
                  'EN': num('COW_EN'), 'EN_pct': pct('COW_EN_PCT'),
                  'Doc_pct': pct('COW_DOC_PCT'),
                  'Claw_pct': pct('COW_CLAW_PCT'),
                  'Angle_pct': pct('COW_ANGLE_PCT'),
                  'PAP_pct': pct('COW_PAP_PCT'),
                  'HS_pct': pct('COW_HS_PCT'),
                  'CW': num('COW_CW'), 'CW_pct': pct('COW_CW_PCT'),
                  'Marb': num('COW_MARB'), 'Marb_pct': pct('COW_MARB_PCT'),
                  'RE': num('COW_RE'), 'RE_pct': pct('COW_RE_PCT'),
                  'Fat': num('COW_FAT'), 'Fat_pct': pct('COW_FAT_PCT'),
                  'AxH': num('COW_AXH'), 'AxH_pct': pct('COW_AXH_PCT'),
                  'AxJ': num('COW_AXJ'), 'AxJ_pct': pct('COW_AXJ_PCT'),
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
                  '$B': num(`${prefix}_B`), '$B_pct': pct(`${prefix}_B_PCT`),
                  '$W': num(`${prefix}_W`), '$W_pct': pct(`${prefix}_W_PCT`),
                  '$M': num(`${prefix}_M`), '$M_pct': pct(`${prefix}_M_PCT`),
                  '$F': num(`${prefix}_F`), '$F_pct': pct(`${prefix}_F_PCT`),
                  '$G': num(`${prefix}_G`), '$G_pct': pct(`${prefix}_G_PCT`),
                  'CED': num(`${prefix}_CED`), 'CED_pct': pct(`${prefix}_CED_PCT`),
                  'BW': num(`${prefix}_BW`), 'BW_pct': pct(`${prefix}_BW_PCT`),
                  'WW': num(`${prefix}_WW`), 'WW_pct': pct(`${prefix}_WW_PCT`),
                  'YW': num(`${prefix}_YW`), 'YW_pct': pct(`${prefix}_YW_PCT`),
                  'RADG': num(`${prefix}_RADG`), 'RADG_pct': pct(`${prefix}_RADG_PCT`),
                  'DMI': num(`${prefix}_DMI`), 'DMI_pct': pct(`${prefix}_DMI_PCT`),
                  'YH': num(`${prefix}_YH`), 'YH_pct': pct(`${prefix}_YH_PCT`),
                  'SC': num(`${prefix}_SC`), 'SC_pct': pct(`${prefix}_SC_PCT`),
                  'HP': num(`${prefix}_HP`), 'HP_pct': pct(`${prefix}_HP_PCT`),
                  'CEM': num(`${prefix}_CEM`), 'CEM_pct': pct(`${prefix}_CEM_PCT`),
                  'Milk': num(`${prefix}_MILK`), 'Milk_pct': pct(`${prefix}_MILK_PCT`),
                  'MKH': num(`${prefix}_MKH`), 'MKH_pct': pct(`${prefix}_MKH_PCT`),
                  'Teat': num(`${prefix}_TEAT`), 'Teat_pct': pct(`${prefix}_TEAT_PCT`),
                  'UDDR': num(`${prefix}_UDDR`), 'UDDR_pct': pct(`${prefix}_UDDR_PCT`),
                  'FL': num(`${prefix}_FL`), 'FL_pct': pct(`${prefix}_FL_PCT`),
                  'MW': num(`${prefix}_MW`), 'MW_pct': pct(`${prefix}_MW_PCT`),
                  'MH': num(`${prefix}_MH`), 'MH_pct': pct(`${prefix}_MH_PCT`),
                  'EN': num(`${prefix}_EN`), 'EN_pct': pct(`${prefix}_EN_PCT`),
                  'Doc_pct': pct(`${prefix}_DOC_PCT`),
                  'Claw_pct': pct(`${prefix}_CLAW_PCT`),
                  'Angle_pct': pct(`${prefix}_ANGLE_PCT`),
                  'PAP_pct': pct(`${prefix}_PAP_PCT`),
                  'HS_pct': pct(`${prefix}_HS_PCT`),
                  'CW': num(`${prefix}_CW`), 'CW_pct': pct(`${prefix}_CW_PCT`),
                  'Marb': num(`${prefix}_MARB`), 'Marb_pct': pct(`${prefix}_MARB_PCT`),
                  'RE': num(`${prefix}_RE`), 'RE_pct': pct(`${prefix}_RE_PCT`),
                  'Fat': num(`${prefix}_FAT`), 'Fat_pct': pct(`${prefix}_FAT_PCT`),
                  'AxH': num(`${prefix}_AXH`), 'AxH_pct': pct(`${prefix}_AXH_PCT`),
                  'AxJ': num(`${prefix}_AXJ`), 'AxJ_pct': pct(`${prefix}_AXJ_PCT`),
                }
              });
            }

            // Set recommendation expectedCalfC from first eligible bull
            const firstEligible = parsed.bulls.find(b => b.parentageResult === 'PASS');
            if (firstEligible) {
              parsed.recommendation.expectedCalfC = `~$${firstEligible.expectedMidpointC}`;
            }

            // ── Calculate flags server-side from actual midpoint percentiles ──
            const cowE = parsed.cow.epds;
            const midPct = (cowKey, bullKey) => {
              const c = cowE[cowKey];
              const b = bullKey; // already a number
              if (c == null || b == null) return null;
              return Math.round((c + b) / 2);
            };

            // Trait definitions for flag calculation
            const pctTraits = [
              { label: 'Claw', cowKey: 'Claw_pct' },
              { label: 'Angle', cowKey: 'Angle_pct' },
              { label: 'Doc', cowKey: 'Doc_pct' },
              { label: 'HS', cowKey: 'HS_pct' },
              { label: 'SC', cowKey: 'SC_pct' },
              { label: 'Teat', cowKey: 'Teat_pct' },
              { label: 'UDDR', cowKey: 'UDDR_pct' },
            ];
            const valTraits = [
              { label: '$C', cowKey: '$C_pct' },
              { label: 'Marb', cowKey: 'Marb_pct' },
              { label: 'CW', cowKey: 'CW_pct' },
              { label: 'RE', cowKey: 'RE_pct' },
              { label: 'WW', cowKey: 'WW_pct' },
              { label: 'YW', cowKey: 'YW_pct' },
              { label: 'BW', cowKey: 'BW_pct' },
              { label: 'CED', cowKey: 'CED_pct' },
              { label: 'Milk', cowKey: 'Milk_pct' },
              { label: 'RADG', cowKey: 'RADG_pct' },
              { label: 'DMI', cowKey: 'DMI_pct' },
              { label: 'YH', cowKey: 'YH_pct' },
              { label: 'MW', cowKey: 'MW_pct' },
              { label: 'MH', cowKey: 'MH_pct' },
            ];

            parsed.bulls.forEach(bull => {
              if (bull.parentageResult !== 'PASS') return;
              const be = bull.epds;
              const flags = [];

              // Check all percentile-only traits (lower = better, flag at >= 90)
              pctTraits.forEach(t => {
                const cp = cowE[t.cowKey];
                const bp = be[t.cowKey];
                if (cp == null || bp == null) return;
                const mid = Math.round((cp + bp) / 2);
                if (mid >= 90) flags.push(`⚠️ ${t.label}: expected calf avg ~${mid}th percentile — bottom 10% of breed`);
              });

              // Check value traits with percentile
              valTraits.forEach(t => {
                const cp = cowE[t.cowKey];
                const bp = be[t.cowKey];
                if (cp == null || bp == null) return;
                const mid = Math.round((cp + bp) / 2);

                // Bottom 10% flag (>= 90th percentile, lower is better)
                if (mid >= 90) {
                  flags.push(`⚠️ ${t.label}: expected calf avg ~${mid}th percentile — bottom 10% of breed`);
                }

                // Too-extreme favorable flags for CED, Milk (top 10%, <= 10th percentile)
                if (['CED', 'Milk'].includes(t.label) && mid <= 10) {
                  if (t.label === 'BW' || t.label === 'CED') {
                    flags.push(`⚠️ ${t.label}: expected calf avg ~${mid}th percentile — extremely favorable; monitor for narrow/weak calves`);
                  } else {
                    flags.push(`⚠️ ${t.label}: expected calf avg ~${mid}th percentile — top 10% extreme; monitor in offspring`);
                  }
                }

                // BW and CED top 5% flag (<= 5th percentile)
                if (['BW', 'CED'].includes(t.label) && mid <= 5) {
                  // Remove any duplicate flag and add specific one
                  const idx = flags.findIndex(f => f.includes(t.label));
                  if (idx !== -1) flags.splice(idx, 1);
                  flags.push(`⚠️ ${t.label}: expected calf avg ~${mid}th percentile — extremely low; calves may be narrow or weak at birth`);
                }
              });

              bull.flags = flags;
            });

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
