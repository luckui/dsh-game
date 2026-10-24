/**
 * 狼人杀规则：6~10 人局，屠边（10 人局是九位 AI 加上桌的主人）。人数不同，身份组合不同（BOARDS）：
 *   9 人「预女猎」标准局：3 狼人、预言家、女巫、猎人、3 平民
 *   8 人：3 狼人、预言家、女巫、猎人、2 平民；7 人：2 狼人、预言家、女巫、猎人、2 平民；6 人：2 狼人、预言家、女巫、2 平民
 *   夜晚：狼人商量后刀一人 → 预言家查验一人 → 女巫用药（解药救今晚被刀的人 / 毒药毒一人，同一晚只能用一瓶，只有第一晚能自救）
 *   白天：公布昨晚死讯（第一晚死的人有遗言）→ 从死者下一位开始轮流发言 → 投票放逐（平票 PK：平票的人再发言、其余人重投，再平无人出局）→ 被放逐的人留遗言
 *   猎人：被狼刀死或被放逐时可以开枪带走一人；被毒死不能开枪
 *   胜负：狼人全部出局 → 好人胜；神职（预言家、女巫、猎人）全部出局，或平民全部出局 → 狼人胜
 */

export type Role = 'wolf' | 'seer' | 'witch' | 'hunter' | 'villager';

export const ROLE_NAMES: Record<Role, string> = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', villager: '平民' };

export const GODS: Role[] = ['seer', 'witch', 'hunter'];

/** 每种人数用的身份组合（下标无意义，开局时洗牌） */
export const BOARDS: Record<number, Role[]> = {
  6: ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'],
  7: ['wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
  8: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
  9: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'],
  10: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager', 'villager'],
};
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 10;

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 9 → 九 */
export const cnNumber = (n: number) => CN[n] ?? String(n);

/** 一种身份组合写成文字：「3 个狼人、1 个预言家……」 */
export function boardText(roles: Role[]): string {
  const order: Role[] = ['wolf', 'seer', 'witch', 'hunter', 'villager'];
  return order.map((r) => [r, roles.filter((x) => x === r).length] as const).filter(([, k]) => k > 0).map(([r, k]) => `${k} 个${ROLE_NAMES[r]}`).join('、');
}

/** 给玩家看的规则：按这局的身份组合写 */
export function rulesText(roles: Role[]): string {
  const n = roles.length;
  const has = (r: Role) => roles.includes(r);
  return [
    `这是一局 ${n} 人狼人杀（屠边规则），座位 1 到 ${n} 号。`,
    `身份：${boardText(roles)}。狼人互相认识，其他人只知道自己的身份。`,
    '夜晚：狼人商量后杀一个人；预言家查验一个人是不是狼人；女巫有一瓶解药（救当晚被杀的人）和一瓶毒药（毒死一个人），各只能用一次，同一晚只能用一瓶，只有第一晚能救自己。',
    '白天：法官公布昨晚谁死了（第一晚死的人可以留遗言）；然后从死者的下一位开始，活着的人轮流发言一次；最后所有活着的人投票放逐一人，得票最多的出局并留遗言。',
    '平票时进入 PK：平票的几个人各再发言一次，其余活着的人只在他们中间重新投票；再平票，今天就没有人出局。',
    '谁都可以声称自己是任何身份：狼人常常假装预言家（悍跳），和真预言家对跳，报出假的查验结果。',
    has('hunter') ? '猎人被狼人杀死或被放逐时，可以开枪带走一个人；被毒死不能开枪。' : '',
    `胜负：狼人全部出局，好人胜；神职（${GODS.filter(has).map((r) => ROLE_NAMES[r]).join('、')}）全部出局或平民全部出局，狼人胜。`,
    '死了的人不能再发言、投票或使用技能。',
  ].filter(Boolean).join('\n');
}

/** 随机发身份：返回第 i 号座位（下标 i）的身份 */
export function dealRoles(count: number): Role[] {
  const board = BOARDS[count];
  if (!board) throw new Error(`没有 ${count} 人局的身份组合（只有 ${MIN_PLAYERS}~${MAX_PLAYERS} 人）`);
  const roles = [...board];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

export type Winner = 'good' | 'wolf' | null;

export function winnerOf(alive: { role: Role; alive: boolean }[]): Winner {
  const living = alive.filter((s) => s.alive);
  if (!living.some((s) => s.role === 'wolf')) return 'good';
  if (!living.some((s) => GODS.includes(s.role))) return 'wolf';
  if (!living.some((s) => s.role === 'villager')) return 'wolf';
  return null;
}
