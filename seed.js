import pg from 'pg';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const sampleProfiles = [
  {
    category: 'texture',
    preference: 'Sandwiches must be toasted golden brown and firm. Never leave bread soft or soggy.'
  },
  {
    category: 'ingredient',
    preference: 'Avoid raw chopped onions in fillings or sandwiches. Cooked or caramelized onions are acceptable.'
  },
  {
    category: 'spice',
    preference: 'Medium spice level. Prefers slit fresh green chilies over heavy red chili powder.'
  },
  {
    category: 'cook_habit',
    preference: 'For gravies like Matar Paneer, keep oil light and lightly fry paneer cubes before adding to sauce.'
  }
];

async function seed() {
  console.log('Generating Gemini embeddings...');

  for (const item of sampleProfiles) {
    const response = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: item.preference,
      config: {
        outputDimensionality: 768
      }
    });

    const values = response.embeddings?.[0]?.values || response.embedding?.values;
    if (!values) {
      throw new Error(`Embedding values missing: ${JSON.stringify(response)}`);
    }

    const vector = JSON.stringify(values);

    await pool.query(
      `INSERT INTO taste_profiles (category, preference, embedding) VALUES ($1, $2, $3::vector)`,
      [item.category, item.preference, vector]
    );

    console.log(`✓ Inserted: [${item.category}]`);
  }

  console.log('Seeding complete.');
  await pool.end();
}

seed().catch(err => {
  console.error('Seed error:', err);
  pool.end();
});
