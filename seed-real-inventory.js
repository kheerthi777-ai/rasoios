import pg from 'pg';

const DB_URL = 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create table if missing
    await client.query(`
      CREATE TABLE IF NOT EXISTS household_inventory (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        canonical_id TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL,
        quantity NUMERIC NOT NULL DEFAULT 1,
        unit TEXT NOT NULL DEFAULT 'unit',
        storage_tier TEXT NOT NULL, -- 'freezer', 'fridge', 'pantry'
        usable_today BOOLEAN DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Ensure budget ledger table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS household_budget_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        week_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
        weekly_limit_inr NUMERIC DEFAULT 2500,
        amount_spent_inr NUMERIC DEFAULT 0,
        per_cart_threshold_inr NUMERIC DEFAULT 300,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Reset ledger active week
    await client.query(`
      INSERT INTO household_budget_ledger (week_start_date, weekly_limit_inr, amount_spent_inr, per_cart_threshold_inr)
      VALUES (CURRENT_DATE, 2500, 0, 300)
      ON CONFLICT DO NOTHING;
    `);

    // Real transcribed items from voice notes
    const inventory = [
      // Perishables / Fresh Produce (Fridge)
      { id: 'milk', cat: 'dairy', qty: 1000, unit: 'ml', tier: 'fridge' },
      { id: 'curd', cat: 'dairy', qty: 500, unit: 'g', tier: 'fridge' },
      { id: 'buttermilk', cat: 'dairy', qty: 500, unit: 'ml', tier: 'fridge' },
      { id: 'butter', cat: 'dairy', qty: 200, unit: 'g', tier: 'fridge' },
      { id: 'curry_leaves', cat: 'herbs', qty: 50, unit: 'g', tier: 'fridge' },
      { id: 'coriander', cat: 'herbs', qty: 100, unit: 'g', tier: 'fridge' },
      { id: 'ginger', cat: 'aromatics', qty: 100, unit: 'g', tier: 'fridge' },
      { id: 'green_chilli', cat: 'aromatics', qty: 100, unit: 'g', tier: 'fridge' },
      { id: 'matar_fresh', cat: 'vegetable', qty: 500, unit: 'g', tier: 'fridge' },
      { id: 'tomato', cat: 'vegetable', qty: 1000, unit: 'g', tier: 'fridge' },
      { id: 'carrot', cat: 'vegetable', qty: 500, unit: 'g', tier: 'fridge' },
      { id: 'french_beans', cat: 'vegetable', qty: 250, unit: 'g', tier: 'fridge' },
      { id: 'snake_gourd', cat: 'vegetable', qty: 500, unit: 'g', tier: 'fridge' },
      { id: 'bottle_gourd', cat: 'vegetable', qty: 750, unit: 'g', tier: 'fridge' },
      { id: 'capsicum', cat: 'vegetable', qty: 300, unit: 'g', tier: 'fridge' },
      { id: 'bitter_gourd', cat: 'vegetable', qty: 250, unit: 'g', tier: 'fridge' },
      { id: 'beetroot', cat: 'vegetable', qty: 400, unit: 'g', tier: 'fridge' },
      { id: 'cabbage', cat: 'vegetable', qty: 500, unit: 'g', tier: 'fridge' },
      { id: 'bread', cat: 'bakery', qty: 1, unit: 'loaf', tier: 'fridge' },
      { id: 'idli_batter', cat: 'batter', qty: 1000, unit: 'g', tier: 'fridge' },
      { id: 'adai_batter', cat: 'batter', qty: 500, unit: 'g', tier: 'fridge' },
      { id: 'onion_paste', cat: 'condiment', qty: 200, unit: 'g', tier: 'fridge' },
      { id: 'tomato_paste', cat: 'condiment', qty: 200, unit: 'g', tier: 'fridge' },
      { id: 'soya_sauce', cat: 'condiment', qty: 200, unit: 'ml', tier: 'fridge' },

      // Staples & Provisions (Pantry)
      { id: 'rava', cat: 'grain', qty: 1000, unit: 'g', tier: 'pantry' },
      { id: 'semiya', cat: 'grain', qty: 500, unit: 'g', tier: 'pantry' },
      { id: 'wheat_flour', cat: 'flour', qty: 2000, unit: 'g', tier: 'pantry' },
      { id: 'besan', cat: 'flour', qty: 500, unit: 'g', tier: 'pantry' },
      { id: 'tuvar_dal', cat: 'pulse', qty: 1000, unit: 'g', tier: 'pantry' },
      { id: 'moong_dal', cat: 'pulse', qty: 1000, unit: 'g', tier: 'pantry' },
      { id: 'masoor_dal', cat: 'pulse', qty: 500, unit: 'g', tier: 'pantry' },
      { id: 'urad_dal', cat: 'pulse', qty: 1000, unit: 'g', tier: 'pantry' },
      { id: 'chole', cat: 'legume', qty: 500, unit: 'g', tier: 'pantry' },
      { id: 'matki', cat: 'legume', qty: 500, unit: 'g', tier: 'pantry' },
      { id: 'hara_moong', cat: 'legume', qty: 500, unit: 'g', tier: 'pantry' },
      { id: 'rai', cat: 'spice', qty: 200, unit: 'g', tier: 'pantry' },
      { id: 'jeera', cat: 'spice', qty: 200, unit: 'g', tier: 'pantry' },
      { id: 'methi_seeds', cat: 'spice', qty: 100, unit: 'g', tier: 'pantry' },
      { id: 'hing', cat: 'spice', qty: 50, unit: 'g', tier: 'pantry' },
      { id: 'namak', cat: 'spice', qty: 1000, unit: 'g', tier: 'pantry' },
      { id: 'coconut_oil', cat: 'oil', qty: 1000, unit: 'ml', tier: 'pantry' },
      { id: 'groundnut_oil', cat: 'oil', qty: 1000, unit: 'ml', tier: 'pantry' },
      { id: 'sesame_oil', cat: 'oil', qty: 500, unit: 'ml', tier: 'pantry' },
      { id: 'ghee_govardhan', cat: 'fat', qty: 500, unit: 'g', tier: 'pantry' }
    ];

    for (const item of inventory) {
      await client.query(`
        INSERT INTO household_inventory (canonical_id, category, quantity, unit, storage_tier, usable_today)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (canonical_id) DO UPDATE 
        SET quantity = EXCLUDED.quantity, usable_today = true, updated_at = NOW();
      `, [item.id, item.cat, item.qty, item.unit, item.tier]);
    }

    await client.query('COMMIT');
    console.log(`✅ Loaded ${inventory.length} real household stock items into Supabase.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seeding error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
