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

function twilioWhatsappAddress(phone) {
  const digits = String(phone).replace(/^whatsapp:/i, '').replace(/\D/g, '');
  if (digits.length < 10) {
    throw new Error('Phone number needs a country code, for example whatsapp:+919876543210');
  }
  return `whatsapp:+${digits}`;
}

async function deliverTelegram(messageText, preferredChatId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const fallbackChatId = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  const chatIds = [...new Set([preferredChatId, fallbackChatId].filter(Boolean).map(String))];
  if (!botToken || chatIds.length === 0) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set');
  }
  let lastError = 'Telegram API error';
  for (const targetChatId of chatIds) {
    for (const parseMode of ['Markdown', null]) {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          text: messageText,
          ...(parseMode ? { parse_mode: parseMode } : {})
        })
      });
      const result = await response.json();
      if (result.ok) {
        return { message_id: result.result.message_id, chat_id: targetChatId };
      }
      lastError = result.description || lastError;
      const retryPlain = parseMode && /parse|markdown|entity/i.test(lastError);
      const retryOtherChat = /chat not found|bot was blocked|user is deactivated|PEER_ID_INVALID/i.test(lastError);
      if (retryPlain) continue;
      if (retryOtherChat) break;
      throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}

function householdGroupId() {
  if (process.env.TELEGRAM_GROUP_CHAT_ID) return String(process.env.TELEGRAM_GROUP_CHAT_ID);
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId && String(chatId).startsWith('-')) return String(chatId);
  return null;
}

function conductorReplyText(payload) {
  const output = payload?.output ?? payload?.result?.output;
  if (typeof output === 'string' && output.trim()) return output.trim();
  if (output && typeof output === 'object') {
    const text = output.answer || output.text || output.message || output.response;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
  return '';
}

async function askConductor(text, fromName) {
  const apiKey = process.env.AGENTICORG_API_KEY;
  const agentId = process.env.AGENTICORG_AGENT_ID;
  if (!apiKey || !agentId) return null;
  const base = (process.env.AGENTICORG_BASE_URL || 'https://app.agenticorg.ai').replace(/\/$/, '');
  const inputs = { query: text, source: 'telegram_group', from: fromName };
  const isUuid = agentId.includes('-') && agentId.length > 30;
  const url = isUuid ? `${base}/api/v1/agents/${agentId}/run` : `${base}/api/v1/a2a/tasks`;
  const body = isUuid
    ? { action: 'process', inputs, context: {} }
    : { agent_type: agentId, action: 'process', inputs, context: {} };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.error || `Agent request failed with ${response.status}`);
  }
  return conductorReplyText(payload) || 'The kitchen agent returned an empty answer.';
}

function isHouseholdChat(chat) {
  if (!chat) return false;
  const groupId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (groupId) {
    if (String(chat.id) === String(groupId)) return true;
    const privateId = process.env.TELEGRAM_CHAT_ID;
    return Boolean(privateId) && chat.type === 'private' && String(chat.id) === String(privateId);
  }
  return chat.type === 'private' || chat.type === 'group' || chat.type === 'supergroup';
}

async function loadHouseholdContext() {
  const taste = await pool.query(
    `SELECT category, preference FROM taste_profiles ORDER BY category ASC`
  );
  const stock = await pool.query(
    `SELECT canonical_id, name, location, form, quantity, unit, usable_today
     FROM household_inventory
     ORDER BY location, name ASC`
  );
  return { taste: taste.rows, stock: stock.rows };
}

function isBusyModelError(err) {
  return /503|429|UNAVAILABLE|high demand|resource exhausted/i.test(String(err?.message || err));
}

async function suggestFromHousehold(text, fromName) {
  if (!process.env.GEMINI_API_KEY) return null;
  const { taste, stock } = await loadHouseholdContext();
  const contents = [
    'You are the RasoiOS kitchen conductor answering a household Telegram message.',
    'Use only the stock and taste rows below. Do not invent a quantity.',
    'Suggest two or three dishes that can be made now. The main ingredient must be present.',
    'Do not suggest a paneer dish if paneer quantity is 0. Prefer usable_today leftovers and chutneys.',
    'About 80% of the other ingredients must be present. Name any missing garnish in one line.',
    'Taste rules: toast bread firm, no raw onion, medium spice, light oil, fry paneer before gravy.',
    'Reply in plain text, under 900 characters, ready to send on Telegram.',
    `From: ${fromName || 'household'}`,
    `Message: ${text}`,
    `Taste: ${JSON.stringify(taste)}`,
    `Stock: ${JSON.stringify(stock)}`
  ].join('\n');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents
      });
      const answer = typeof response.text === 'string' ? response.text.trim() : '';
      if (answer) return answer;
    } catch (err) {
      lastError = err;
      if (!isBusyModelError(err) || attempt === 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function handleTelegramUpdate(update) {
  const message = update?.message;
  if (!message?.text || message.from?.is_bot) return;
  const chat = message.chat;
  if (!isHouseholdChat(chat)) {
    console.log(`[TELEGRAM] Ignored chat ${chat?.id} type=${chat?.type}`);
    return;
  }
  const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
  console.log(`[TELEGRAM IN] chat=${chat.id} from=${fromName} text=${message.text}`);
  const text = message.text.trim();
  let reply;
  try {
    if (/^\/start\b/i.test(text)) {
      reply = 'RasoiOS is here. Ask "what should we cook?"';
    } else {
      reply = await askConductor(text, fromName);
      if (!reply) reply = await suggestFromHousehold(text, fromName);
    }
  } catch (err) {
    console.error('[TELEGRAM] reply failed:', err);
    reply = isBusyModelError(err)
      ? 'The kitchen model is busy right now. Ask "what should we cook?" again in a minute.'
      : `I got the message, and the kitchen reply failed: ${err.message}`;
  }
  if (!reply) {
    reply = `Got it. Chat id ${chat.id}. Set TELEGRAM_GROUP_CHAT_ID to this id if this is the household group.`;
  }
  const receipt = await deliverTelegram(reply, String(chat.id));
  console.log(`[TELEGRAM OUT] chat=${receipt.chat_id} message_id=${receipt.message_id}`);
}

async function registerTelegramWebhook() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  const webhookUrl = `${publicBaseUrl()}/telegram/webhook`;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message'],
      ...(secret ? { secret_token: secret } : {})
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!payload.ok) {
    console.error('[TELEGRAM] setWebhook failed:', payload.description || response.status);
    return;
  }
  console.log(`[TELEGRAM] Webhook set to ${webhookUrl}`);
}

async function sendTwilioWhatsapp({ recipient_phone, message_body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!accountSid || !authToken || !from) {
    throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_FROM are not set');
  }
  const to = twilioWhatsappAddress(recipient_phone);
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
        To: to,
        Body: message_body
      })
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || `Twilio request failed with ${response.status}`);
  }
  return {
    status: payload.status || 'queued',
    provider: 'twilio_whatsapp',
    message_sid: payload.sid,
    recipient: to
  };
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
      location: z.union([z.string(), z.null()]).optional()
        .describe('fridge, freezer, pantry, masala_dabba, or counter. Null, blank, or "all" returns the full household.'),
      form: z.union([z.string(), z.null()]).optional()
        .describe('raw, packet, dabba, chutney, leftover, batter, opened, or hardware. Null, blank, or "all" returns every form.')
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

  server.tool(
    'dispatch_whatsapp_message',
    'Dispatches a formatted recipe, prep task, or authorization request to WhatsApp',
    {
      recipient_phone: z.string().describe('Target phone number with country code, e.g. whatsapp:+91XXXXXXXXXX'),
      message_body: z.string().describe('Bulleted WhatsApp formatted message content'),
      message_type: z.enum(['cook_task', 'budget_approval', 'family_menu']).default('cook_task')
    },
    async ({ recipient_phone, message_body, message_type }) => {
      console.log(`[WHATSAPP DISPATCH] To: ${recipient_phone} | Type: ${message_type}`);
      try {
        const receipt = await sendTwilioWhatsapp({ recipient_phone, message_body });
        console.log(`[WHATSAPP SENT] sid=${receipt.message_sid} to=${receipt.recipient} status=${receipt.status}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...receipt,
              message_type,
              timestamp: new Date().toISOString()
            }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TOOL ERROR] dispatch_whatsapp_message failed:', err);
        return {
          content: [{ type: 'text', text: `WhatsApp dispatch failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'send_telegram_notification',
    'Sends real-time prep instructions, missing grocery alerts, or approval cards to the household Telegram group',
    {
      message_text: z.string().describe('Custom message content to send (supports Markdown)'),
      chat_id: z.string().optional().describe('Telegram group chat id. Defaults to the household group.')
    },
    async ({ message_text, chat_id }) => {
      console.log(`[TELEGRAM DISPATCH] Sending to chat_id: ${chat_id || process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID}`);
      try {
        const receipt = await deliverTelegram(message_text, chat_id);
        console.log(`[TELEGRAM SUCCESS] Message sent. ID: ${receipt.message_id}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'DELIVERED',
              provider: 'telegram',
              message_id: receipt.message_id,
              chat_id: receipt.chat_id,
              timestamp: new Date().toISOString()
            }, null, 2)
          }]
        };
      } catch (err) {
        console.error('[TELEGRAM ERROR]', err);
        return {
          content: [{ type: 'text', text: `Telegram delivery failed: ${err.message}` }],
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

app.get('/telegram/status', async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(503).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' });
  try {
    const [me, hook] = await Promise.all([
      fetch(`https://api.telegram.org/bot${botToken}/getMe`).then((r) => r.json()),
      fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`).then((r) => r.json())
    ]);
    const info = hook.result || {};
    res.json({
      ok: Boolean(me.ok && hook.ok),
      username: me.result?.username || null,
      webhook_url: info.url || null,
      pending_update_count: info.pending_update_count ?? null,
      last_error_message: info.last_error_message || null
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/telegram/webhook', express.json({ limit: '1mb' }), (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  handleTelegramUpdate(req.body).catch((err) => {
    console.error('[TELEGRAM] update failed:', err);
  });
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
  registerTelegramWebhook().catch((err) => {
    console.error('[TELEGRAM] webhook registration failed:', err);
  });
});
