import { generateCookAudio } from './connectors/gnani.js';
import { sendTelegramMessage, sendCookVoiceBrief, PLANNER_CHAT_ID } from './connectors/telegram.js';

async function run() {
  console.log('1. Testing Telegram text message...');
  await sendTelegramMessage(PLANNER_CHAT_ID, '🚀 *RasoiOS Live Engine Initialized*.\nTesting Gnani Voice Pipeline...');

  console.log('2. Generating Indic audio brief with Gnani TTS (Nalini - Hindi)...');
  const sampleHindiBrief = 'नमस्ते। आज सुबह के नाश्ते में रवा उपमा बनाना है। कढ़ी पत्ता और राई का तड़का लगाएं।';
  const audioBuffer = await generateCookAudio(sampleHindiBrief, 'hi-IN', 'Nalini');

  console.log('3. Streaming synthesized voice note to Cook/Telegram...');
  const sendRes = await sendCookVoiceBrief(PLANNER_CHAT_ID, audioBuffer, 'आज का नाश्ता: रवा उपमा (Cook Brief)');

  console.log('Result:', sendRes.ok ? '✅ Voice memo delivered successfully!' : sendRes);
}

run().catch(console.error);
