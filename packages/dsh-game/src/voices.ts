/**
 * 豆包音色和密钥的对应（不碰网络、不碰 node，设置页也能用）。
 *   - 新版控制台的 API Key：2.0 音色（…_uranus_bigtts）、复刻音色（S_ 开头）
 *   - 旧版控制台的 APP ID + Access Token：1.0 音色（其余）
 * 默认音色和狼人杀的角色、法官都是 2.0 音色，所以一般只要新版控制台的一个 API Key。
 */

/** 大肥鱼的默认音色：萌丫头 2.0 */
export const DEFAULT_VOICE = 'zh_female_mengyatou_uranus_bigtts';

/** 这个音色要新版控制台的 API Key（不是就要旧版的 APP ID + Access Token） */
export function usesNewConsole(voice: string): boolean {
  return voice.startsWith('S_') || voice.includes('_uranus_');
}
