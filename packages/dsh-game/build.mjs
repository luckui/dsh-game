// 构建：宿主端打成 Node ESM（lib/index.js），网页端打成 DSH 的动态 client 模块（lib/client.js）。
// 做法参考 dsh-bigfish：React 由 DSH 网页外壳提供，不打进包里。
import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';

// --client：只重建网页端，不动宿主端已经加载的文件。注意 DSH 会把网页端代码缓存在内存里，要重启 DSH 才生效
const clientOnly = process.argv.includes('--client');

if (!clientOnly) {
  await rm('lib', { recursive: true, force: true });
  await mkdir('lib', { recursive: true });
}

if (!clientOnly) await build({
  entryPoints: { index: 'src/index.ts', agent: 'src/agent.ts' },
  outdir: 'lib',
  splitting: true,
  // CommonJS 的启动器库（摄像机客户端）运行时从 node_modules 加载：打进 ESM 包里它的 require('child_process') 会失效
  external: ['minecraft-launcher-core'],
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
});

// Minecraft 身体子进程：mineflayer 带着全部版本的游戏数据，体积大，不打进包里，运行时从 node_modules 加载
if (!clientOnly) await build({
  entryPoints: { 'minecraft-worker': 'src/games/minecraft/body/workerEntry.ts' },
  outdir: 'lib',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
});

await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  minify: true,
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-game",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

console.log(clientOnly ? 'built lib/client.js' : 'built lib/index.js and lib/client.js');
