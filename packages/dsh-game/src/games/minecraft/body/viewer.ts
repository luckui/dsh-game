/**
 * 网页画面：prismarine-viewer 用她的机器人收到的世界数据在浏览器里画 3D（第三人称环绕，能看到她自己）。
 * 插件「游戏」标签页和直播舞台直接嵌这个网页，不用开 Minecraft 客户端。
 * 它的贴图做到 1.21.4，所以服务器用 1.21.4（更新的版本方块会贴错图）。
 */
import Module from 'node:module';

export interface ViewOptions {
  port: number;
  firstPerson: boolean;
  viewDistance: number;
}

let stubbed = false;
/** prismarine-viewer 的服务端顺带 require 了原生的 canvas（只给浏览器里的名牌用），服务端用不到：给一个空的替身 */
function stubCanvas(): void {
  if (stubbed) return;
  stubbed = true;
  const mod = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = mod._load;
  mod._load = function (request: string, ...rest: unknown[]) {
    if (request === 'canvas') {
      class Stub {}
      return { Canvas: Stub, Image: Stub, createCanvas: () => ({ getContext: () => ({}) }) };
    }
    return load.call(this, request, ...rest);
  };
}

/** 给这个机器人开网页画面（换了机器人就关掉旧的再开） */
export function openView(bot: any, options: ViewOptions): void {
  stubCanvas();
  bot.viewer?.close?.();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const viewer = require('prismarine-viewer/lib/mineflayer') as (bot: unknown, options: object) => void;
  viewer(bot, { port: options.port, firstPerson: options.firstPerson, viewDistance: options.viewDistance });
}

export function closeView(bot: any): void {
  bot?.viewer?.close?.();
}
