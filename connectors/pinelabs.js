import pg from 'pg';

const DB_URL = 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const PER_CART_THRESHOLD = 300;
const WEEKLY_BUDGET_CEILING = 2500;

export async function evaluateCartAndDebit(cartTotalInr) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ledgerRes = await client.query(
      `SELECT id, amount_spent_inr, weekly_limit_inr, per_cart_threshold_inr 
       FROM household_budget_ledger ORDER BY week_start_date DESC LIMIT 1 FOR UPDATE;`
    );
    const ledger = ledgerRes.rows[0] || {
      amount_spent_inr: 0,
      weekly_limit_inr: WEEKLY_BUDGET_CEILING,
      per_cart_threshold_inr: PER_CART_THRESHOLD
    };

    const remainingBudget = Number(ledger.weekly_limit_inr) - Number(ledger.amount_spent_inr);

    if (cartTotalInr > remainingBudget) {
      await client.query('ROLLBACK');
      return { approved: false, reason: 'HITL_WEEKLY_EXCEEDED', remainingBudget };
    }
    if (cartTotalInr > Number(ledger.per_cart_threshold_inr)) {
      await client.query('ROLLBACK');
      return { approved: false, reason: 'HITL_CART_THRESHOLD_EXCEEDED', limit: ledger.per_cart_threshold_inr };
    }

    if (ledger.id) {
      await client.query(
        `UPDATE household_budget_ledger 
         SET amount_spent_inr = amount_spent_inr + $1, updated_at = NOW() 
         WHERE id = $2;`,
        [cartTotalInr, ledger.id]
      );
    }
    await client.query('COMMIT');
    return { approved: true, amountDebited: cartTotalInr, remainingBalance: remainingBudget - cartTotalInr };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
