/**
 * 模型驱动的玩家：把座位看到的一切和这一步要做的事交给模型，要回一个 JSON 决定。
 * 模型通过 DSH 的模型服务调用（用户在 DSH 里配了哪些模型，座位就能用哪些）。
 */

import { ROLE_NAMES } from './rules.js';
import type { Brain, Decision, DecisionRequest, SeatView } from './engine.js';

/** 调一次模型：system + user → 文字 */
export type Complete = (model: string, system: string, user: string, signal?: AbortSignal) => Promise<string>;

/** 每种决定要的 JSON 字段 */
const FORMAT: Record<DecisionRequest['kind'], string> = {
  wolf_chat: '{"text": "对狼队友说的话（40 字以内）", "inner": "你的真实想法（30 字以内）"}',
  wolf_kill: '{"target": 要杀的座位号, "inner": "为什么（30 字以内）"}',
  seer_check: '{"target": 要查验的座位号, "inner": "为什么（30 字以内）"}',
  witch: '{"save": true 或 false（用不用解药）, "target": 要毒的座位号或 null, "inner": "为什么（30 字以内）"}',
  speech: '{"text": "你的公开发言（40 到 90 字）", "inner": "你的真实想法（30 字以内，只有观众能看到）"}',
  last_words: '{"text": "你的遗言（40 到 80 字）", "inner": "你的真实想法（30 字以内）"}',
  vote: '{"target": 要放逐的座位号或 null（弃票）, "inner": "为什么（30 字以内）"}',
  hunter_shot: '{"target": 要带走的座位号或 null（不开枪）, "inner": "为什么（30 字以内）"}',
};

export function systemPrompt(view: SeatView): string {
  const c = view.character;
  return [
    `你是 ${c.name}（${c.look}），在和另外八位 AI 一起玩狼人杀。`,
    `你的性格：${c.persona}`,
    '发言要符合你的性格和身份目标：好人要找出狼人，狼人要隐藏自己、误导好人。可以撒谎、伪装、跳身份，这是游戏的一部分。',
    '发言用中文口语，像真人在牌桌上说话，可以提到别人的名字和座位号，不要写动作描写和括号旁白。大家都知道你是几号，开口直接说你的看法。',
    '你会拿到一份局面说明和这一步要做的事，只输出一个 JSON 对象，不要输出任何别的文字。',
  ].join('\n');
}

export function userPrompt(view: SeatView, request: DecisionRequest): string {
  return [
    view.text,
    '',
    `【现在轮到你】你是 ${view.no} 号（${ROLE_NAMES[view.role]}）${view.mates ? `，你的狼队友是 ${view.mates}` : ''}。${request.ask}`,
    request.options.length ? `可以选的座位号：${request.options.join('、')}。` : '',
    `输出格式：${FORMAT[request.kind]}`,
  ].filter(Boolean).join('\n');
}

/** 从模型输出里取 JSON（容忍代码块和前后废话） */
export function parseDecision(raw: string): Decision {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { text: raw.trim().slice(0, 200) };
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const target = obj.target === null || obj.target === undefined ? null : Number(String(obj.target).replace(/[^\d]/g, ''));
    return {
      target: target === null || Number.isNaN(target) ? null : target,
      save: obj.save === true,
      text: typeof obj.text === 'string' ? obj.text : undefined,
      inner: typeof obj.inner === 'string' ? obj.inner : undefined,
    };
  } catch {
    return { text: raw.slice(start, end + 1).slice(0, 200) };
  }
}

/** 没给出合法目标时的兜底：需要选人的步骤随机选一个（投票、开枪、毒药允许不选）；随机选了就记一条原因 */
export function fallback(request: DecisionRequest, decision: Decision): Decision {
  const must = request.kind === 'wolf_kill' || request.kind === 'seer_check';
  if (must && (!decision.target || !request.options.includes(decision.target)) && request.options.length) {
    return { ...decision, target: request.options[Math.floor(Math.random() * request.options.length)], fault: decision.fault ?? '没选出合法的座位号，这一步随机选了' };
  }
  return decision;
}

/** 错误写短一点给主人看 */
export const shortError = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 140);

export class LlmBrain implements Brain {
  constructor(private readonly complete: Complete, private readonly model: () => string) {}

  async decide(view: SeatView, request: DecisionRequest): Promise<Decision> {
    const model = this.model();
    let raw = '';
    try {
      raw = await this.complete(model, systemPrompt(view), userPrompt(view, request), AbortSignal.timeout(90_000));
    } catch (err) {
      return fallback(request, { fault: `${model} 调用失败：${shortError(err)}` });
    }
    if (!raw.trim()) return fallback(request, { fault: `${model} 没有回答` });
    return fallback(request, parseDecision(raw));
  }
}
