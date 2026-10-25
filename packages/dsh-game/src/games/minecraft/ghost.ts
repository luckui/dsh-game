/**
 * 虚影：盖房子之前，在图纸的每一格放一个「方块展示实体」（block_display，1.19.4 起有），
 * 整座房子先以白模（不透明的白色方块，像建筑师的体块模型）出现；她每放好一块真方块，那一格的虚影就消失，盖完正好没了。
 * 给看的人看（摄像机客户端、直播画面、服务器上的玩家）；她自己看不到画面。要 RCON（命令由服务器执行）。
 * 主人看过彩色玻璃和白模并排比：玻璃是透明的，平的一面只有一层，后面的东西透出来，像缺了一块；白模是实心的，体积清楚。
 *
 * 材料在描边的颜色上（Glowing 的发光描边）：木头橙、石头灰、玻璃浅蓝、门和火把黄、黑曜石紫、羊毛粉、泥土沙子黄绿，别的白。
 * 连在一起的虚影描出整座房子的轮廓，隔着墙、在远处也看得清。
 * 虚影比一格小一点点（0.96），真方块放上去时不会和它闪烁打架。
 */
import { rconBatch, type RconTarget } from './rcon.js';

export interface GhostCell {
  x: number;
  y: number;
  z: number;
  name: string;
}

const WOOD = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_|_log$|_wood$|_planks$|^bamboo_block$|^crafting_table$|^bookshelf$|^chest$|^barrel$/;
const STONE = /stone|cobble|brick|deepslate|andesite|granite|diorite|blackstone|basalt|tuff|calcite|terracotta|concrete|prismarine|purpur|quartz|end_stone|netherrack|^furnace$|^smooth_/;

function glassFor(name: string): string {
  if (/glass/.test(name)) return 'light_blue_stained_glass';
  if (/_door$|torch$|lantern$|_trapdoor$|_fence_gate$|_button$|^lever$|ladder$/.test(name)) return 'yellow_stained_glass';
  if (/obsidian/.test(name)) return 'purple_stained_glass';
  if (/wool$|carpet$|_bed$/.test(name)) return 'pink_stained_glass';
  if (WOOD.test(name)) return 'orange_stained_glass';
  if (STONE.test(name)) return 'light_gray_stained_glass';
  if (/dirt|grass_block|sand|gravel|clay|mud|moss/.test(name)) return 'lime_stained_glass';
  return 'white_stained_glass';
}

/** 描边颜色：按材料分（键是材料归到的那种彩色玻璃名） */
const GLOW: Record<string, number> = {
  light_blue_stained_glass: 0x7fd4ff,
  yellow_stained_glass: 0xffe066,
  purple_stained_glass: 0xc080ff,
  pink_stained_glass: 0xff9ecf,
  orange_stained_glass: 0xffa040,
  light_gray_stained_glass: 0xd0d0d0,
  lime_stained_glass: 0x9be05a,
  white_stained_glass: 0xffffff,
};

const tagOf = (id: string, p: { x: number; y: number; z: number }) => `dsh_ghost_${id}_${p.x}_${p.y}_${p.z}`;

export class GhostBuild {
  private pending: string[] = [];
  private flushing: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly target: RconTarget, readonly id: string, private readonly log?: (text: string) => void) {}

  /** 放出虚影（门这类两格高的上下两格都放） */
  async show(cells: GhostCell[]): Promise<void> {
    const commands: string[] = [];
    for (const c of cells) {
      const spots = /_door$/.test(c.name) ? [c, { ...c, y: c.y + 1 }] : [c];
      const glass = glassFor(c.name);
      for (const p of spots) {
        commands.push(`summon block_display ${p.x + 0.5} ${p.y + 0.5} ${p.z + 0.5} {block_state:{Name:"minecraft:white_concrete"},`
          + `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[-0.48f,-0.48f,-0.48f],scale:[0.96f,0.96f,0.96f]},`
          + `brightness:{sky:15,block:15},Glowing:1b,glow_color_override:${GLOW[glass]},Tags:["dsh_ghost","dsh_ghost_${this.id}","dsh_ghost_${this.id}_y${p.y}","${tagOf(this.id, p)}"]}`);
      }
    }
    // 一次几百条：分批发，每批一个连接
    for (let i = 0; i < commands.length; i += 200) {
      await rconBatch(this.target, commands.slice(i, i + 200), 10_000).catch((err: Error) => this.log?.(`[ghost] could not show: ${err.message}`));
    }
  }

  /** 这一格的真方块放好了：去掉它的虚影（攒半秒一起发） */
  remove(p: { x: number; y: number; z: number; name?: string }): void {
    this.pending.push(`kill @e[type=block_display,tag=${tagOf(this.id, p)}]`);
    if (p.name && /_door$/.test(p.name)) this.pending.push(`kill @e[type=block_display,tag=${tagOf(this.id, { ...p, y: p.y + 1 })}]`);
    this.timer ??= setTimeout(() => this.flush(), 500);
  }

  private flush(): Promise<unknown> {
    this.timer = null;
    const commands = this.pending.splice(0);
    if (!commands.length) return this.flushing;
    this.flushing = this.flushing.then(() => rconBatch(this.target, commands, 10_000)).catch(() => {});
    return this.flushing;
  }

  /** 这一层整层放好了（创造模式一层层放）：这一层的虚影都去掉 */
  removeLayer(y: number): void {
    this.pending.push(`kill @e[type=block_display,tag=dsh_ghost_${this.id}_y${y}]`);
    this.timer ??= setTimeout(() => this.flush(), 100);
  }

  /** 这次盖完（成没成都一样）：剩下的虚影都去掉 */
  async clear(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
    await rconBatch(this.target, [`kill @e[type=block_display,tag=dsh_ghost_${this.id}]`]).catch(() => {});
  }

  /** 去掉所有虚影（这局开始、结束时：上一局 DSH 被关掉时可能留着） */
  static clearAll(target: RconTarget): Promise<unknown> {
    return rconBatch(target, ['kill @e[type=block_display,tag=dsh_ghost]']).catch(() => {});
  }
}
