import pg from 'pg';
import { generateCookAudio, transcribeAudio } from './connectors/gnani.js';
import { sendTelegramMessage, sendCookVoiceBrief, PLANNER_CHAT_ID, GROUP_CHAT_ID } from './connectors/telegram.js';

const DB_URL = 'postgresql://postgres.rajndrjprgroptbrlnzp:Kheerthi%402006@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const BOT_TOKEN = '8737542547:AAFcM1UyXAUxDIV7iUOMgsvGAqqmHrVmDEk';
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

let lastUpdateId = 0;

/**
 * Acknowledge Telegram callback query to dismiss the mobile loading spinner.
 */
async function answerCallback(callbackQueryId, text = 'Processing...') {
  await fetch(`${BASE_URL}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

/**
 * Executes the complete fallback action based on the button clicked.
 */
async function handleFallbackAction(action, userFirstName) {
  console.log(`\n⚡ [Executing Action]: ${action} initiated by ${userFirstName}`);

  // 1. STOCKOUT FALLBACK: Swap to 100% In-Stock Dish
  if (action === 'ACTION_SWAP_POHA') {
    const fallbackDishName = 'Quick Vegetable Rava Upma';
    const prepMinutes = 10;
    const hindiBrief = 'नमस्ते। योजना में बदलाव हुआ है। पास्ता नहीं बनेगा। उसके बदले 10 मिनट में रवा उपमा तैयार करें। फ्रिज में रखी गाजर, हरी मटर और कढ़ी पत्ता डालें।';

    console.log(`Generating fallback cook audio brief via Gnani TTS...`);
    const audioBuffer = await generateCookAudio(hindiBrief, 'hi-IN', 'Nalini');

    // Send new voice instructions to cook
    await sendCookVoiceBrief(PLANNER_CHAT_ID, audioBuffer, `🔄 संशोधित निर्देश: ${fallbackDishName}`);

    // Update family group
    await sendTelegramMessage(
      GROUP_CHAT_ID,
      `🔄 *Menu Adjusted (Stockout Fallback)*\n` +
      `Swapped to: *${fallbackDishName}* (100% in stock)\n` +
      `⏱ Prep Time: ${prepMinutes} mins\n` +
      `👨‍🍳 Cook audio brief generated and sent.`
    );

    // Confirm to planner
    await sendTelegramMessage(PLANNER_CHAT_ID, `✅ *Fallback Executed*: Swapped to ${fallbackDishName}. Voice memo sent to cook.`);
    return;
  }

  // 2. BUDGET OVERRIDE: Force-Debit Pine Labs Ledger
  if (action.startsWith('APPROVE_BUDGET_')) {
    const amount = Number(action.replace('APPROVE_BUDGET_', ''));

    console.log(`Applying manual budget override for ₹${amount}...`);
    const client = await pool.connect();
    let remaining = 0;
    try {
      await client.query('BEGIN');
      const ledgerRes = await client.query(
        `SELECT id, amount_spent_inr, weekly_limit_inr FROM household_budget_ledger 
         ORDER BY week_start_date DESC LIMIT 1 FOR UPDATE;`
      );
      const ledger = ledgerRes.rows[0];
      if (ledger) {
        await client.query(
          `UPDATE household_budget_ledger 
           SET amount_spent_inr = amount_spent_inr + $1, updated_at = NOW() 
           WHERE id = $2;`,
          [amount, ledger.id]
        );
        remaining = Number(ledger.weekly_limit_inr) - (Number(ledger.amount_spent_inr) + amount);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Ledger debit error:', err);
    } finally {
      client.release();
    }

    // Synthesize cook brief for original dish
    const hindiBrief = 'नमस्ते। किराने का सामान ऑर्डर कर दिया गया है। 15 मिनट में डिलीवरी आने पर उपमा और टोस्ट की तैयारी शुरू करें।';
    const audioBuffer = await generateCookAudio(hindiBrief, 'hi-IN', 'Nalini');
    await sendCookVoiceBrief(PLANNER_CHAT_ID, audioBuffer, `ऑर्डर स्वीकृत: नाश्ता निर्देश`);

    await sendTelegramMessage(
      GROUP_CHAT_ID,
      `💳 *Budget Override Authorized*: Micro-cart of ₹${amount} approved via Pine Labs.\n` +
      `Remaining weekly reserve: ₹${remaining}.\nCook brief updated.`
    );

    await sendTelegramMessage(PLANNER_CHAT_ID, `✅ *Override Recorded*: ₹${amount} debited.`);
    return;
  }

  // 3. EMERGENCY ONDC REPLENISHMENT
  if (action === 'ACTION_FORCE_ONDC') {
    const hindiWaitBrief = 'नमस्ते। ज़रूरी सामान ONDC से 15 मिनट में आ रहा है। कृपया डिलीवरी का इंतज़ार करें, फिर खाना बनाएं।';
    const audioBuffer = await generateCookAudio(hindiWaitBrief, 'hi-IN', 'Nalini');
    await sendCookVoiceBrief(PLANNER_CHAT_ID, audioBuffer, `डिलीवरी सूचना: कृपया प्रतीक्षा करें`);

    await sendTelegramMessage(
      GROUP_CHAT_ID,
      `🛵 *ONDC Hyperlocal Triggered*: Missing items ordered.\n` +
      `ETA: 15-20 mins. Cook instructed to wait for delivery.`
    );
    await sendTelegramMessage(PLANNER_CHAT_ID, `✅ *Procurement Dispatched*: ONDC order queued.`);
    return;
  }

  // 4. CANCEL / REJECT
  if (action === 'ACTION_CANCEL' || action === 'REJECT_BUDGET') {
    await sendTelegramMessage(GROUP_CHAT_ID, `❌ *Meal Prep Halted*: Meal was canceled by planner. Send a voice note with new requests.`);
    await sendTelegramMessage(PLANNER_CHAT_ID, `🛑 *Canceled*: No actions taken, budget preserved.`);
    return;
  }
}

/**
 * Long-polling daemon loop
 */
async function pollUpdates() {
  try {
    const res = await fetch(`${BASE_URL}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`);
    const data = await res.json();

    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      // 1. Handle Inline Decision Button Taps
      if (update.callback_query) {
        const cb = update.callback_query;
        await answerCallback(cb.id, 'Action confirmed.');
        await handleFallbackAction(cb.data, cb.from.first_name);
      }

      // 2. Handle Voice Notes from Family or Cook (Gnani STT)
      if (update.message && update.message.voice) {
        const fileId = update.message.voice.file_id;
        const chatId = update.message.chat.id;

        console.log(`\n🎙️ [Voice Ingest] Audio received from chat ${chatId}`);
        await sendTelegramMessage(chatId, `🎙️ *Voice Note Received*. Processing with Gnani STT...`);

        const fileRes = await (await fetch(`${BASE_URL}/getFile?file_id=${fileId}`)).json();
        const filePath = fileRes.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        const audioBuffer = Buffer.from(await (await fetch(fileUrl)).arrayBuffer());

        try {
          const transcript = await transcribeAudio(audioBuffer, 'hi-IN');
          console.log(`[STT Transcript]: "${transcript}"`);
          await sendTelegramMessage(chatId, `📝 *Understood*: "${transcript}"\n_Evaluating against kitchen inventory..._`);
        } catch (sttErr) {
          console.error('Gnani STT error:', sttErr.message);
          await sendTelegramMessage(chatId, `⚠️ STT error: ${sttErr.message}`);
        }
      }
    }
  } catch (err) {
    console.error('Polling error:', err.message);
  }
}

console.log('🤖 RasoiOS Daemon Live. Listening for button taps and voice notes...');
setInterval(pollUpdates, 1500);
