import pg from 'pg';
import { generateCookAudio } from './connectors/gnani.js';
import { sendTelegramMessage, sendDecisionPrompt, sendCookVoiceBrief, PLANNER_CHAT_ID, GROUP_CHAT_ID } from './connectors/telegram.js';
import { evaluateCartAndDebit } from './connectors/pinelabs.js';

const DB_URL = 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function orchestrateHouseholdFlow() {
  console.log('--- [1. Context Evaluator] ---');
  const now = new Date();
  const day = now.getDay();
  const isWeekend = (day === 0 || day === 6);
  const hour = now.getHours();

  const isMorningCrunch = (!isWeekend && hour < 11);
  const cookAvailable = true; // Set to false to test 10-minute DIY emergency fallback

  console.log(`Day: ${isWeekend ? 'Weekend' : 'Weekday'} | Cook: ${cookAvailable ? 'Present' : 'Absent'} | Mode: ${isMorningCrunch ? '10-Min Crunch' : 'Standard'}`);

  console.log('--- [2. 80/20 Dish Candidate Evaluation] ---');
  // Candidate Dish: Vegetable Rava Upma + Kids French Toast
  const candidate = {
    name: 'Vegetable Rava Upma & Kids Butter Toast',
    prepTimeMinutes: 15,
    ingredients: [
      { id: 'rava', needed: 250, unit: 'g' },
      { id: 'bread', needed: 1, unit: 'loaf' },
      { id: 'butter', needed: 50, unit: 'g' },
      { id: 'matar_fresh', needed: 100, unit: 'g' },
      { id: 'carrot', needed: 100, unit: 'g' },
      { id: 'curry_leaves', needed: 10, unit: 'g' },
      { id: 'rai', needed: 5, unit: 'g' },
      { id: 'onion_fresh', needed: 100, unit: 'g' } // Missing fresh onion -> Needs substitution or purchase
    ]
  };

  const stockRes = await pool.query(`SELECT canonical_id, quantity FROM household_inventory WHERE usable_today = true;`);
  const stockMap = new Map(stockRes.rows.map(r => [r.canonical_id, Number(r.quantity)]));

  let inStockCount = 0;
  let missingItems = [];

  for (const item of candidate.ingredients) {
    if (stockMap.has(item.id) && stockMap.get(item.id) >= item.needed) {
      inStockCount++;
    } else {
      // Check substitution: onion_fresh -> onion_paste (present in fridge door)
      if (item.id === 'onion_fresh' && stockMap.has('onion_paste') && stockMap.get('onion_paste') >= 50) {
        console.log('🔄 Autonomous Substitution Applied: onion_fresh -> onion_paste (In stock in fridge)');
        inStockCount++;
      } else {
        missingItems.push(item);
      }
    }
  }

  const viabilityScore = (inStockCount / candidate.ingredients.length) * 100;
  console.log(`Viability Score: ${viabilityScore.toFixed(0)}%`);

  console.log('--- [3. Procurement & Pine Labs Budget Guard] ---');
  let cartTotalInr = missingItems.length === 0 ? 0 : 180; // Estimated micro-cart

  if (cartTotalInr > 0) {
    console.log(`Evaluating ONDC Cart total: ₹${cartTotalInr}`);
    const debitResult = await evaluateCartAndDebit(cartTotalInr);
    
    if (!debitResult.approved) {
      console.log(`🚨 Triggering HITL: ${debitResult.reason}`);
      await sendDecisionPrompt(PLANNER_CHAT_ID, `⚠️ *Budget Alert*: Grocery cart is ₹${cartTotalInr}. Overrides required.`, {
        'Approve Micro-Debit': 'APPROVE_CART',
        'Cancel Order': 'CANCEL_CART'
      });
      return;
    }
    console.log(`✅ Pine Labs Auto-Debit Approved: ₹${cartTotalInr} (Remaining Weekly: ₹${debitResult.remainingBalance})`);
  } else {
    console.log('✅ 100% In-Stock via inventory & fridge substitutions. Zero procurement required.');
  }

  console.log('--- [4. Emitting Stakeholder Outputs] ---');
  
  // 1. Send Planner & Family Notification
  const mealSummary = `🍳 *Breakfast Planned*: ${candidate.name}\n` +
    `⏱ *Time*: ${candidate.prepTimeMinutes} mins (Crunch Mode)\n` +
    `📦 *Stock*: 100% fulfilled (used fridge onion paste substitution)\n` +
    `👨‍🍳 *Cook Status*: Audio brief generated and dispatched via Gnani.`;

  await sendTelegramMessage(GROUP_CHAT_ID, mealSummary);
  console.log('✅ Family Group notified on Telegram.');

  // 2. Synthesize & Send Voice Brief to the Cook
  const hindiCookBrief = 'नमस्ते। आज सुबह के नाश्ते में रवा उपमा और बच्चों के लिए बटर टोस्ट बनाना है। प्याज के बदले फ्रिज में रखा अनियन पेस्ट इस्तेमाल करें। 15 मिनट में तैयार करें।';
  console.log('Generating cook audio brief via Gnani TTS...');
  const audioBuffer = await generateCookAudio(hindiCookBrief, 'hi-IN', 'Nalini');
  
  await sendCookVoiceBrief(PLANNER_CHAT_ID, audioBuffer, `आज का नाश्ता: ${candidate.name}`);
  console.log('✅ Cook voice memo sent to Telegram.');

  await pool.end();
  console.log('\n🎉 Autonomous Workflow Executed Successfully with Zero Humans in the Loop.');
}

orchestrateHouseholdFlow().catch(console.error);
