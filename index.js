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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const server = new McpServer({
  name: 'rasoios-pantry-mcp',
  version: '1.0.0'
});

// Tool 1: Core Taste Profile (Always-on Invariants)
server.tool(
  'get_core_taste_profile',
  'Retrieve universal household dietary rules, texture baselines, and hard dislikes (non-negotiables)',
  {},
  async () => {
    try {
      const { rows } = await pool.query(
        `SELECT category, preference FROM taste_profiles ORDER BY category ASC;`
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ core_preferences: rows }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to fetch core profile: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 2: Qualitative Taste & Quirks (Fuzzy Vector Search)
server.tool(
  'get_taste_profile_context',
  'Retrieve specific situational cooking quirks or dish-specific techniques via semantic search',
  { dish_query: z.string().describe('Meal or dish name, e.g., "cheese sandwich" or "matar paneer"') },
  async ({ dish_query }) => {
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
      return {
        content: [{ type: 'text', text: `Vector search failed: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 3: Quantitative Inventory Check (Relational Stock)
server.tool(
  'check_pantry_inventory',
  'Check deterministic stock levels for specified SKUs or ingredients',
  { required_skus: z.array(z.string()).describe('List of SKUs, e.g. ["Fresh Paneer 200g", "Green Peas 250g"]') },
  async ({ required_skus }) => {
    try {
      const { rows } = await pool.query(
        `SELECT sku, quantity, unit FROM pantry_inventory WHERE sku = ANY($1);`,
        [required_skus]
      );

      const foundMap = new Map(rows.map(r => [r.sku, r]));
      const inStock = [];
      const outOfStock = [];

      for (const sku of required_skus) {
        const item = foundMap.get(sku);
        if (item && Number(item.quantity) > 0) {
          inStock.push(item);
        } else {
          outOfStock.push({ sku, quantity: item ? item.quantity : 0, status: 'unavailable' });
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ in_stock: inStock, out_of_stock: outOfStock }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Inventory check failed: ${err.message}` }],
        isError: true
      };
    }
  }
);

// SSE Transport Handling
let transport = null;

app.get('/sse', async (req, res) => {
  transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('No active SSE connection');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ MCP SSE Server listening on port ${PORT}`);
});
