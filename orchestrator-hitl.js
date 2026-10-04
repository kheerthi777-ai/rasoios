import pg from 'pg';
import { generateCookAudio } from './connectors/gnani.js';
import { sendTelegramMessage, sendDecisionPrompt, sendCookVoiceBrief, PLANNER_CHAT_ID, GROUP_CHAT_ID } from './connectors/telegram.js';
import { evaluateCartAndDebit } from './connectors/pinelabs.js';

const DB_URL = 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

/**
 * Evaluates dish feasibility against stock and deterministic substitutions.
 */
export async function evaluateDishWithFallbacks(dish) {
  const stockRes = await pool.query(`SELECT canonical_id, quantity FROM household_inventory WHERE usable_today = true;`);
  const stockMap = new Map(stockRes.rows.map(r => [r.canonical_id, Number(r.quantity)]));

  const fulfilled = [];
  const unresolvableMissing = [];

  for (const item of dish.ingredients) {
    // 1. Direct stock check
    if (stockMap.has(item.id) && stockMap.get(item.id) >= item.needed) {
      fulfilled.push({ id: item.id, status: 'DIRECT_STOCK' });
      continue;
    }

    // 2. Query substitution dictionary
    const subRes = await pool.query(
      `SELECT substitute_canonical_id, swap_ratio FROM ingredient_substitutes 
       WHERE original_canonical_id = $1 ORDER BY priority ASC;`,
      [item.id]
    );

    let resolvedBySub = false;
    for (const sub of subRes.rows) {
      const subId = sub.substitute_canonical_id;
      const requiredQty = item.needed * Number(sub.swap_ratio);
      if (stockMap.has(subId) && stockMap.get(subId) >= requiredQty) {
        fulfilled.push({ id: item.id, substitutedWith: subId, status: 'SUBSTITUTED' });
        resolvedBySub = true;
        break;
      }
    }

    // 3. Fallback exhausted
    if (!resolvedBySub) {
      unresolvableMissing.push(item);
    }
  }

  const score = (fulfilled.length / dish.ingredients.length) * 100;
  return {
    score,
    fulfilled,
    unresolvableMissing,
    isViable: score >= 80 && unresolvableMissing.length === 0
  };
}

/**
 * Main Autonomous Orchestration with HITL Gates
 */
export async function runOrchestration({ dishCandidate, estimatedCartTotal = 0, cookAvailable = true }) {
  console.log(`\n==================================================`);
  console.log(`Evaluating Meal: ${dishCandidate.name}`);
  console.log(`Cook Available: ${cookAvailable ? 'YES' : 'NO (Emergency DIY Mode)'}`);
  console.log(`==================================================`);

  // --- GATE 1: 80/20 & Substitution Feasibility ---
  const evalResult = await evaluateDishWithFallbacks(dishCandidate);
  console.log(`Viability Score: ${evalResult.score.toFixed(1)}%`);

  if (!evalResult.isViable) {
    console.log(`🚨 TRIGGER HITL (Stockout Failure): Unresolvable items found.`);
    const missingNames = evalResult.unresolvableMissing.map(m => m.id).join(', ');
    
    await sendDecisionPrompt(
      PLANNER_CHAT_ID,
      `⚠️ *RasoiOS Escalation: Stockout Failure*\n\n` +
      `Cannot prepare *${dishCandidate.name}*.\n` +
      `Missing items with *zero available substitutions*: \`${missingNames}\`.\n\n` +
      `Select immediate action:`,
      {
        'Switch to Poha/Upma (10-Min)': 'ACTION_SWAP_POHA',
        'Order via ONDC Hyperlocal': 'ACTION_FORCE_ONDC',
        'Cancel Dish': 'ACTION_CANCEL'
      }
    );
    return { status: 'HITL_TRIGGERED_STOCKOUT', missing: evalResult.unresolvableMissing };
  }

  // --- GATE 2: Pine Labs Zero-Click Micro-Debit Gate ---
  if (estimatedCartTotal > 0) {
    console.log(`Evaluating Cart Total: ₹${estimatedCartTotal}`);
    const budgetCheck = await evaluateCartAndDebit(estimatedCartTotal);

    if (!budgetCheck.approved) {
      console.log(`🚨 TRIGGER HITL (Budget Breach): ${budgetCheck.reason}`);
      await sendDecisionPrompt(
        PLANNER_CHAT_ID,
        `⚠️ *RasoiOS Escalation: Budget Threshold Exceeded*\n\n` +
        `Cart total *₹${estimatedCartTotal}* exceeds the autonomous limit.\n` +
        `Reason: \`${budgetCheck.reason}\`.\n\n` +
        `Approve override debit from Pine Labs reserve?`,
        {
          [`Authorize ₹${estimatedCartTotal}`]: `APPROVE_BUDGET_${estimatedCartTotal}`,
          'Reject & Downscale Cart': 'REJECT_BUDGET'
        }
      );
      return { status: 'HITL_TRIGGERED_BUDGET', reason: budgetCheck.reason };
    }
    console.log(`✅ Pine Labs Auto-Debit Approved: ₹${estimatedCartTotal} (Remaining: ₹${budgetCheck.remainingBalance})`);
  }

  // --- STEP 3: Dispatch Cook Brief & Family Notification ---
  if (cookAvailable) {
    console.log('Synthesizing cook brief via Gnani TTS (Nalini - Hindi)...');
    const audioBuffer = await generateCookAudio(dishCandidate.cookInstructionsHindi, 'hi-IN', 'Nalini');
    await sendCookVoiceBrief(PLANNER_CHAT_ID, audioBuffer, `निर्देश: ${dishCandidate.name}`);
    console.log('✅ Cook voice memo dispatched.');
  } else {
    await sendTelegramMessage(GROUP_CHAT_ID, `⚠️ *Cook Absent*: Switched to 10-minute DIY mode for ${dishCandidate.name}.`);
  }

  await sendTelegramMessage(
    GROUP_CHAT_ID,
    `🍳 *Meal Locked*: ${dishCandidate.name}\n` +
    `⏱ *Prep Time*: ${dishCandidate.prepTimeMinutes} mins\n` +
    `📦 *Stock*: Fulfilled autonomously with fridge substitutes.`
  );

  return { status: 'AUTONOMOUS_SUCCESS' };
}
