/**
 * 用户电脑上的 AI 客户端当玩家：走用户自己的订阅（不用填密钥）。
 *   - codex：OpenAI Codex 的命令行（Codex 桌面版自带，或单独安装的 codex），用 ChatGPT 登录
 *   - claude-code：Claude Code 的命令行，用 Claude 登录（要先在命令行里登录一次）
 * 每次决定跑一次无界面的调用：把局面和要做的事交给它，要回一个 JSON。比 API 慢（Codex 一次二三十秒）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Brain, Decision, DecisionRequest, SeatView } from './engine.js';
import { fallback, parseDecision, shortError, systemPrompt, userPrompt } from './brains.js';

export type LocalClient = 'codex' | 'claude-code';
export const CLIENT_LABELS: Record<LocalClient, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };

const TIMEOUT_MS = 180_000;

/** 在 PATH 里找，找不到再去桌面版的安装目录里找最新的一个 */
function findExe(name: string, installGlobs: string[]): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const found: { file: string; mtime: number }[] = [];
  for (const root of installGlobs) {
    try {
      for (const sub of fs.readdirSync(root)) {
        // 桌面版的目录结构：<root>/<版本或哈希>/[<哈希>/]<name>.exe
        for (const file of [path.join(root, sub, `${name}.exe`), ...safeDirs(path.join(root, sub)).map((d) => path.join(root, sub, d, `${name}.exe`))]) {
          if (fs.existsSync(file)) found.push({ file, mtime: fs.statSync(file).mtimeMs });
        }
      }
    } catch {
      // 没装
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null;
}

function safeDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function findClient(client: LocalClient): string | null {
  const local = process.env.LOCALAPPDATA ?? '';
  const roaming = process.env.APPDATA ?? '';
  return client === 'codex'
    ? findExe('codex', [path.join(local, 'OpenAI', 'Codex', 'bin')])
    : findExe('claude', [path.join(roaming, 'Claude', 'claude-code')]);
}

function run(exe: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: String(err) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

export class LocalClientBrain implements Brain {
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wolf-'));

  constructor(private readonly client: LocalClient, private readonly log: (text: string) => void) {}

  async decide(view: SeatView, request: DecisionRequest): Promise<Decision> {
    const exe = findClient(this.client);
    const label = CLIENT_LABELS[this.client];
    if (!exe) return fallback(request, { fault: `这台电脑上没找到 ${label}` });
    const prompt = `${systemPrompt(view)}\n\n${userPrompt(view, request)}`;
    if (this.client === 'codex') {
      const outFile = path.join(this.dir, `out-${Date.now()}.txt`);
      const { code, out } = await run(exe, ['exec', '--skip-git-repo-check', '-s', 'read-only', '-C', this.dir, '-o', outFile, '--', prompt], this.dir);
      const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      if (!text) {
        this.log(`${view.character.name}（Codex）没给结果：exit ${code} ${out.slice(-200)}`);
        return fallback(request, { fault: `Codex 没给结果（${code === null ? '超时' : `exit ${code}`}）：${shortError(out.trim().split('\n').at(-1) ?? '')}` });
      }
      return fallback(request, parseDecision(text));
    }
    const { code, out } = await run(exe, ['-p', prompt, '--output-format', 'json', '--max-turns', '1'], this.dir);
    try {
      const result = JSON.parse(out.slice(out.indexOf('{'))) as { result?: string; is_error?: boolean };
      if (result.is_error || !result.result) throw new Error(result.result ?? 'empty');
      return fallback(request, parseDecision(result.result));
    } catch (err) {
      this.log(`${view.character.name}（Claude Code）没给结果：exit ${code} ${(err as Error).message.slice(0, 120)}`);
      return fallback(request, { fault: `Claude Code 没给结果：${shortError(err)}` });
    }
  }
}

export interface ClientStatus {
  installed: boolean;
  loggedIn: boolean;
  /** 给主人看的一句话 */
  detail: string;
}

const statusCache = new Map<LocalClient, { at: number; status: Promise<ClientStatus> }>();

/** 客户端装没装、登没登录（问一次要一两秒，缓存 20 秒） */
export function clientStatus(client: LocalClient): Promise<ClientStatus> {
  const cached = statusCache.get(client);
  if (cached && Date.now() - cached.at < 20_000) return cached.status;
  const status = (async (): Promise<ClientStatus> => {
    const exe = findClient(client);
    const label = CLIENT_LABELS[client];
    if (!exe) return { installed: false, loggedIn: false, detail: `这台电脑上没找到 ${label}` };
    const { code, out } = await run(exe, client === 'codex' ? ['login', 'status'] : ['auth', 'status'], os.tmpdir());
    if (code === 0 && !/not logged in/i.test(out)) return { installed: true, loggedIn: true, detail: client === 'codex' && /chatgpt/i.test(out) ? '已登录 ChatGPT' : '已登录' };
    return { installed: true, loggedIn: false, detail: `${label} 还没登录，先打开 ${label} 登录一次` };
  })();
  statusCache.set(client, { at: Date.now(), status });
  return status;
}
