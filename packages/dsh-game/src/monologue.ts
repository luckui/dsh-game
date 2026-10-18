/**
 * 内心独白音效（狼人杀里她的心声）：频段收窄、干声压低、长混响加回声，像在心里说话。
 * 舞台播放（stage.tsx）和离线试听渲染用同一段代码，听到的就是游戏里的样子。
 *
 * 混响的冲激响应自己按「每声道能量为 1」归一（ConvolverNode 不再自动归一）：
 * 浏览器自带的归一和 ffmpeg 的不一样，主人试听确认的 C 档是按能量归一做的。
 */

export interface MonologueParams {
  /** 干声（原声）音量 */
  dry: number;
  /** 混响音量 */
  wet: number;
  /** 回声：第一下的音量（相对混响）、之后每下再乘多少（C 档：0.42、0.18、0.07……） */
  echo: number;
  feedback: number;
  /** 整体补偿音量（倍数） */
  makeup: number;
  /** 混响尾巴多长（秒） */
  seconds: number;
}

/** 现在用的参数：主人在浏览器实录的几档里挑的「轻和中之间」 */
export const MONOLOGUE: MonologueParams = { dry: 0.87, wet: 0.18, echo: 0.32, feedback: 0.27, makeup: 1, seconds: 1.9 };

/** 搭好效果链，返回输入节点（接到 ctx.destination） */
export function buildMonologue(ctx: BaseAudioContext, p: MonologueParams = MONOLOGUE): AudioNode {
  const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 300 });
  const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3600 });
  // 混响：50 毫秒预延迟 + 几秒衰减的噪声，每声道能量归一到 1
  const pre = Math.round(ctx.sampleRate * 0.05);
  const tail = Math.round(ctx.sampleRate * p.seconds);
  const impulse = ctx.createBuffer(2, pre + tail, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let energy = 0;
    for (let i = 0; i < tail; i++) {
      const v = (Math.random() * 2 - 1) * Math.pow(1 - i / tail, 1.9);
      data[pre + i] = v;
      energy += v * v;
    }
    const scale = 1 / Math.sqrt(energy);
    for (let i = pre; i < pre + tail; i++) data[i] *= scale;
  }
  const reverb = new ConvolverNode(ctx, { buffer: impulse, disableNormalization: true });
  // 回声：0.24 秒一下，接在混响后面
  const delay = new DelayNode(ctx, { delayTime: 0.24, maxDelayTime: 1 });
  const feedback = new GainNode(ctx, { gain: p.feedback });
  const echo = new GainNode(ctx, { gain: p.echo });
  const dry = new GainNode(ctx, { gain: p.dry * p.makeup });
  const wet = new GainNode(ctx, { gain: p.wet * p.makeup });
  // 限幅防爆音（不加压缩器自带的补偿增益：knee 0、阈值贴近 0 dB）
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.1 });
  highpass.connect(lowpass);
  lowpass.connect(dry).connect(limiter);
  lowpass.connect(reverb);
  reverb.connect(wet);
  reverb.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(echo).connect(wet);
  wet.connect(limiter);
  limiter.connect(ctx.destination);
  return highpass;
}
