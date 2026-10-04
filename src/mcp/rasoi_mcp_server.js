import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import pg from 'pg';
import { generateCookAudio } from '../../connectors/gnani.js';
import { sendTelegramMessage, sendCookVoiceBrief, PLANNER_CHAT_ID, GROUP_CHAT_ID } from '../../connectors/telegram.js';
import { evaluateCartAndDebit } from '../../connectors/pinelabs.js';

const DB_URL = 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

// Factory to create a clean McpServer instance for every incoming connection
function createServer() {
  const server = new McpServer({
    name: 'rasoios-mcp-server',
    version: '1.0.0'
  });

  // TOOL 1: KitchenOps
  server.tool(
    'fetch_kitchen_inventory',
    'Fetches usable live inventory items directly from household Supabase PostgreSQL database',
    {},
    async () => {
      try {
        const res = await pool.query(
          `SELECT canonical_id, name, category, quantity, unit, storage_tier 
           FROM household_inventory WHERE usable_today = true AND quantity > 0;`
        );
        return { content: [{ type: 'text', text: JSON.stringify(res.rows) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }
  );

  // TOOL 2: Finance
  server.tool(
    'evaluate_pinelabs_budget',
    'Evaluates procurement cart amount against Pine Labs wallet budget and debits if within limits',
    { cart_amount: z.number().describe('Total missing items procurement cost in INR') },
    async ({ cart_amount }) => {
      try {
        const result = await evaluateCartAndDebit(cart_amount);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }
  );

  // TOOL 3: Cook Liaison
  server.tool(
    'generate_cook_audio_memo',
    'Synthesizes polite spoken Hindi cooking instructions into a WAV voice memo using Gnani Indic TTS',
    { hindi_text: z.string().describe('Spoken Hindi cooking instructions in Devanagari script') },
    async ({ hindi_text }) => {
      try {
        const audioBuffer = await generateCookAudio(hindi_text, 'hi-IN', 'Nalini');
        return { content: [{ type: 'text', text: `Audio synthesized successfully (${audioBuffer.length} bytes)` }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }
  );

  // TOOL 4: Concierge
  server.tool(
    'dispatch_telegram_summary',
    'Dispatches the finalized meal plan card and cook voice memo to the household Telegram group',
    {
      dish_name: z.string(),
      prep_time_minutes: z.number(),
      notes: z.string(),
      hindi_speech: z.string()
    },
    async ({ dish_name, prep_time_minutes, notes, hindi_speech }) => {
      try {
        const groupNotice = `🍳 *Meal Planned*: ${dish_name}\n⏱ *Time*: ${prep_time_minutes} mins\n💡 *Ops Note*: ${notes}\n👨‍🍳 *Cook Status*: Audio brief synthesized.`;
        await sendTelegramMessage(GROUP_CHAT_ID, groupNotice);

        const audioBuffer = await generateCookAudio(hindi_speech, 'hi-IN', 'Nalini');
        await sendCookVoiceBrief(PLANNER_CHAT_ID, audioBuffer, `निर्देश: ${dish_name}`);

        return { content: [{ type: 'text', text: 'Telegram group update and Cook voice brief dispatched.' }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }
  );

  return server;
}

const app = express();
const transports = new Map();

// Accept SSE on both /sse AND root / (so it works whichever URL is passed)
async function handleSse(req, res) {
  console.log(`📡 Incoming SSE discovery connection from ${req.ip}...`);
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);

  const server = createServer();
  await server.connect(transport);

  res.on('close', () => {
    transports.delete(transport.sessionId);
    console.log(`🔌 SSE connection closed for session: ${transport.sessionId}`);
  });
}

app.get('/sse', handleSse);
app.get('/', (req, res, next) => {
  if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
    return handleSse(req, res);
  }
  return handleSse(req, res);
});

// JSON-RPC message receiver
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send('Session not found');
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 RasoiOS MCP Server ready on port ${PORT}`);
  console.log(`📡 Ready for AgenticOrg auto-discovery!`);
});
