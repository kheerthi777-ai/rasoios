import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

const transports = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: 'rasoios-mcp-rails',
    version: '1.0.0'
  });

  server.tool(
    'get_cart',
    'Retrieve the active quick-commerce cart items and total amount',
    {},
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ACTIVE',
          items: [{ sku: 'Imported Olive Oil 1L', price: 450, quantity: 1 }],
          total_amount: 450,
          currency: 'INR'
        }, null, 2)
      }]
    })
  );

  server.tool(
    'add_to_cart',
    'Add items to the active cart',
    {
      item: z.string(),
      amount: z.number().default(450)
    },
    async ({ item, amount }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'UPDATED',
          item_added: item,
          cart_total: amount
        }, null, 2)
      }]
    })
  );

  server.tool(
    'gnani_speech_to_text',
    'Transcribe incoming user or cook voice notes into text with emotional context tagging',
    {
      audio_url: z.string().optional(),
      audio_base64: z.string().optional(),
      scenario_preset: z.enum(['tired_user', 'cook_ready', 'budget_halt_override', 'neutral']).optional()
    },
    async ({ scenario_preset }) => {
      const presets = {
        tired_user: {
          transcript: 'Yaar aaj office me bohot thak gaya hoon, bas khichdi aur dahi khana hai, kuch halka bana do.',
          detected_language: 'hi-IN (Hinglish)',
          sentiment: 'exhausted',
          confidence: 0.96
        },
        cook_ready: {
          transcript: 'Bhaiya main 7 baje aa rahi hoon, daal bhigo dijiye.',
          detected_language: 'hi-IN',
          sentiment: 'operational',
          confidence: 0.98
        },
        budget_halt_override: {
          transcript: 'Haan add kar do dry fruits bhi, extra 150 chalega.',
          detected_language: 'hi-IN',
          sentiment: 'approval',
          confidence: 0.94
        },
        neutral: {
          transcript: 'Pantry check karo aur dinner plan batao.',
          detected_language: 'hi-IN',
          sentiment: 'neutral',
          confidence: 0.95
        }
      };
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'SUCCESS', service: 'Gnani Prisma STT', ...(presets[scenario_preset || 'tired_user']) }, null, 2) }]
      };
    }
  );

  server.tool(
    'gnani_text_to_speech',
    'Synthesize regional voice notes (Hindi/Marathi) with morning prep instructions for the cook',
    {
      text: z.string().describe('Instructions to synthesize into regional audio'),
      target_language: z.enum(['hi-IN', 'en-IN', 'mr-IN']).default('hi-IN'),
      speaker_gender: z.enum(['female', 'male']).default('female')
    },
    async ({ text, target_language, speaker_gender }) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'SUCCESS',
            service: 'Gnani Timbre TTS',
            audio_url: `https://rasoios.vercel.app/audio/cook_note_${Date.now()}.mp3`,
            synthesized_text: text,
            target_language,
            speaker_gender,
            duration_seconds: 14.5
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'pinelabs_dynamic_mandate_switch',
    'Execute payment under ₹300 spend ceiling unless human override is explicitly granted',
    {
      cart_amount: z.number().describe('Total cart value in INR'),
      human_override_approved: z.boolean().default(false).describe('Set true if human supervisor explicitly authorized amount over ₹300')
    },
    async ({ cart_amount, human_override_approved }) => {
      if (cart_amount > 300 && !human_override_approved) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'DECLINED',
              error_code: 'GRANTEX_CAP_BREACH',
              message: `Cart amount ₹${cart_amount} exceeds ₹300 ceiling. Agent halted for human authorization.`
            }, null, 2)
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: human_override_approved ? 'OVERRIDE_AUTHORIZED_SETTLED' : (cart_amount > 250 ? 'FALLBACK_OTM_EXECUTED' : 'SETTLED_RESERVEPAY'),
            auth_code: `AUTH_${Math.floor(10000 + Math.random() * 90000)}`,
            pool_remaining: 1720 - cart_amount,
            settled_amount: cart_amount
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'pinelabs_check_balance',
    'Query rolling weekly balance and active mandate constraints',
    { user_id: z.string().default('usr_kheerthi_01') },
    async ({ user_id }) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            user_id,
            active_mandate: 'man_sbmd_9921',
            max_single_tx_ceiling: 300,
            reservepay_pool_balance: 1580,
            is_active: true
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'delhivery_verify_address',
    'Verify drop address granularity and geocode coordinates',
    { address: z.string() },
    async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            is_verified: true,
            granularity: 'PREMISE',
            standardised_address: 'Flat 402, Sea Breeze Apartments, Palm Beach Rd, Sanpada, Navi Mumbai, Maharashtra 400705',
            coordinates: { lat: 19.0657, lng: 73.0104 }
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'delhivery_hyperlocal_dispatch',
    'Dispatch missing grocery items from dark store',
    {
      sku_list: z.array(z.string()),
      target_sla_mins: z.number().default(30)
    },
    async ({ sku_list, target_sla_mins }) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            order_id: `DLH_HYPER_${Math.floor(1000 + Math.random() * 9000)}`,
            darkstore_id: 'DS_WEST_SANPADA',
            eta_minutes: Math.min(target_sla_mins, 22),
            status: 'DISPATCHED',
            items_reserved: sku_list
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'delhivery_premise_navigation',
    'Generate silent doorstep delivery instructions for rider gate clearance',
    {
      order_id: z.string(),
      drop_type: z.string().default('DOORSTEP_SECURITY_BOX'),
      gate_code: z.string().default('WING_B_77')
    },
    async ({ order_id, drop_type, gate_code }) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            instruction_token: `INST_NAV_${Date.now()}`,
            order_id,
            delivery_protocol: drop_type,
            gate_code,
            requires_call: false,
            silent_drop_authorized: true
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

const handleSse = async (req, res) => {
  console.log(`[SSE] Incoming handshake`);
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Content-Type', 'text/event-stream');

  const host = req.get('host');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const endpoint = `${proto}://${host}/messages`;

  const transport = new SSEServerTransport(endpoint, res);
  const server = createMcpServer();

  transports.set(transport.sessionId, transport);

  // 15-second heartbeat ping to stop Cloudflare timeouts
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(heartbeatInterval);
    }
  }, 15000);

  transport.onclose = () => {
    console.log(`[SSE] Connection closed: ${transport.sessionId}`);
    clearInterval(heartbeatInterval);
    transports.delete(transport.sessionId);
  };

  await server.connect(transport);
  res.write(': ' + ' '.repeat(2048) + '\n\n');
};

app.get('/sse', handleSse);
app.get('/', handleSse);

async function handleMcpPost(req, res) {
  console.log(`[MCP] ${req.method} ${req.url}`);
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post('/sse', handleMcpPost);
app.post('/', handleMcpPost);
app.post('/mcp', handleMcpPost);

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.error(`[POST /messages] Session not found: ${sessionId}`);
    return res.status(404).send('Session not found');
  }

  await transport.handlePostMessage(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`RasoiOS MCP Rails Server live on port ${PORT}`);
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
