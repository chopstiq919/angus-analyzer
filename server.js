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

    // ── Step 4: Find and click the EPD detail link ──
    const detailLink = await page.$('a[href*="EpdPedDtl"]');

    if (!detailLink) {
      const bodyPreview = await page.evaluate(() => document.body.innerText.slice(0, 500));
      throw new Error(`No EPD detail link found. Page content: ${bodyPreview}`);
    }

    const detailHref = await page.evaluate(el => el.href, detailLink);
    console.log(`Navigating to EPD detail: ${detailHref}`);

    await page.goto(detailHref, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // ── Step 5: Wait for EPD data to render ──
    await page.waitForFunction(
      () => document.body.innerText.includes('$C') && document.body.innerText.includes('Marb'),
      { timeout: 30000 }
    );

    // ── Step 6: Extract clean text ──
    const pageData = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      // Remove noise elements
      clone.querySelectorAll(
        'script, style, nav, header, footer, .header, .footer, .nav, .menu, ' +
        '[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], ' +
        '[class*="cky"], [id*="cky"], iframe'
      ).forEach(el => el.remove());
      return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
    });

    console.log(`Successfully fetched data for ${regNum}, length: ${pageData.length}`);
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
const SYSTEM_PROMPT = `You are an expert Black Angus seedstock breeding advisor. Analyze mating decisions using the EPD and pedigree data provided to you.

PARENTAGE RULES (apply in order):
1. DISQUALIFIER: Bull and cow share the same sire or dam.
2. DISQUALIFIER: Bull's direct parent appears as a grandparent of the cow, or vice versa — same ancestor at two generational levels in the calf's pedigree.
3. ALLOWABLE: One shared grandparent maximum, appearing only as a great-grandparent on both sides of the calf.
4. DISQUALIFIER: Two or more separately-shared ancestors.

EPD PERCENTILES: Lower = better. 1% = top of breed. Applies to ALL traits including Claw, Angle, Doc, HS.
CED: Positive preferred; above +10 not ideal for heifer matings. PAP: Not critical for Southeast producers.

$C MARKET: $450+ = premium; $500+ = top dollar. Expected calf $C = (cow $C + bull $C) / 2.
Prioritize maximizing $C. The cow's weaknesses determine latitude with the bull's weaknesses.

FOOT STRUCTURE: If both cow AND bull have poor Claw (70th+ percentile), flag compounding risk weighed against $C gain. If cow has decent feet, note the latitude.

OUTPUT: JSON block first (in a \`\`\`json code block), then ## Recommendation only. No narration, no restating EPD data already in the table.

JSON:
{"cow":{"name":"","regNum":"","epds":{"$C":0,"$C_pct":0,"Marb":0,"Marb_pct":0,"CW":0,"CW_pct":0,"RE":0,"RE_pct":0,"WW":0,"WW_pct":0,"YW":0,"YW_pct":0,"BW":0,"BW_pct":0,"Claw_pct":0,"Angle_pct":0,"Doc_pct":0,"HS_pct":0,"SC_pct":0},"strengths":[],"weaknesses":[]},"bulls":[{"name":"","regNum":"","parentageResult":"PASS or FAIL","parentageReason":"one sentence","epds":{"$C":0,"$C_pct":0,"Marb":0,"Marb_pct":0,"CW":0,"CW_pct":0,"RE":0,"RE_pct":0,"WW":0,"WW_pct":0,"YW":0,"YW_pct":0,"BW":0,"BW_pct":0,"Claw_pct":0,"Angle_pct":0,"Doc_pct":0,"HS_pct":0,"SC_pct":0},"expectedMidpointC":0,"rank":0,"keyStrengths":[],"keyConcerns":[]}],"recommendation":{"bullName":"","summary":"","expectedCalfC":"","footStructureNote":""}}

## Recommendation
3-5 sentences. Top pick and why. Rank multiple eligible bulls briefly. One sentence on foot risk only if relevant.`;

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
          sendEvent('done', { fullText });
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
