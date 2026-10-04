const BOT_TOKEN = '8737542547:AAFcM1UyXAUxDIV7iUOMgsvGAqqmHrVmDEk';
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

export const PLANNER_CHAT_ID = '8676103060';
export const GROUP_CHAT_ID = '-1003938516465';

export async function sendTelegramMessage(chatId = PLANNER_CHAT_ID, text) {
  const res = await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
  return res.json();
}

export async function sendDecisionPrompt(chatId = PLANNER_CHAT_ID, text, actionCallbackMap) {
  const inline_keyboard = Object.entries(actionCallbackMap).map(([label, callback_data]) => [
    { text: label, callback_data }
  ]);
  const res = await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard }
    })
  });
  return res.json();
}

export async function sendCookVoiceBrief(chatId = PLANNER_CHAT_ID, audioBuffer, caption = 'आज का खाना निर्देश') {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('caption', caption);
  formData.append('voice', new Blob([audioBuffer], { type: 'audio/wav' }), 'brief.wav');
  const res = await fetch(`${BASE_URL}/sendVoice`, { method: 'POST', body: formData });
  return res.json();
}
