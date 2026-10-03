import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import pg from 'pg';
import { GoogleGenAI } from '@google/genai';
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
      location: z.enum(['fridge', 'freezer', 'pantry', 'masala_dabba', 'counter']).optional()
        .describe('Storage location. Omit to return the full household.'),
      form: z.enum(['raw', 'packet', 'dabba', 'chutney', 'leftover', 'batter', 'opened', 'hardware']).optional()
        .describe('Item form, such as leftover, chutney, or hardware.')
    },
    async ({ location, form }) => {
      console.log(`[TOOL CALL] fridge_snapshot location=${location || 'all'} form=${form || 'all'}`);
      try {
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

  return server;
}

const transports = new Map();

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
