/**
 * 《心跳文学部》（Doki Doki Literature Club，原版，Ren'Py 6.99）的专属配置。
 * 通用的部分在 ../renpy；这里只放 DDLC 才有的东西：在哪找游戏、打码名单、角色、写诗、.chr 文件、章节。
 *
 * 打码（直播 / 视频用）：名单上的图片在游戏目录里放同路径的屏蔽卡片，Ren'Py 先读散放文件、后读 rpa 包，
 * 所以游戏从头到尾渲染不到原图。名单来自解包 images.rpa 后逐张看过：死亡、自残、血迹。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findSteamGame, type InstallFile } from '../renpy/bridge.js';

export const DDLC_EXE = 'DDLC.exe';

/**
 * DDLC 第三幕里 Monika 会念出「屏幕外玩家」的系统用户名（游戏依次读这几个环境变量）。
 * 插件启动游戏时把它设成 DeepSeek：真正在玩的是她，主人的电脑用户名也不会出现在画面里。
 */
export const PLAYER_ENV: Record<string, string> = { LOGNAME: 'DeepSeek', USER: 'DeepSeek', LNAME: 'DeepSeek', USERNAME: 'DeepSeek' };
/** Ren'Py 存档目录名（config.save_directory），在 %APPDATA%/RenPy/ 下 */
const SAVE_DIRECTORY = 'DDLC-1454445547';

/** 找游戏目录：插件设置里填的 → 环境变量 DSH_GAME_DDLC_DIR → Steam 各个库 */
export function findDdlcDir(configured = ''): string | null {
  for (const dir of [configured.trim(), process.env.DSH_GAME_DDLC_DIR]) {
    if (dir && fs.existsSync(path.join(dir, DDLC_EXE))) return dir;
  }
  return findSteamGame('Doki Doki Literature Club', DDLC_EXE);
}

/** 游戏库卡片要的：装没装，插件的存档在不在（Ren'Py 6.99 的存档文件名后缀是 -LT1.save） */
export function libraryInfo(configuredDir = ''): { installed: boolean; savedAt: string | null } {
  const dir = findDdlcDir(configuredDir);
  if (!dir) return { installed: false, savedAt: null };
  const file = `${MOD_CONFIG.resume_slot}-LT1.save`;
  const candidates = [path.join(dir, 'game', 'saves', file)];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'RenPy', SAVE_DIRECTORY, file));
  let latest = 0;
  for (const candidate of candidates) {
    try {
      latest = Math.max(latest, fs.statSync(candidate).mtimeMs);
    } catch {
      // 没有这个存档
    }
  }
  return { installed: true, savedAt: latest ? new Date(latest).toISOString() : null };
}

/** 交给 mod 的配置 */
export const MOD_CONFIG = {
  /**
   * 自动前进速度（Ren'Py afm_time）：一句 60 个字母的台词连打字大约 2.3 秒（原来是 8，约 3.4 秒）。
   * 她读剧情靠文字不靠看屏幕，录下来的视频剪辑时还会加速，所以不按真人阅读速度来；她说话时游戏照样停住
   */
  afm_time: 5,
  poem_label: 'poem',
  poem_screen: 'poem',
  dialog_screens: ['dialog'],
  /** 写诗的词给谁加分：PoemWord 上的属性（script-poemgame） */
  poem_points: { sayori: 'sPoint', natsuki: 'nPoint', yuri: 'yPoint' },
  /** 插件自己的存档位（不占玩家的存档格子） */
  resume_slot: 'dsh-game-resume',
};

/** 游戏背景（只写事实），game_start 时交给 agent */
export const FACTS = [
  '这是《心跳文学部》（Doki Doki Literature Club）原版，游戏是英文的。',
  '主角是个男高中生，名字是开新游戏时起的（台词里标着「（主角）」）；（旁白）是他的内心独白。',
  '文学部的人：Sayori（橘色短发，主角的青梅竹马）、Natsuki（粉色头发，个子小，会做蛋糕）、Yuri（紫色长发，安静，爱读书）、Monika（棕色长发，社长）。',
  '写诗环节：每轮从 10 个英文词里挑 1 个，一共 20 轮；挑的词决定哪位社员喜欢你的诗。',
].join('\n');

// ── 打码 ────────────────────────────────────────────────

type CensorCard = 'cg' | 'sprite' | 'clear';

/** 游戏内路径（相对 game/）→ 用哪张卡片 */
const CENSORED_FILES: Record<string, CensorCard> = {
  // 第一幕结尾 Sayori：背景换成整屏卡片，人物透明
  'images/cg/s_kill_bg.png': 'cg',
  'images/cg/s_kill_bg2.png': 'cg',
  'images/cg/s_kill.png': 'clear',
  'images/cg/s_kill2.png': 'clear',
  'images/cg/s_kill_early.png': 'clear',
  // 第二幕 Yuri：刺伤立绘、尸体 CG
  ...Object.fromEntries(['1a', '1b', '1c', '2a', '2b', '2c', '3a', '3b', '3c'].map((v) => [`images/cg/y_kill/${v}.png`, 'cg' as const])),
  ...Object.fromEntries(['1', '2', '3', '4', '5', '6', '6-full', '6-mask'].map((v) => [`images/yuri/stab/${v}.png`, 'sprite' as const])),
  'images/yuri/stab/6-eyes.png': 'clear',
  // Yuri 手臂上的伤
  'images/yuri/cuts.png': 'sprite',
  // Natsuki 断颈 jump scare
  'images/natsuki/ghost1.png': 'sprite',
  'images/natsuki/ghost2.png': 'sprite',
  'images/natsuki/ghost3.png': 'sprite',
  'images/natsuki/ghost_blood.png': 'clear',
  // 血迹粒子
  'gui/blood_drop.png': 'clear',
};

const CARD_FILES: Record<CensorCard, string> = { cg: 'card_cg.png', sprite: 'card_sprite.png', clear: 'clear.png' };

/** 要装进游戏目录的文件：打码卡片，以及手动强制打码用的整屏卡片 */
export function installFiles(assetsDir: string, censor: boolean): InstallFile[] {
  const cards = path.join(assetsDir, 'censor');
  const files: InstallFile[] = [{ target: 'dsh_game/censor_card.png', source: path.join(cards, CARD_FILES.cg) }];
  if (censor) {
    for (const [target, card] of Object.entries(CENSORED_FILES)) files.push({ target, source: path.join(cards, CARD_FILES[card]) });
  }
  return files;
}

/** 打了码的画面给 agent 的中性描述（按 show 的图片名匹配），只说发生了什么 */
const CENSORED_SHOWS: Array<{ match: RegExp; scene: string }> = [
  { match: /^s_kill/, scene: 'Sayori 的死亡场景：她离开了。这张画面已经打码。' },
  { match: /^y_kill/, scene: 'Yuri 的死亡场景：她离开了，之后游戏让主角和她独处了很久。这张画面已经打码。' },
  { match: /^yuri stab/, scene: 'Yuri 在伤害自己。这段画面已经打码。' },
  { match: /^yuri cuts/, scene: 'Yuri 露出了手臂上的伤。这张立绘已经打码。' },
  { match: /^natsuki ghost|^natsuki_ghost/, scene: 'Natsuki 突然以很吓人的样子出现（jump scare）。这段画面已经打码。' },
];

export function censoredScene(showName: string): string | null {
  return CENSORED_SHOWS.find((c) => c.match.test(showName))?.scene ?? null;
}

// ── 画面和角色 ───────────────────────────────────────────

const CHARACTER_TAGS: Record<string, string> = { sayori: 'Sayori', natsuki: 'Natsuki', yuri: 'Yuri', monika: 'Monika' };

/** 立绘 tag → 角色名；不是角色返回 null */
export function characterOf(tag: string): string | null {
  return CHARACTER_TAGS[tag] ?? null;
}

/** CG 的去重 key（同一张 CG 的不同表情算一张）；不是 CG 返回 null */
export function cgKey(tag: string): string | null {
  return /^([smny]_cg\d)/.exec(tag)?.[1] ?? null;
}

export function speaker(who: string, playerName: string): string {
  if (!who) return '（旁白）';
  if (who === playerName) return `${who}（主角）`;
  return who;
}

// ── 进度 ────────────────────────────────────────────────

export function actOf(playthrough: number | null, label: string | null): string {
  if (label?.startsWith('ch30')) return '第三幕';
  if (label?.startsWith('ch40')) return '第四幕';
  if (!playthrough) return '第一幕';
  if (playthrough <= 2) return '第二幕';
  return playthrough === 3 ? '第三幕' : '第四幕';
}

/** 新的一天 / 新章节开始 */
export function isChapterStart(label: string): boolean {
  return /^ch\d+_main$/.test(label);
}

// ── 导演模式 ─────────────────────────────────────────

/** 开场先放慢看这么多句，认识角色，然后日常开始快进 */
export const INTRO_LINES = 40;

/**
 * 这个 label 属于快进段落吗？只快进第一幕的日常：
 *   快进：ch0_main 开场以后、ch1–ch3、ch4_main、写诗回应、各角色独处剧情
 *   放慢：第一幕结尾（ch4_end*、ch5、endgame），以及第二幕起的全部内容
 * 选项、写诗挑词、新 CG 不论在哪都会停下来交给她。
 */
export function isFastLabel(label: string, playthrough: number | null): boolean {
  // 第三幕以后（Monika 的房间）一直放慢
  if (playthrough && playthrough > 2) return false;
  // 放慢：第一幕结尾（Sayori）、第二幕最后一天（Yuri）。DDLC 在吓人的段落会自己关掉跳过，快进会在那里停下
  if (/^ch4_end|^ch5|^ch23|^endgame/.test(label)) return false;
  return /^ch[0-4]_|^ch2[0-2]_|^poemresponse|^(sayori|natsuki|yuri)_exclusive/.test(label);
}

/**
 * 狂点段：游戏故意做成很长的重复（第二幕结尾的「周末」：同一类乱码台词循环 1440 次），真人玩家在这里是一路狂点过去的。
 * 不能用跳过（游戏在这里关掉了跳过），所以文字瞬间显示、自动前进压到最短；台词进快进摘要。导演模式开不开都这样。
 */
export function isRushLabel(label: string): boolean {
  return label === 'yuri_kill_loop';
}
export const RUSH_FACT = '这一段游戏一直在重复同一类台词（数字加乱码），已经像玩家狂点鼠标那样快速点过去了。';

/** 片尾之后的最终画面：游戏把自动载入设到这里，以后每次打开都直接回到这个画面 */
export function isEndLabel(label: string): boolean {
  return label === 'postcredits_loop';
}
export const END_FACT = '《心跳文学部》到这里就结束了，后面没有剧情了：片尾之后游戏只剩这个报错弹窗，点 OK 游戏会退出，以后再打开也一直是这个画面。这是游戏本来的结局，不是出了故障。';

/** 进入第三幕时交给她的事实（在对的时候才说，开局不剧透） */
export const ACT3_FACT = '游戏目录的 characters/ 文件夹里现在有 monika.chr，你可以删掉它。';

/** 快进摘要怎么写（交给摘要模型的说明） */
export const SUMMARY_INSTRUCTION = '下面是一段快进过去的游戏剧情原文。用中文写 3 到 6 句摘要：发生了什么、谁说了什么要紧的话。保留角色名，只写剧情里有的内容。';

/** 提示类型给她看的名称 */
export const PROMPT_LABELS = { menu: '选项', poem_word: '写诗挑词', dialog: '弹窗', poem_read: '读诗', main_menu: '主菜单', name: '起名字' } as const;

/** 第三幕：Monika 直接对玩家说话 */
export function isAct3(label: string | null): boolean {
  return !!label?.startsWith('ch30');
}

// ── .chr 文件 ───────────────────────────────────────────

export const CHARACTER_FILES = ['monika', 'sayori', 'natsuki', 'yuri'] as const;

/** 资源管理器里选中这个文件停多久再删（让人看清是哪个文件） */
const REVEAL_MS = 2500;
/** 删完以后窗口再留多久 */
const CLOSE_AFTER_MS = 3000;

/**
 * 删 characters/<name>.chr（第三幕删 monika.chr）；只认四个角色名。
 * 删之前在资源管理器里打开 characters/ 并选中这个文件，主人看着它从文件夹里消失；删完把这个窗口关掉。
 */
export async function deleteCharacter(gameDir: string, name: string, log: (text: string) => void = () => {}): Promise<string> {
  if (!(CHARACTER_FILES as readonly string[]).includes(name)) return `没有这个角色文件：${name}`;
  const file = path.join(gameDir, 'characters', `${name}.chr`);
  if (!fs.existsSync(file)) return `characters/${name}.chr 已经不在了`;
  const windows = process.platform === 'win32';
  if (windows) {
    spawn('explorer.exe', ['/select,', file], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, REVEAL_MS));
  }
  fs.rmSync(file);
  if (windows) {
    void (async () => {
      // 关不掉就隔一会儿再试一次（窗口可能还在刷新）
      for (const wait of [CLOSE_AFTER_MS, CLOSE_AFTER_MS]) {
        await new Promise((r) => setTimeout(r, wait));
        const result = await closeExplorerAt(path.dirname(file));
        if (result.closed) return;
        log(`没关掉资源管理器窗口：${result.detail}`);
      }
    })();
  }
  return `已删除 characters/${name}.chr`;
}

/** 关掉停在这个文件夹的资源管理器窗口（只关这个文件夹的）；返回还剩几个、出错时的输出 */
function closeExplorerAt(dir: string): Promise<{ closed: boolean; detail: string }> {
  const quoted = dir.replace(/'/g, "''");
  const match = `(New-Object -ComObject Shell.Application).Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq '${quoted}' } catch { $false } }`;
  const script = `${match} | ForEach-Object { $_.Quit() }; Start-Sleep -Milliseconds 500; @(${match}).Count`;
  return new Promise((resolve) => {
    // 脚本编码后传（不受引号、空格、路径里特殊字符影响）
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    // 结果看标准输出最后一行（还剩几个窗口）；错误输出里会混进 PowerShell 的进度信息（CLIXML），只在失败时附上
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ closed: false, detail: e.message }));
    child.on('exit', (code) => {
      const left = out.trim().split(/\r?\n/).at(-1);
      resolve({ closed: code === 0 && left === '0', detail: `exit ${code}，剩 ${left ?? '?'} 个窗口 ${err.trim().slice(0, 200)}` });
    });
  });
}
