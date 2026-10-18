/**
 * 狼人杀的开局设置：谁上桌、每个座位由谁驱动。游戏库里的「开局设置」面板读写它，开局时按它入座。
 *   - 存在 DSH 主目录的 dsh-game/werewolf-setup.json，只有这一份。旧版插件设置里的 wolfModel / wolfSeats 只在还没有这个文件时搬过来
 *   - 驱动方式：default（用默认模型）、off（不上桌）、codex、claude-code、或 DSH 里配的模型（provider/model）
 *   - 大肥鱼的座位固定是她本人，不在这里设置
 *   - checkSetup()：每个座位能不能用、人数对不对。面板显示它，开局时也用它拦住
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHARACTERS, OWNER, OWNER_ID } from './characters.js';
import { clientStatus, type ClientStatus } from './local-clients.js';
import { BOARDS, MAX_PLAYERS, MIN_PLAYERS, boardText } from './rules.js';

export type SeatDriver = 'default' | 'off' | 'codex' | 'claude-code' | string;

export interface WolfSetup {
  /** 「默认模型」指的模型（provider/model） */
  defaultModel: string;
  /** 角色 id → 驱动方式（大肥鱼不在里面） */
  seats: Record<string, SeatDriver>;
  /** 主人自己也上桌 */
  owner: boolean;
}

export interface ModelOption {
  /** provider/model */
  id: string;
  provider: string;
  providerName: string;
  name: string;
}

/** 列出 DSH 里配好的模型（宿主的 llm 服务）；拿不到返回 null（那就不按列表拦） */
export type ListModels = () => Promise<ModelOption[] | null>;

export interface SeatCheck {
  ok: boolean;
  /** 界面上显示的状态：「deepseek-flash」「Codex · 已登录 ChatGPT」「不上桌」 */
  label: string;
  /** 不能用的原因 */
  problem?: string;
}

export interface SetupCheck {
  setup: WolfSetup;
  characters: { id: string; name: string; color: string }[];
  /** DSH 里配好的模型；null 是没拿到列表 */
  models: ModelOption[] | null;
  codex: ClientStatus;
  seats: Record<string, SeatCheck>;
  players: number;
  /** 这局的身份组合（文字）；人数不对时是 null */
  board: string | null;
  /** 开不了局的原因；没问题是 null */
  problem: string | null;
}

export interface LegacySettings {
  model: string;
  seats: string;
}

export const SELF_ID = 'deepseek';
const FILE = path.join(process.env.DSH_HOME ?? os.tmpdir(), 'dsh-game', 'werewolf-setup.json');

/** 旧版设置的「gpt=codex, kimi=provider/model」 */
function parseLegacy(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[,，\n]/)) {
    const [id, how] = part.split('=').map((s) => s.trim());
    if (id && how) out[id.toLowerCase()] = how;
  }
  return out;
}

function normalize(raw: Partial<WolfSetup>, fallbackModel: string): WolfSetup {
  const seats: Record<string, SeatDriver> = {};
  for (const c of CHARACTERS) {
    if (c.id === SELF_ID) continue;
    const how = raw.seats?.[c.id];
    seats[c.id] = typeof how === 'string' && how.trim() ? how.trim() : 'default';
  }
  return { defaultModel: raw.defaultModel?.trim() || fallbackModel, seats, owner: raw.owner === true };
}

/** 读设置：有文件读文件，没有就从旧版设置搬过来 */
export function loadSetup(legacy: LegacySettings): WolfSetup {
  try {
    return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<WolfSetup>, legacy.model);
  } catch {
    return normalize({ defaultModel: legacy.model, seats: parseLegacy(legacy.seats) }, legacy.model);
  }
}

export function saveSetup(setup: Partial<WolfSetup>, legacy: LegacySettings): WolfSetup {
  const clean = normalize(setup, legacy.model);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

/** 上桌的角色 id（大肥鱼一定在） */
export function seated(setup: WolfSetup): string[] {
  const ais = CHARACTERS.filter((c) => c.id === SELF_ID || setup.seats[c.id] !== 'off').map((c) => c.id);
  return setup.owner ? [...ais, OWNER_ID] : ais;
}

/** 一个座位实际用的驱动：default 换成默认模型 */
export function driverOf(setup: WolfSetup, id: string): SeatDriver {
  const how = setup.seats[id] ?? 'default';
  return how === 'default' ? setup.defaultModel : how;
}

/** 座位上显示的驱动名 */
export function driverLabel(how: SeatDriver): string {
  if (how === 'codex') return 'Codex';
  if (how === 'claude-code') return 'Claude Code';
  return how.split('/').pop() ?? how;
}

export async function checkSetup(setup: WolfSetup, listModels: ListModels): Promise<SetupCheck> {
  const usesClaude = Object.values(setup.seats).includes('claude-code');
  const [models, codex, claude] = await Promise.all([
    listModels().catch(() => null),
    clientStatus('codex'),
    usesClaude ? clientStatus('claude-code') : Promise.resolve(null),
  ]);
  const known = new Set(models?.map((m) => m.id));
  const providers = new Set(models?.map((m) => m.provider));

  const checkModel = (model: string): SeatCheck => {
    const label = driverLabel(model);
    const slash = model.indexOf('/');
    if (slash <= 0) return { ok: false, label, problem: `「${model}」不是 DSH 里的模型（要写成 provider/model）` };
    // 没拿到模型列表时不拦：开局后真出错会标在座位上
    if (!models || known.has(model)) return { ok: true, label };
    const provider = model.slice(0, slash);
    return { ok: false, label, problem: providers.has(provider) ? `DSH 的「${provider}」里没有 ${label} 这个模型` : `DSH 里没有配「${provider}」，先去 DSH 设置的「模型」里加上` };
  };

  const seats: Record<string, SeatCheck> = {};
  for (const c of CHARACTERS) {
    if (c.id === SELF_ID) {
      seats[c.id] = { ok: true, label: '大肥鱼本人' };
      continue;
    }
    const how = setup.seats[c.id] ?? 'default';
    if (how === 'off') seats[c.id] = { ok: true, label: '不上桌' };
    else if (how === 'codex') seats[c.id] = codex.loggedIn ? { ok: true, label: `Codex · ${codex.detail}` } : { ok: false, label: 'Codex', problem: codex.detail };
    else if (how === 'claude-code') seats[c.id] = claude?.loggedIn ? { ok: true, label: `Claude Code · ${claude.detail}` } : { ok: false, label: 'Claude Code', problem: claude?.detail ?? 'Claude Code 不可用' };
    else seats[c.id] = checkModel(driverOf(setup, c.id));
  }

  seats[OWNER_ID] = { ok: true, label: setup.owner ? '你自己' : '不上桌' };
  const ids = seated(setup);
  const players = ids.length;
  const board = BOARDS[players] ? boardText(BOARDS[players]) : null;
  const broken = CHARACTERS.filter((c) => !seats[c.id].ok);
  let problem: string | null = null;
  if (players < MIN_PLAYERS) problem = `现在只有 ${players} 人上桌，至少要 ${MIN_PLAYERS} 人`;
  else if (players > MAX_PLAYERS) problem = `最多 ${MAX_PLAYERS} 人上桌`;
  else if (broken.length) problem = broken.map((c) => `${c.name}：${seats[c.id].problem}`).join('；');

  return {
    setup,
    characters: [...CHARACTERS, OWNER].map((c) => ({ id: c.id, name: c.name, color: c.color })),
    models,
    codex,
    seats,
    players,
    board,
    problem,
  };
}
