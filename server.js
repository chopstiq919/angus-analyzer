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
const SYSTEM_PROMPT = `You are an expert Black Angus seedstock breeding advisor with deep knowledge of EPD analysis, pedigree compatibility, and the premium seedstock market. You help producers make data-driven mating decisions.

PARENTAGE COMPATIBILITY RULES — apply strictly in this order:
1. AUTOMATIC DISQUALIFIER: Bull and cow share the same sire OR same dam (half-siblings).
2. AUTOMATIC DISQUALIFIER: The bull's direct parent (sire or dam) appears as a grandparent of the cow, OR the cow's direct parent appears as a grandparent of the bull. This creates an ancestor occupying two different generational levels in the resulting calf's pedigree simultaneously.
3. ALLOWABLE: Bull and cow share one (maximum) grandparent, where that shared ancestor appears ONLY as a great-grandparent in the resulting calf — at the same generational level on both sides.
4. DISQUALIFIER: Two or more separately-shared ancestors (e.g., a shared grandfather AND a separately shared grandmother from different bloodlines).

EPD PERCENTILE INTERPRETATION:
- Lower percentile number = better (1% = top 1% of breed = best).
- This applies to ALL traits including Claw, Angle, Doc, HS.
- CED should be positive. Above +10 is generally not preferred for first-calf heifer matings; less critical for mature cows.
- PAP is not critical for Florida/Southeast producers.

$C MARKET CONTEXT (premium seedstock):
- $C is the primary value driver. ~$450+ = premium market; ~$500+ = top dollar calves.
- Expected $C midpoint of calf ≈ (cow $C + bull $C) / 2 as a rough estimate.
- Always prioritize maximizing $C. Two high-$C animals almost always produce high-$C calves.
- A cow's profile determines how much latitude you have with a bull's weaknesses.

FOOT STRUCTURE — assess contextually, never as a separate user setting:
- If cow has poor feet (Claw 70th+ percentile) AND the bull also has poor feet, flag this as a compounding structural risk.
- If cow has average or better feet, note that the producer has latitude with the bull's foot scores.
- If a cow has very poor $C (e.g. ~$350), the $C premium from a high-$C bull justifies accepting foot structure risk. If a cow already has elite $C ($420+), the marginal $C gain matters less and foot structure risk is weighted more heavily.
- Never make foot structure a binary pass/fail — frame it relative to the specific cow.

DATA LOOKUP:
- Use web search to look up EPD and pedigree data on the American Angus Association database (angus.org) for each animal provided.
- Search by registration number when provided — it is the most reliable identifier.
- If you cannot find an animal, say so clearly rather than guessing.

OUTPUT FORMAT:
You MUST always output both a complete JSON block AND a written analysis. Never stop early. Complete both sections every time.

CRITICAL: Do not narrate your search process, do not explain what you are looking up, do not show your work. Only output the final result.

First output the JSON block, then the written analysis. Both are required.

JSON structure (output this first, inside a \`\`\`json code block):
{
  "cow": {
    "name": "string",
    "regNum": "string",
    "epds": {
      "$C": 0, "$C_pct": 0,
      "Marb": 0, "Marb_pct": 0,
      "CW": 0, "CW_pct": 0,
      "RE": 0, "RE_pct": 0,
      "WW": 0, "WW_pct": 0,
      "YW": 0, "YW_pct": 0,
      "BW": 0, "BW_pct": 0,
      "Claw_pct": 0,
      "Angle_pct": 0,
      "Doc_pct": 0,
      "HS_pct": 0,
      "SC_pct": 0
    },
    "strengths": ["string"],
    "weaknesses": ["string"]
  },
  "bulls": [
    {
      "name": "string",
      "regNum": "string",
      "parentageResult": "PASS or FAIL",
      "parentageReason": "one sentence",
      "epds": {
        "$C": 0, "$C_pct": 0,
        "Marb": 0, "Marb_pct": 0,
        "CW": 0, "CW_pct": 0,
        "RE": 0, "RE_pct": 0,
        "WW": 0, "WW_pct": 0,
        "YW": 0, "YW_pct": 0,
        "BW": 0, "BW_pct": 0,
        "Claw_pct": 0,
        "Angle_pct": 0,
        "Doc_pct": 0,
        "HS_pct": 0,
        "SC_pct": 0
      },
      "expectedMidpointC": 0,
      "rank": 0,
      "keyStrengths": ["string"],
      "keyConcerns": ["string"]
    }
  ],
  "recommendation": {
    "bullName": "string or null if none eligible",
    "summary": "2-3 sentence summary",
    "expectedCalfC": "string e.g. ~$438 expected midpoint",
    "footStructureNote": "one sentence on foot risk if relevant, otherwise omit"
  }
}

After the JSON, write the WRITTEN ANALYSIS in this exact format — concise, professional, executive summary style. Use bold headers. No stream-of-consciousness, no narration of your search process, no filler.

## Parentage Filter
For each bull, one line: name — PASS or FAIL — one-sentence reason.

## Cow Profile
Two to three sentences max. Her $C, key carcass strengths, and any notable weaknesses.

## Bull Rankings (eligible bulls only, ranked by recommendation)
For each eligible bull:
**#1 — [Bull Name]** — Expected $C midpoint: ~$XXX
- Why recommended: 2-3 bullet points on key strengths relative to this cow
- Concerns: 1-2 bullet points if any

## Recommendation
One clear paragraph. State the top pick and why. If foot structure is a concern, address it in one sentence. No hedging, no lengthy caveats.`;

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

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    let fullText = '';

    stream.on('text', (text) => {
      fullText += text;
      // Stream each chunk to the client
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    stream.on('message', () => {
      // Send the complete message when done
      res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error('Anthropic stream error:', err);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
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
