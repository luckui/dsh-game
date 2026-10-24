// Minecraft 生存自测（packages/dsh-game/test/minecraft-survival.ts）：打包成一个文件再跑。
// 要先开好开发服务器（node tools/mc-server.mjs start）并构建插件（身体子进程用 lib/minecraft-worker.cjs）。
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'packages', 'dsh-game');
const out = path.join(pkg, 'test', '.out', 'minecraft-survival.cjs');
// esbuild 装在插件包里
const { build } = createRequire(path.join(pkg, 'package.json'))('esbuild');

await build({
  entryPoints: [path.join(pkg, 'test', 'minecraft-survival.ts')],
  outfile: out,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});
const run = spawnSync(process.execPath, [out, root], { stdio: 'inherit' });
process.exit(run.status ?? 1);
