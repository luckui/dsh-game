/**
 * 豆包语音合成（V3 HTTP 单向流式）：一次请求拿回整句 mp3。
 * 按音色选资源和鉴权：
 *   - 复刻音色（S_ 开头）：seed-icl-2.0，新版控制台的 API Key（X-Api-Key）；固定按中文念（复刻时用的参考音频可能是别的语言）
 *   - 2.0 音色（…_uranus_bigtts）：seed-tts-2.0，新版控制台的 API Key
 *   - 其余（1.0 音色）：seed-tts-1.0，旧版控制台的 APP ID + Access Token
 * 密钥不进配置：通过 DSH 的 credentials 服务按名字取（DOUBAO_TTS_API_KEY / DOUBAO_TTS_APP_ID / DOUBAO_TTS_ACCESS_KEY）。
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_VOICE, usesNewConsole } from './voices.js';

export { DEFAULT_VOICE };
export const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export interface TtsAuth {
  /** 旧版控制台（1.0 音色） */
  appId?: string;
  accessKey?: string;
  /** 新版控制台（2.0 音色、复刻音色） */
  apiKey?: string;
}

interface VoiceRoute {
  resource: string;
  /** 新版控制台的 API Key 还是旧版的 APP ID + Access Token */
  newConsole: boolean;
  additions?: Record<string, unknown>;
}

export function routeOf(voice: string): VoiceRoute {
  if (voice.startsWith('S_')) return { resource: 'seed-icl-2.0', newConsole: true, additions: { explicit_language: 'zh-cn' } };
  if (usesNewConsole(voice)) return { resource: 'seed-tts-2.0', newConsole: true };
  return { resource: 'seed-tts-1.0', newConsole: false };
}

/** 这个音色要的密钥配齐了没有 */
export function canSpeak(auth: TtsAuth, voice: string): boolean {
  return routeOf(voice).newConsole ? !!auth.apiKey : !!(auth.appId && auth.accessKey);
}

/** rate：语速（-50 到 100，0 是正常） */
export async function synthesize(auth: TtsAuth, voice: string, text: string, signal: AbortSignal, rate = 0): Promise<Uint8Array> {
  const route = routeOf(voice);
  const keyHeaders: Record<string, string> = route.newConsole
    ? { 'X-Api-Key': auth.apiKey ?? '' }
    : { 'X-Api-App-Id': auth.appId ?? '', 'X-Api-Access-Key': auth.accessKey ?? '' };
  const res = await fetch(TTS_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...keyHeaders,
      'X-Api-Resource-Id': route.resource,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'dsh-game' },
      req_params: {
        text,
        speaker: voice,
        audio_params: { format: 'mp3', sample_rate: 24000, ...(rate ? { speech_rate: rate } : {}) },
        ...(route.additions ? { additions: JSON.stringify(route.additions) } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`豆包语音 HTTP ${res.status}（${route.resource}）`);
  const chunks: Buffer[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { code?: number; message?: string; data?: string };
    if (msg.data) chunks.push(Buffer.from(msg.data, 'base64'));
    else if (msg.code && msg.code !== 20000000) throw new Error(`豆包语音 ${msg.code} ${msg.message ?? ''}`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** 没有音频时按字数估朗读时长 */
export function estimateSpeechMs(text: string): number {
  return Math.max(1500, text.length * 230);
}
