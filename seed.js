import pg from 'pg';
import { OpenAI } from 'openai';
import 'dotenv/config';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
  console.log('Generating embeddings and seeding taste profiles...');

  for (const item of sampleProfiles) {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: item.preference
    });

    const vector = JSON.stringify(res.data[0].embedding);

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
