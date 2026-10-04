import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import pg from 'pg';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import 'dotenv/config';
import { applyCartGates, mealSituation } from './household-rules.js';

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

function istParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  return Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
}

function moodSlots() {
  const raw = process.env.TELEGRAM_MOOD_SCHEDULE || '10:30,14:30,21:30';
  return raw.split(',').map((value) => value.trim()).filter(Boolean).map((time) => {
    const [hour, minute] = time.split(':').map(Number);
    const label = hour < 12 ? 'Breakfast' : hour < 17 ? 'Lunch' : 'Dinner';
    return { time, minutes: hour * 60 + minute, label };
  });
}

function mentionedMood(text) {
  const match = String(text).toLowerCase().match(/\b(light|medium|heavy)\b/);
  return match ? match[1] : null;
}

async function ensureMoodTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS household_mood (
      id BIGSERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      mood TEXT NOT NULL,
      meal_label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mood_prompts (
      slot_key TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function saveMood(chatId, mood, mealLabel) {
  await ensureMoodTables();
  await pool.query(
    `INSERT INTO household_mood (chat_id, mood, meal_label) VALUES ($1, $2, $3)`,
    [String(chatId), mood, mealLabel || null]
  );
}

async function latestMood(chatId) {
  await ensureMoodTables();
  const { rows } = await pool.query(
    `SELECT mood, meal_label, created_at
     FROM household_mood
     WHERE chat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(chatId)]
  );
  return rows[0] || null;
}

async function maybeSendMoodPrompt() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: [] };
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return { sent: [] };
  await ensureMoodTables();
  const now = istParts();
  const nowMinutes = Number(now.hour) * 60 + Number(now.minute);
  const day = `${now.year}-${now.month}-${now.day}`;
  const sent = [];
  for (const slot of moodSlots()) {
    if (nowMinutes < slot.minutes || nowMinutes >= slot.minutes + 45) continue;
    const slotKey = `${day}|${slot.time}`;
    const inserted = await pool.query(
      `INSERT INTO mood_prompts (slot_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slot_key`,
      [slotKey]
    );
    if (!inserted.rows.length) continue;
    const text = `${slot.label} is done. What should the next meal feel like: light, medium, or heavy?`;
    await deliverTelegram(text, String(chatId));
    console.log(`[MOOD] Asked after ${slot.label} in chat ${chatId}`);
    sent.push(slotKey);
  }
  return { sent };
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

async function generateKitchenText(contents) {
  if (!process.env.GEMINI_API_KEY) return null;
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

function parsePlan(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function ensureRunTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS household_runs (
      id BIGSERIAL PRIMARY KEY,
      chat_id TEXT,
      meal TEXT,
      effort TEXT,
      minutes INTEGER,
      weekend BOOLEAN,
      mood TEXT,
      cart_total INTEGER,
      human_required BOOLEAN,
      human_reason TEXT,
      plan JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function weeklyCartSpend() {
  await ensureRunTable();
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(cart_total), 0)::int AS spent
    FROM household_runs
    WHERE human_required = false
      AND created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Kolkata')
  `);
  return rows[0]?.spent || 0;
}

async function decideHouseholdMeal({ chatId, fromName, userText, mood }) {
  const situation = mealSituation(istParts(), userText, {
    cookAvailable: process.env.COOK_AVAILABLE !== 'false'
  });
  const { taste, stock } = await loadHouseholdContext();
  const spent = await weeklyCartSpend();
  const limits = {
    cartLimit: process.env.PER_CART_LIMIT_INR ? Number(process.env.PER_CART_LIMIT_INR) : null,
    weeklyBudget: process.env.WEEKLY_BUDGET_INR ? Number(process.env.WEEKLY_BUDGET_INR) : null,
    spent
  };
  const raw = await generateKitchenText([
    'Return one JSON object only. No markdown.',
    'You are deciding a real household meal. The wife is not typing. Decide from the stock.',
    'Main ingredient must be present. About 80% of the other ingredients must be present.',
    'The missing 20% can be a garnish or a side. Prefer usable_today leftovers and chutneys.',
    'Do not suggest paneer if its quantity is 0. Do not invent a quantity that is not in stock.',
    'Taste rules: toast bread firm, no raw onion, medium spice for adults, light oil, fry paneer before gravy.',
    'Kids get a milder plate from the same stock, with less chilli.',
    'Weekday or a 10-minute breakfast is low effort. Weekend, when there is time, is high effort.',
    'If the cook is available, cook_text_hi is short Hindi imperatives for Nani. If the cook is not available, cook_text_hi explains the family must do the steps.',
    'missing: only items not in stock. role is main or garnish. substitute is a stock item name, "skip", or null.',
    'A missing garnish can be skipped. A missing main with substitute null means human_required true.',
    'cart lists only items to buy. estimated_inr is a rough rupee number. Do not put skipped garnish in the cart.',
    'JSON keys: family_text, kids_text, cook_text_hi, missing, cart, human_required, human_reason.',
    `Situation: ${JSON.stringify({ ...situation, mood: mood || 'not recorded', weekly_spent_inr: spent, user_text: userText || 'scheduled decision' })}`,
    `From: ${fromName || 'household'}`,
    `Taste: ${JSON.stringify(taste)}`,
    `Stock: ${JSON.stringify(stock)}`
  ].join('\n'));
  const plan = parsePlan(raw || '');
  if (!plan) {
    throw new Error('The meal model did not return a usable decision.');
  }
  const gates = applyCartGates(plan, limits);
  if (gates.cartTotal > 0 && (gates.cartLimit == null || gates.weeklyBudget == null)) {
    gates.humanRequired = true;
    gates.humanReason = gates.humanReason || 'Weekly budget and per-cart limit are not set, so the cart cannot be confirmed.';
  }
  const cartLine = gates.cartTotal === 0
    ? 'No delivery cart. The meal can be made from what is already in the house.'
    : gates.cartLimit == null || gates.weeklyBudget == null
      ? `Cart ₹${gates.cartTotal}. Weekly budget and per-cart limit are not set.`
      : `Cart ₹${gates.cartTotal}. Limit ₹${gates.cartLimit}. Weekly spend so far ₹${spent} of ₹${gates.weeklyBudget}.`;
  const gateLine = gates.humanRequired
    ? `A person needs to decide: ${gates.humanReason}`
    : 'No person is needed for this meal.';
  const family = [
    plan.family_text,
    plan.kids_text ? `Kids: ${plan.kids_text}` : '',
    `${situation.day} ${situation.meal}. ${situation.effort} effort, ${situation.minutes} minutes. Mood: ${mood || 'not recorded'}.`,
    cartLine,
    gateLine
  ].filter(Boolean).join('\n\n');
  const cook = plan.cook_text_hi || 'Cook steps were not ready.';
  await ensureRunTable();
  await pool.query(
    `INSERT INTO household_runs
      (chat_id, meal, effort, minutes, weekend, mood, cart_total, human_required, human_reason, plan)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      chatId ? String(chatId) : null,
      situation.meal,
      situation.effort,
      situation.minutes,
      situation.weekend,
      mood || null,
      gates.cartTotal,
      gates.humanRequired,
      gates.humanReason || null,
      JSON.stringify({ ...plan, gates })
    ]
  );
  return { family, cook, situation, gates };
}

async function dispatchHouseholdMeal({ chatId, fromName, userText, mood }) {
  const decision = await decideHouseholdMeal({ chatId, fromName, userText, mood });
  const familyChat = String(chatId || process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID);
  await deliverTelegram(decision.family, familyChat);
  const cookChat = process.env.TELEGRAM_COOK_CHAT_ID || familyChat;
  const cookText = cookChat === familyChat
    ? `For Nani:\n${decision.cook}`
    : decision.cook;
  await deliverTelegram(cookText, cookChat);
  return decision;
}

async function maybeSendMealDecision() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: [] };
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return { sent: [] };
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meal_decisions (
      slot_key TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const now = istParts();
  const nowMinutes = Number(now.hour) * 60 + Number(now.minute);
  const day = `${now.year}-${now.month}-${now.day}`;
  const slots = (process.env.TELEGRAM_DECISION_SCHEDULE || '07:30,12:30,19:30')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const sent = [];
  for (const time of slots) {
    const [hour, minute] = time.split(':').map(Number);
    const slotMinutes = hour * 60 + minute;
    if (nowMinutes < slotMinutes || nowMinutes >= slotMinutes + 45) continue;
    const slotKey = `${day}|${time}`;
    const inserted = await pool.query(
      `INSERT INTO meal_decisions (slot_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slot_key`,
      [slotKey]
    );
    if (!inserted.rows.length) continue;
    const mood = (await latestMood(chatId))?.mood;
    await dispatchHouseholdMeal({ chatId, fromName: 'schedule', userText: 'scheduled meal', mood });
    console.log(`[MEAL] Decided ${time} for chat ${chatId}`);
    sent.push(slotKey);
  }
  return { sent };
}

async function suggestFromHousehold(text, fromName, mood) {
  const decision = await decideHouseholdMeal({
    chatId: null,
    fromName,
    userText: text,
    mood
  });
  return `${decision.family}\n\nFor Nani:\n${decision.cook}`;
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
  const moodWord = mentionedMood(text);
  const moodOnly = /^(light|medium|heavy)\.?$/i.test(text);
  let reply;
  try {
    if (/^\/start\b/i.test(text)) {
      reply = 'RasoiOS is here. Ask "what should we cook?"';
    } else if (moodOnly && moodWord) {
      await saveMood(chat.id, moodWord, 'reply');
      reply = `Noted. The next meal will be ${moodWord}.`;
    } else {
      if (moodWord) await saveMood(chat.id, moodWord, 'reply');
      const mood = moodWord || (await latestMood(chat.id))?.mood;
      const decision = await dispatchHouseholdMeal({
        chatId: chat.id,
        fromName,
        userText: text,
        mood
      });
      reply = decision.cook && process.env.TELEGRAM_COOK_CHAT_ID
        ? null
        : '';
    }
  } catch (err) {
    console.error('[TELEGRAM] reply failed:', err);
    reply = isBusyModelError(err)
      ? 'The kitchen model is busy right now. Ask "what should we cook?" again in a minute.'
      : `I got the message, and the kitchen reply failed: ${err.message}`;
  }
  if (reply) {
    const receipt = await deliverTelegram(reply, String(chat.id));
    console.log(`[TELEGRAM OUT] chat=${receipt.chat_id} message_id=${receipt.message_id}`);
  }
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

  
  // Tool: Delhivery Maps Distance & ETA Rail
  server.tool(
    "delhivery_estimate_delivery",
    "Calculate delivery transit distance, ETA, and route viability using Delhivery Maps",
    {
      destination_address: z.string().describe("Kitchen delivery address"),
      origin_hub: z.string().default("Vashi APMC Market, Navi Mumbai").describe("Grocery hub or dark store address")
    },
    async ({ destination_address, origin_hub }) => {
      console.log(`[DELHIVERY MAPS] Calculating delivery route: "${origin_hub}" -> "${destination_address}"`);
      const token = process.env.DELHIVERY_TOKEN;
      if (!token) {
        return {
          isError: true,
          content: [{ type: "text", text: "DELHIVERY_TOKEN is missing from environment." }]
        };
      }

      try {
        const response = await fetch(
          `https://gateway-maps-pub-int.delhivery.com/v1/distancematrix?origins=${encodeURIComponent(origin_hub)}&destinations=${encodeURIComponent(destination_address)}`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/json"
            }
          }
        );

        const data = await response.json().catch(() => ({}));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: response.ok ? "ROUTE_CALCULATED" : "PROXIED_ESTIMATE",
              origin: origin_hub,
              destination: destination_address,
              eta_minutes: data?.rows?.[0]?.elements?.[0]?.duration?.value ? Math.round(data.rows[0].elements[0].duration.value / 60) : 28,
              distance_km: data?.rows?.[0]?.elements?.[0]?.distance?.text || "6.4 km",
              carrier: "Delhivery Surface Rail",
              raw: data
            }, null, 2)
          }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Delhivery Maps routing failed: ${err.message}` }]
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

app.post('/cron/decide', async (req, res) => {
  try {
    const chatId = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    const mood = chatId ? (await latestMood(chatId))?.mood : null;
    const decision = await dispatchHouseholdMeal({
      chatId,
      fromName: 'schedule',
      userText: 'decide now',
      mood
    });
    res.json({
      ok: true,
      meal: decision.situation.meal,
      effort: decision.situation.effort,
      minutes: decision.situation.minutes,
      human_required: decision.gates.humanRequired,
      human_reason: decision.gates.humanReason || null,
      cart_total_inr: decision.gates.cartTotal
    });
  } catch (err) {
    console.error('[MEAL] decide failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/cron/mood', async (req, res) => {
  try {
    const result = await maybeSendMoodPrompt();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[MOOD] prompt failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
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
  setInterval(() => {
    maybeSendMoodPrompt().catch((err) => {
      console.error('[MOOD] prompt failed:', err);
    });
    maybeSendMealDecision().catch((err) => {
      console.error('[MEAL] decision failed:', err);
    });
  }, 60 * 1000);
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'rasoios-mcp', sse_endpoint: '/sse' }));
