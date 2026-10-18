/**
 * 把一个时刻写成交给她的文字（平台层：不出现任何游戏专属的词，游戏专属的内容都来自时刻本身）。
 */

import type { GameActionSpec, Moment, PendingPrompt } from './types.js';

const PARAM_NAMES = { index: 'index', name: 'name', text: 'text' } as const;

/** 【你现在能做的事】：每件事一行，写明 action 和要填的参数 */
export function formatActions(actions: GameActionSpec[]): string {
  return [
    '【你现在能做的事】（用 game_act）',
    ...actions.map((a) => {
      const params = Object.entries(a.params ?? {}).map(([k, how]) => `${PARAM_NAMES[k as keyof typeof PARAM_NAMES]}=${how}`);
      return `- action=${a.action}${params.length ? `，${params.join('，')}` : ''}：${a.description}`;
    }),
  ].join('\n');
}

export function formatPrompt(p: PendingPrompt): string {
  return [`【游戏在等你：${p.label}】${p.detail ? `\n${p.detail}` : ''}`, ...p.choices.map((c, i) => `${i + 1}. ${c}`)].join('\n');
}

export function formatMoment(moment: Moment): string {
  const parts: string[] = [`【时刻】#${moment.seq}`, `【进度】${moment.where}`];
  if (moment.skipped) parts.push(`【快进的部分】（快进了 ${moment.skipped.count} 句）\n${moment.skipped.summary}`);
  if (moment.onStage.length) parts.push(`【在场】${moment.onStage.join('、')}`);
  if (moment.lines.length) parts.push(`【发生的事】（${moment.lines.length} 句）\n${moment.lines.join('\n')}`);
  for (const note of moment.notes) parts.push(`【说明】${note}`);
  if (moment.prompt) parts.push(formatPrompt(moment.prompt));
  if (moment.actions?.length) parts.push(formatActions(moment.actions));
  if (moment.reason === 'disconnected') parts.push('【状态】游戏没有连接。');
  if (moment.reason === 'timeout' && !moment.lines.length && !moment.prompt) parts.push('【状态】这段时间游戏没有新内容。');
  if (moment.reason === 'owner') parts.push('【状态】主人跟你说话了，游戏先停在这里。');
  return parts.join('\n\n');
}
