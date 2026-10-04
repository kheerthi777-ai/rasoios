import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import pg from 'pg';
import { generateCookAudio } from '../../connectors/gnani.js';
import { sendTelegramMessage, sendDecisionPrompt, sendCookVoiceBrief, PLANNER_CHAT_ID, GROUP_CHAT_ID } from '../../connectors/telegram.js';
import { evaluateCartAndDebit } from '../../connectors/pinelabs.js';

const GROQ_API_KEY = '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';
const DB_URL = 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

let cachedModel = null;

async function getGroqModel() {
  if (cachedModel) return cachedModel;
  const KNOWN_CHAT_MODELS = [
    'llama-3.1-8b-instant',
    'llama3-8b-8192',
    'llama3-70b-8192',
    'gemma2-9b-it',
    'mixtral-8x7b-32768',
    'deepseek-r1-distill-llama-70b'
  ];

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
    const d = await res.json();
    const available = (d.data || []).map(m => m.id);
    
    // Pick the first valid text-generation model (filter out guardrails, whisper, vision)
    cachedModel = KNOWN_CHAT_MODELS.find(m => available.includes(m)) ||
      available.find(id => !id.includes('guard') && !id.includes('whisper') && !id.includes('vision') && !id.includes('embed')) ||
      'llama-3.1-8b-instant';

    console.log(`🤖 [Groq Chat Model Selected]: ${cachedModel}`);
    return cachedModel;
  } catch {
    cachedModel = 'llama-3.1-8b-instant';
    return cachedModel;
  }
}

// --- GROQ LLM CALLER ---
async function callLLM(prompt, systemInstruction = '') {
  const model = await getGroqModel();
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemInstruction + ' Return strictly valid JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    })
  });

  if (!res.ok) {
    throw new Error(`Groq API Error (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// --- DYNAMIC STOCK SOLVER (SAFETY NET) ---
function dynamicStockSolver(userPrompt, inventoryList) {
  const promptLower = (userPrompt || '').toLowerCase();
  const pulses = inventoryList.filter(i => i.category === 'pulse' && i.quantity > 0);
  const vegs = inventoryList.filter(i => i.category === 'vegetable' && i.quantity > 0);
  const grains = inventoryList.filter(i => (i.category === 'grain' || i.category === 'batter') && i.quantity > 0);

  let dishName = '';
  let used = [];
  let prepMinutes = 20;
  let reason = '';

  if (promptLower.includes('south indian') || promptLower.includes('lunch')) {
    const pulse = pulses.find(p => p.canonical_id === 'tuvar_dal') || pulses[0] || { canonical_id: 'tuvar_dal', name: 'Tuvar Dal' };
    const veg1 = vegs.find(v => v.canonical_id === 'bottle_gourd' || v.canonical_id === 'snake_gourd') || vegs[0] || { canonical_id: 'vegetables', name: 'Fresh Vegetables' };
    const veg2 = vegs.find(v => v.canonical_id === 'carrot') || vegs[1] || { canonical_id: 'carrot', name: 'Carrot' };

    dishName = `South Indian ${pulse.name} Sambar with ${veg1.name} & Rice`;
    used = [pulse.canonical_id, veg1.canonical_id, veg2.canonical_id, 'curry_leaves', 'rai', 'hing', 'namak'];
    prepMinutes = 25;
    reason = `Formulated from live fridge stock matching requested South Indian profile.`;
  } else {
    const grain = grains[0] || { canonical_id: 'grain', name: 'Pantry Grain' };
    const veg = vegs[0] || { canonical_id: 'vegetable', name: 'Fresh Vegetables' };
    dishName = `Home Style ${grain.name} with ${veg.name}`;
    used = [grain.canonical_id, veg.canonical_id, 'curry_leaves', 'rai'];
    prepMinutes = 15;
    reason = `Matched available pantry staples and fresh vegetables.`;
  }

  return {
    dish_name: dishName,
    prep_time_minutes: prepMinutes,
    ingredients_used: used,
    missing_ingredients_to_buy: [],
    reasoning: reason
  };
}

// --- LANGGRAPH STATE ANNOTATION ---
const RasoiState = Annotation.Root({
  mealType: Annotation(),
  userRequest: Annotation(),
  inventory: Annotation(),
  selectedMeal: Annotation(),
  cartTotal: Annotation(),
  budgetApproved: Annotation(),
  hitlReason: Annotation(),
  cookInstructionsHindi: Annotation(),
  audioBuffer: Annotation()
});

// AGENT 1: Kitchen Ops Agent
async function kitchenOpsNode(state) {
  console.log('\n🧑‍🍳 [Kitchen Ops Agent]: Fetching live stock from Supabase...');
  const stockRes = await pool.query(
    `SELECT canonical_id, name, category, quantity, unit, storage_tier 
     FROM household_inventory WHERE usable_today = true AND quantity > 0;`
  );
  const inventoryList = stockRes.rows;

  console.log(`🧑‍🍳 [Kitchen Ops Agent]: Reasoning dynamically over ${inventoryList.length} items...`);
  const prompt = `
Live Kitchen Inventory:
${JSON.stringify(inventoryList.map(i => ({ id: i.canonical_id, name: i.name, qty: `${i.quantity}${i.unit}`, tier: i.storage_tier })))}

Target Meal: ${state.mealType || 'Lunch'}
Preference: ${state.userRequest || 'Healthy home meal'}

Instructions:
1. Apply 80/20 inventory viability rule against available stock.
2. If fresh onion is missing, use onion_paste if in stock.
3. Pick 1 feasible dish.

Output strictly JSON:
{
  "dish_name": "string",
  "prep_time_minutes": number,
  "ingredients_used": ["string"],
  "missing_ingredients_to_buy": [{"id": "string", "name": "string", "estimated_inr": number}],
  "reasoning": "string"
}`;

  let plan;
  try {
    plan = await callLLM(prompt, 'You are an Indian kitchen ops manager. Strictly use provided ingredients.');
  } catch (err) {
    console.warn(`⚠️ [KitchenOps LLM issue: ${err.message}] -> Using dynamic inventory matcher.`);
    plan = dynamicStockSolver(state.userRequest, inventoryList);
  }

  console.log(`🧑‍🍳 [Kitchen Ops Decision]: ${plan.dish_name} (Prep: ${plan.prep_time_minutes}m)`);
  const missingTotal = (plan.missing_ingredients_to_buy || []).reduce((acc, cur) => acc + (cur.estimated_inr || 0), 0);

  return {
    inventory: inventoryList,
    selectedMeal: plan,
    cartTotal: missingTotal
  };
}

// AGENT 2: Finance Agent
async function financeNode(state) {
  const cart = state.cartTotal || 0;
  console.log(`\n💳 [Finance Agent]: Checking cart total ₹${cart}...`);

  if (cart === 0) {
    console.log('💳 [Finance Agent]: Zero-cost meal. 100% pantry fulfilled.');
    return { budgetApproved: true, hitlReason: null };
  }

  const debitResult = await evaluateCartAndDebit(cart);
  if (!debitResult.approved) {
    console.log(`🚨 [Finance Agent HITL]: Budget threshold breached: ${debitResult.reason}`);
    return { budgetApproved: false, hitlReason: debitResult.reason };
  }

  console.log(`💳 [Finance Agent]: Debited ₹${cart}. Balance: ₹${debitResult.remainingBalance}`);
  return { budgetApproved: true, hitlReason: null };
}

// AGENT 3: Cook Liaison Agent
async function cookLiaisonNode(state) {
  const meal = state.selectedMeal;
  console.log(`\n🗣️ [Cook Liaison Agent]: Generating spoken Hindi instructions for ${meal.dish_name}...`);

  const prompt = `
Dish: ${meal.dish_name}
Prep Time: ${meal.prep_time_minutes} minutes
Ingredients: ${meal.ingredients_used.join(', ')}

Task:
Write concise, polite cooking instructions in natural spoken Hindi (Devanagari script) for the domestic cook (2-3 sentences).

Output strictly JSON:
{
  "hindi_speech": "string"
}`;

  let speechText;
  try {
    const res = await callLLM(prompt, 'You are a domestic kitchen liaison. Provide spoken Hindi in Devanagari.');
    speechText = res.hindi_speech;
  } catch (err) {
    speechText = `नमस्ते। आज के खाने में ${meal.dish_name} तैयार करना है। सभी सामग्री रसोई में उपलब्ध है, कृपया तैयारी शुरू करें।`;
  }

  console.log(`🗣️ [Hindi Brief]: "${speechText}"`);
  console.log('🗣️ [Cook Liaison Agent]: Synthesizing audio via Gnani TTS (Nalini)...');
  const audioBuffer = await generateCookAudio(speechText, 'hi-IN', 'Nalini');

  return {
    cookInstructionsHindi: speechText,
    audioBuffer: audioBuffer
  };
}

// AGENT 4: Concierge Agent
async function conciergeNode(state) {
  console.log('\n🛎️ [Concierge Agent]: Delivering notifications...');

  if (!state.budgetApproved) {
    await sendDecisionPrompt(
      PLANNER_CHAT_ID,
      `⚠️ *RasoiOS Finance Escalation*\n\nMeal: *${state.selectedMeal.dish_name}*\nCart requires *₹${state.cartTotal}* (${state.hitlReason}).\nAuthorize debit?`,
      {
        [`Approve ₹${state.cartTotal}`]: `APPROVE_BUDGET_${state.cartTotal}`,
        'Cancel Dish': 'ACTION_CANCEL'
      }
    );
    return state;
  }

  const groupNotice = `🍳 *Meal Planned*: ${state.selectedMeal.dish_name}\n` +
    `⏱ *Time*: ${state.selectedMeal.prep_time_minutes} mins\n` +
    `💡 *Ops Note*: ${state.selectedMeal.reasoning}\n` +
    `👨‍🍳 *Cook Status*: Audio brief synthesized and dispatched.`;
  await sendTelegramMessage(GROUP_CHAT_ID, groupNotice);

  if (state.audioBuffer) {
    await sendCookVoiceBrief(PLANNER_CHAT_ID, state.audioBuffer, `निर्देश: ${state.selectedMeal.dish_name}`);
  }

  console.log('✅ [Concierge Agent]: Complete.');
  return state;
}

function routeAfterFinance(state) {
  return state.budgetApproved ? 'cook_liaison' : 'concierge';
}

const workflow = new StateGraph(RasoiState)
  .addNode('kitchen_ops', kitchenOpsNode)
  .addNode('finance', financeNode)
  .addNode('cook_liaison', cookLiaisonNode)
  .addNode('concierge', conciergeNode)
  .addEdge(START, 'kitchen_ops')
  .addEdge('kitchen_ops', 'finance')
  .addConditionalEdges('finance', routeAfterFinance, {
    concierge: 'concierge',
    cook_liaison: 'cook_liaison'
  })
  .addEdge('cook_liaison', 'concierge')
  .addEdge('concierge', END);

export const rasoiApp = workflow.compile();
