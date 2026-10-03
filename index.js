import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import pg from 'pg';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import 'dotenv/config';

const app = express();
app.use(cors());

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

console.log('[ENV CHECK] DATABASE_URL set:', Boolean(process.env.DATABASE_URL));
console.log('[ENV CHECK] GEMINI_API_KEY set:', Boolean(process.env.GEMINI_API_KEY));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://rasoios.onrender.com').replace(/\/$/, '');
}

async function ensureVoiceClips() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_clips (
      id UUID PRIMARY KEY,
      content_type TEXT NOT NULL,
      audio BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function gnaniVoice(language, speakerGender) {
  if (speakerGender === 'male') return 'Deepak';
  if (language === 'en-IN') return 'Kaveri';
  return 'Nalini';
}

function whatsappRecipient(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) {
    throw new Error('Phone number needs a country code, for example +919876543210');
  }
  return digits;
}

function createMcpServer() {
  const server = new McpServer({
    name: 'rasoios-pantry-mcp',
    version: '1.0.0'
  });

  // Tool 1: Core Taste Profile
  server.tool(
    'get_core_taste_profile',
    'Retrieve universal household dietary rules, texture baselines, and hard dislikes (non-negotiables)',
    {},
    async () => {
      console.log('[TOOL CALL] get_core_taste_profile triggered');
      try {
        const { rows } = await pool.query(
          `SELECT category, preference FROM taste_profiles ORDER BY category ASC;`
        );
        console.log(`[TOOL SUCCESS] get_core_taste_profile fetched ${rows.length} rows`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ core_preferences: rows }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] get_core_taste_profile failed:', err);
        return {
          content: [{ type: 'text', text: `Failed to fetch core profile: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool 2: Qualitative Taste & Quirks (Semantic Vector Search)
  server.tool(
    'get_taste_profile_context',
    'Retrieve specific situational cooking quirks or dish-specific techniques via semantic search',
    { dish_query: z.string().describe('Meal or dish name, e.g., "cheese sandwich" or "matar paneer"') },
    async ({ dish_query }) => {
      console.log(`[TOOL CALL] get_taste_profile_context triggered with query: "${dish_query}"`);
      try {
        const response = await ai.models.embedContent({
          model: 'gemini-embedding-001',
          contents: dish_query,
          config: { outputDimensionality: 768 }
        });

        const values = response.embeddings?.[0]?.values || response.embedding?.values;
        const queryVector = JSON.stringify(values);

        const { rows } = await pool.query(
          `SELECT category, preference, 1 - (embedding <=> $1::vector) AS similarity
           FROM taste_profiles
           ORDER BY similarity DESC
           LIMIT 3;`,
          [queryVector]
        );

        console.log(`[TOOL SUCCESS] get_taste_profile_context matched ${rows.length} rows`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              dish_query,
              matched_preferences: rows.map(r => ({
                category: r.category,
                preference: r.preference,
                score: Number(r.similarity).toFixed(3)
              }))
            }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] get_taste_profile_context failed:', err);
        return {
          content: [{ type: 'text', text: `Vector search failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool 3: Quantitative Inventory Check (Flexible SKU / Ingredient match)
  server.tool(
    'check_pantry_inventory',
    'Check deterministic stock levels for specified SKUs or ingredients',
    { required_skus: z.array(z.string()).describe('List of SKUs or ingredients, e.g. ["paneer", "bread"]') },
    async ({ required_skus }) => {
      console.log(`[TOOL CALL] check_pantry_inventory triggered for:`, required_skus);
      try {
        // Fetch full pantry to allow substring/case-insensitive matching
        const { rows } = await pool.query(`SELECT sku, quantity, unit FROM pantry_inventory;`);

        const inStock = [];
        const outOfStock = [];

        for (const req of required_skus) {
          const reqClean = req.toLowerCase();
          const match = rows.find(item =>
            item.sku.toLowerCase().includes(reqClean) || reqClean.includes(item.sku.toLowerCase())
          );

          if (match && Number(match.quantity) > 0) {
            inStock.push(match);
          } else {
            outOfStock.push({
              requested: req,
              matched_sku: match ? match.sku : null,
              quantity: match ? match.quantity : 0,
              status: 'unavailable'
            });
          }
        }

        console.log(`[TOOL SUCCESS] check_pantry_inventory in_stock: ${inStock.length}, out_of_stock: ${outOfStock.length}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ in_stock: inStock, out_of_stock: outOfStock }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] check_pantry_inventory failed:', err);
        return {
          content: [{ type: 'text', text: `Inventory check failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // Tool 4: Household stock book
  server.tool(
    'fridge_snapshot',
    'Return the household stock book, optionally filtered by storage location or item form',
    {
      location: z.string().optional()
        .describe('fridge, freezer, pantry, masala_dabba, or counter. Omit, blank, or "all" for the full household.'),
      form: z.string().optional()
        .describe('raw, packet, dabba, chutney, leftover, batter, opened, or hardware. Omit, blank, or "all" for every form.')
    },
    async ({ location, form }) => {
      const locations = new Set(['fridge', 'freezer', 'pantry', 'masala_dabba', 'counter']);
      const forms = new Set(['raw', 'packet', 'dabba', 'chutney', 'leftover', 'batter', 'opened', 'hardware']);
      const clean = (value, allowed) => {
        if (value == null) return undefined;
        const normalized = String(value).trim().toLowerCase();
        if (!allowed.has(normalized)) return undefined;
        return normalized;
      };
      console.log(`[TOOL CALL] fridge_snapshot location=${location || 'all'} form=${form || 'all'}`);
      try {
        location = clean(location, locations);
        form = clean(form, forms);
        let query = `
          SELECT canonical_id, name, location, form, quantity, unit, usable_today
          FROM household_inventory
          WHERE 1=1`;
        const params = [];
        if (location) {
          params.push(location);
          query += ` AND location = $${params.length}`;
        }
        if (form) {
          params.push(form);
          query += ` AND form = $${params.length}`;
        }
        query += ` ORDER BY location, name ASC`;
        const { rows } = await pool.query(query, params);
        console.log(`[TOOL SUCCESS] fridge_snapshot returned ${rows.length} rows`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: rows.length, items: rows }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] fridge_snapshot failed:', err);
        return {
          content: [{ type: 'text', text: `Fridge snapshot failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'gnani_speech_to_text',
    'Transcribe a cook or planner voice note with Gnani Prisma. Accepts an audio URL or base64 audio up to 60 seconds.',
    {
      audio_url: z.string().optional().describe('Public URL of a wav, mp3, ogg, flac, aac, or m4a clip'),
      audio_base64: z.string().optional().describe('Base64-encoded audio bytes'),
      language_code: z.enum(['hi-IN', 'en-IN', 'mr-IN', 'hi-en']).default('hi-IN')
    },
    async ({ audio_url, audio_base64, language_code }) => {
      console.log(`[TOOL CALL] gnani_speech_to_text language=${language_code}`);
      try {
        if (!process.env.GNANI_STT_API_KEY) {
          throw new Error('GNANI_STT_API_KEY is not set');
        }
        if (!audio_url && !audio_base64) {
          throw new Error('Provide audio_url or audio_base64');
        }

        let bytes;
        let filename = 'note.wav';
        if (audio_url) {
          const audioRes = await fetch(audio_url);
          if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
          bytes = Buffer.from(await audioRes.arrayBuffer());
          const pathName = new URL(audio_url).pathname;
          filename = pathName.split('/').pop() || filename;
        } else {
          bytes = Buffer.from(audio_base64, 'base64');
        }

        const form = new FormData();
        form.append('audio_file', new Blob([bytes]), filename);
        form.append('language_code', language_code);
        form.append('format', 'transcribe');

        const response = await fetch('https://api.vachana.ai/stt/v3', {
          method: 'POST',
          headers: { 'X-API-Key-ID': process.env.GNANI_STT_API_KEY },
          body: form
        });
        const bodyText = await response.text();
        if (!response.ok) {
          throw new Error(`Gnani STT ${response.status}: ${bodyText.slice(0, 300)}`);
        }
        const parsed = JSON.parse(bodyText);
        console.log(`[TOOL SUCCESS] gnani_speech_to_text request_id=${parsed.request_id || 'none'}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              transcript: parsed.transcript,
              request_id: parsed.request_id,
              language_code
            }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] gnani_speech_to_text failed:', err);
        return {
          content: [{ type: 'text', text: `Speech to text failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'gnani_text_to_speech',
    'Synthesize a cook voice note with Gnani Timbre and return a playable audio URL',
    {
      text: z.string().describe('Instructions to speak'),
      target_language: z.enum(['hi-IN', 'en-IN', 'mr-IN', 'hi-en']).default('hi-IN'),
      speaker_gender: z.enum(['female', 'male']).default('female')
    },
    async ({ text, target_language, speaker_gender }) => {
      console.log(`[TOOL CALL] gnani_text_to_speech language=${target_language}`);
      try {
        if (!process.env.GNANI_TTS_API_KEY) {
          throw new Error('GNANI_TTS_API_KEY is not set');
        }
        const voice = gnaniVoice(target_language, speaker_gender);
        const response = await fetch('https://api.vachana.ai/api/v1/tts/inference', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key-ID': process.env.GNANI_TTS_API_KEY
          },
          body: JSON.stringify({
            text,
            voice,
            model: 'timbre-v2.5',
            language: target_language,
            speed: 1,
            audio_config: {
              sample_rate: 48000,
              num_channels: 1,
              sample_width: 2,
              encoding: 'linear_pcm',
              container: 'wav'
            }
          })
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gnani TTS ${response.status}: ${errText.slice(0, 300)}`);
        }
        const audio = Buffer.from(await response.arrayBuffer());
        const id = randomUUID();
        await ensureVoiceClips();
        await pool.query(
          `INSERT INTO voice_clips (id, content_type, audio) VALUES ($1, 'audio/wav', $2)`,
          [id, audio]
        );
        const path = `/audio/${id}.wav`;
        const base = publicBaseUrl();
        console.log(`[TOOL SUCCESS] gnani_text_to_speech bytes=${audio.length} voice=${voice}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              audio_url: base ? `${base}${path}` : path,
              voice,
              language: target_language,
              bytes: audio.length
            }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] gnani_text_to_speech failed:', err);
        return {
          content: [{ type: 'text', text: `Text to speech failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'whatsapp_send_message',
    'Sends a recipe, prep task, or approval request as a WhatsApp text message',
    {
      recipient_phone: z.string().describe('Target phone number with country code, e.g. +919876543210'),
      message_body: z.string().describe('Bulleted WhatsApp formatted message content'),
      message_type: z.enum(['cook_task', 'budget_approval', 'family_menu']).default('cook_task')
    },
    async ({ recipient_phone, message_body, message_type }) => {
      console.log(`[WHATSAPP DISPATCH] To: ${recipient_phone} | Type: ${message_type}`);
      try {
        const token = process.env.WHATSAPP_ACCESS_TOKEN;
        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        if (!token || !phoneNumberId) {
          throw new Error('WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not set');
        }
        const to = whatsappRecipient(recipient_phone);
        const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { preview_url: false, body: message_body }
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = payload?.error?.message || `WhatsApp request failed with ${response.status}`;
          throw new Error(message);
        }
        const messageId = payload?.messages?.[0]?.id || null;
        console.log(`[WHATSAPP SENT] id=${messageId} to=${to}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'SENT',
              message_id: messageId,
              recipient: to,
              message_type,
              timestamp: new Date().toISOString()
            }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] whatsapp_send_message failed:', err);
        return {
          content: [{ type: 'text', text: `WhatsApp send failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  return server;
}

const transports = new Map();

app.get('/audio/:id', async (req, res) => {
  const id = req.params.id.replace(/\.(mp3|wav)$/, '');
  try {
    await ensureVoiceClips();
    const { rows } = await pool.query(
      `SELECT content_type, audio FROM voice_clips WHERE id = $1`,
      [id]
    );
    const clip = rows[0];
    if (!clip) return res.status(404).send('Audio not found');
    const body = clip.audio || clip.buffer;
    res.setHeader('Content-Type', clip.content_type || clip.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(body);
  } catch (err) {
    console.error('[AUDIO] lookup failed:', err);
    res.status(500).send('Audio lookup failed');
  }
});

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServer();

  console.log(`[SSE] Session created: ${transport.sessionId}`);
  transports.set(transport.sessionId, transport);

  transport.onclose = () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  };

  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`[MESSAGES] Incoming POST for sessionId: ${sessionId}`);
  const transport = transports.get(sessionId);

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    console.warn(`[MESSAGES] No active session found for: ${sessionId}`);
    res.status(400).send('No active SSE connection for session');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ MCP SSE Server listening on port ${PORT}`);
});
