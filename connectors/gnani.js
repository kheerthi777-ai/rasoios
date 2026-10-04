const GNANI_TTS_KEY = 'vach_1ytE2CY5X2DiL8Jkq6bAcd2MWqWC0WVHwDCICrT8agPWaVSC0K1CEJhM9AdcrLO7IzdocwQDSCecQlFQGA39H7hTuaCDfzXx_fb7d8011a15b138659c2e8b2b31b86ef';
const GNANI_STT_KEY = 'vach_1ytE2CY5X2DiL8Jkq6bAcd2MWqWC0WVHwDCICrT8agPWaVSC0K1CEJhM9AddEG9noJXuiedXdFRCBfqIGvPWw3y7Ji1TSk0l_58c14e2695dce644b1abc0840e601971';
const GNANI_BASE_URL = 'https://api.vachana.ai/api/v1';

export async function generateCookAudio(text, language = 'hi-IN', voice = 'Nalini') {
  const response = await fetch(`${GNANI_BASE_URL}/tts/inference`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key-ID': GNANI_TTS_KEY
    },
    body: JSON.stringify({
      text,
      voice,
      model: 'timbre-v2.5',
      language,
      speed: 1.0,
      audio_config: {
        encoding: 'linear_pcm',
        container: 'wav',
        num_channels: 1,
        sample_rate: 16000,
        sample_width: 2
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gnani TTS failed (${response.status}): ${err}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function transcribeAudio(audioBuffer, language = 'hi-IN') {
  const formData = new FormData();
  formData.append('audio', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
  formData.append('language_code', language);

  const response = await fetch(`${GNANI_BASE_URL}/stt/inference`, {
    method: 'POST',
    headers: { 'X-API-Key-ID': GNANI_STT_KEY },
    body: formData
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gnani STT failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data.transcript || data.text || '';
}
