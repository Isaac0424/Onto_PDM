// Minimal AI endpoint for explode-studio: POST {prompt, tier} → {text}
// The browser never sees your API key. Run:  ANTHROPIC_API_KEY=sk-... node server/claude-endpoint.mjs
// Requires: npm i @anthropic-ai/sdk   (Node 18+)
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();               // reads ANTHROPIC_API_KEY
const MODEL = { quick: process.env.MODEL_QUICK || 'claude-haiku-5-5', default: process.env.MODEL_DEFAULT || 'claude-sonnet-5-5', complex: process.env.MODEL_COMPLEX || 'claude-opus-5-5' };
const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';   // set to your site's origin in production

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST' || !req.url.startsWith('/api/explode-ai')) { res.writeHead(404).end(); return; }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw new Error('too large'); }
    const { prompt, tier = 'default' } = JSON.parse(body);
    const msg = await client.messages.create({
      model: MODEL[tier] || MODEL.default,
      max_tokens: tier === 'quick' ? 1200 : 16000,
      messages: [{ role: 'user', content: prompt + '\n\nReply with only the JSON value, no other text.' }],
    });
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }));
  } catch (e) {
    const status = e.status === 429 ? 429 : 502;
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => console.log(`explode-studio AI endpoint on http://localhost:${PORT}/api/explode-ai`));
