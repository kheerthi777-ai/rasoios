import pg from 'pg';
import { GoogleGenAI } from '@google/genai';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres'
});

const ai = new GoogleGenAI({
  apiKey: 'AIzaSyBA0140Q6uLdpwCC7X8UnY4WQTtVbXXh0I'
});

async function runTest() {
  console.log('--- 1. Testing Qualitative Vector Retrieval ---');
  const testDish = 'Crisp grilled cheese toast';
  
  const response = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: testDish,
    config: { outputDimensionality: 768 }
  });

  const values = response.embeddings?.[0]?.values || response.embedding?.values;
  const queryVector = JSON.stringify(values);

  const { rows: vectorRows } = await pool.query(
    `SELECT category, preference, 1 - (embedding <=> $1::vector) AS similarity
     FROM taste_profiles
     ORDER BY similarity DESC
     LIMIT 2;`,
    [queryVector]
  );

  console.log(`Query: "${testDish}"`);
  vectorRows.forEach(r => {
    console.log(`- [${r.category}] (Score: ${Number(r.similarity).toFixed(3)}): ${r.preference}`);
  });

  console.log('\n--- 2. Testing Quantitative Inventory Check ---');
  const testSkus = ['Fresh Paneer 200g', 'Green Peas 250g', 'Amul Butter 100g'];
  const { rows: invRows } = await pool.query(
    `SELECT sku, quantity, unit FROM pantry_inventory WHERE sku = ANY($1);`,
    [testSkus]
  );

  const inventoryMap = new Map(invRows.map(i => [i.sku, i]));
  testSkus.forEach(sku => {
    const item = inventoryMap.get(sku);
    if (item && Number(item.quantity) > 0) {
      console.log(`- In stock: ${sku} (${item.quantity} ${item.unit})`);
    } else {
      console.log(`- Out of stock / Needed: ${sku} (${item ? item.quantity : 0} in pantry)`);
    }
  });

  await pool.end();
}

runTest().catch(err => {
  console.error('Test error:', err);
  pool.end();
});
