const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting — max 20 analyses per IP per hour
// Adjust these numbers as your user base grows
const analysisLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many analyses requested from this IP. Please wait an hour and try again.'
  }
});

// ─────────────────────────────────────────────
// ANTHROPIC CLIENT
// ─────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─────────────────────────────────────────────
// SYSTEM PROMPT — The full framework
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert Black Angus seedstock breeding advisor. Help producers make data-driven mating decisions using EPD analysis and pedigree compatibility rules.

PARENTAGE RULES (apply in order):
1. DISQUALIFIER: Bull and cow share the same sire or dam.
2. DISQUALIFIER: Bull's direct parent appears as a grandparent of the cow, or vice versa — same ancestor at two generational levels in the calf.
3. ALLOWABLE: One shared grandparent maximum, appearing only as a great-grandparent on both sides of the calf.
4. DISQUALIFIER: Two or more separately-shared ancestors.

EPD PERCENTILES: Lower = better. 1% = top of breed. Applies to all traits including Claw, Angle, Doc, HS.
CED: Positive preferred; above +10 not ideal for heifers. PAP: Not critical for Southeast producers.

$C PRIORITIES: $C is the primary value driver. $450+ = premium; $500+ = top dollar. Expected calf $C ≈ (cow $C + bull $C) / 2. A cow's weaknesses determine latitude with the bull's weaknesses.

FOOT STRUCTURE: If both cow and bull have poor Claw (70th+ percentile), flag as compounding risk weighed against $C gain. If cow has good feet, note latitude available.

DATA: Search angus.org by registration number. If an animal cannot be found, say so clearly.

OUTPUT: JSON block first (in a \`\`\`json code block), then ## Recommendation section only.

JSON:
{"cow":{"name":"","regNum":"","epds":{"$C":0,"$C_pct":0,"Marb":0,"Marb_pct":0,"CW":0,"CW_pct":0,"RE":0,"RE_pct":0,"WW":0,"WW_pct":0,"YW":0,"YW_pct":0,"BW":0,"BW_pct":0,"Claw_pct":0,"Angle_pct":0,"Doc_pct":0,"HS_pct":0,"SC_pct":0},"strengths":[],"weaknesses":[]},"bulls":[{"name":"","regNum":"","parentageResult":"PASS or FAIL","parentageReason":"one sentence","epds":{"$C":0,"$C_pct":0,"Marb":0,"Marb_pct":0,"CW":0,"CW_pct":0,"RE":0,"RE_pct":0,"WW":0,"WW_pct":0,"YW":0,"YW_pct":0,"BW":0,"BW_pct":0,"Claw_pct":0,"Angle_pct":0,"Doc_pct":0,"HS_pct":0,"SC_pct":0},"expectedMidpointC":0,"rank":0,"keyStrengths":[],"keyConcerns":[]}],"recommendation":{"bullName":"","summary":"","expectedCalfC":"","footStructureNote":""}}

## Recommendation
3-5 sentences. Top pick and why. Rank multiple eligible bulls briefly. One sentence on foot risk only if relevant. No narration, no restating EPD data, no preamble.`;

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main analysis endpoint
app.post('/api/analyze', analysisLimiter, async (req, res) => {
  const { cow, cowNotes, bulls, outputMode, priorityValues } = req.body;

  // Basic validation
  if (!cow || !bulls || !Array.isArray(bulls) || bulls.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: cow and bulls array.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const filledBulls = bulls.filter(b => b && b.trim());
  if (filledBulls.length === 0) {
    return res.status(400).json({ error: 'Please enter at least one bull.' });
  }

  const priorities = (priorityValues && priorityValues.length > 0)
    ? priorityValues.join(', ')
    : '$C';

  const userPrompt = `Analyze this breeding scenario.

COW: ${cow}
${cowNotes ? `Producer notes about this cow: ${cowNotes}` : ''}

CANDIDATE BULLS:
${filledBulls.map((b, i) => `Bull ${i + 1}: ${b}`).join('\n')}

PRODUCER'S PRIORITY $VALUES: ${priorities}
Weight these indexes most heavily in your EPD comparison and final recommendation.

Steps:
1. Search angus.org to look up the current EPD and pedigree data for each animal using their registration number or name.
2. Apply all parentage compatibility rules to each bull.
3. For eligible bulls, compare EPDs with emphasis on the producer's priority $Values, then carcass traits and growth.
4. Assess foot structure contextually relative to this cow's specific Claw and Angle percentiles.
5. Give a clear, actionable recommendation.

Output format: JSON block first (in a \`\`\`json code block), then written analysis.`;

  // Set up SSE streaming so the UI can show progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const runStream = async (attempt = 1) => {
    try {
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      });

      let fullText = '';

      stream.on('text', (text) => {
        fullText += text;
        res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
      });

      stream.on('message', () => {
        res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
        res.end();
      });

      stream.on('error', async (err) => {
        // Retry once on rate limit after 15 seconds
        if (err.status === 429 && attempt < 2) {
          console.log('Rate limit hit, retrying in 15 seconds...');
          res.write(`data: ${JSON.stringify({ type: 'text', text: '\n\n[Rate limit reached — retrying in 15 seconds...]\n\n' })}\n\n`);
          await new Promise(r => setTimeout(r, 15000));
          return runStream(attempt + 1);
        }
        console.error('Anthropic stream error:', err);
        const msg = err.status === 429
          ? 'Rate limit reached. Please wait 60 seconds and try again.'
          : err.message;
        res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
        res.end();
      });

    } catch (err) {
      console.error('Analysis error:', err);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  };

  runStream();
});

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Angus Breeding Analyzer running on port ${PORT}`);
  console.log(`API key configured: ${process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO — set ANTHROPIC_API_KEY'}`);
});
