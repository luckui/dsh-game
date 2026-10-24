/**
 * dsh-game 网页端：把各个界面挂到 DSH 上。
 *   - 侧栏「游戏」入口 → 游戏库（library.tsx）
 *   - 会话里的「游戏」标签：游戏画面、思考终端、大肥鱼（gametab.tsx）
 *   - 其他页面右下角浮着的大肥鱼（stage.tsx）
 */

import React from 'react';
import { ROOM_CSS } from './ambient.js';
import { GAMETAB_CSS, GameView, type GameTabInjected } from './gametab.js';
import { GameLibrary, GamepadIcon, LIBRARY_CSS, PANEL_ID, bindLibrary, type LibraryServices } from './library.js';
import { GameSettingsController, GameSettingsPage, PACKAGE_NAME, SETTINGS_CSS, type SettingsServices } from './settings.js';
import { FISH_CSS, FloatingFish, useDocked } from './stage.js';
import { WOLF_CSS } from './wolf.js';
import { WOLF_SETUP_CSS } from './wolfsetup.js';
import { MC_SETUP_CSS } from './mcsetup.js';

export const inject = ['slots', 'layout', 'workspaces', 'uiWorkspace', 'sessions', 'remote', 'remote.agentPresets'];

interface ClientContext extends LibraryServices {
  slots: { inject(name: string, callback: () => unknown): unknown; register(spec: any, component: any): () => void };
  effect(effect: () => () => void, label?: string): unknown;
  inject(deps: string[], callback: (ctx: ClientContext & SettingsServices) => void): unknown;
  sessions: LibraryServices['sessions'] & { binding(sessionId: string): { eventSource: GameTabInjected['events'] } | undefined };
}

function LibraryPanel() {
  useDocked();
  return <GameLibrary />;
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-game';
    tag.textContent = ROOM_CSS + FISH_CSS + GAMETAB_CSS + LIBRARY_CSS + SETTINGS_CSS + WOLF_CSS + WOLF_SETUP_CSS + MC_SETUP_CSS;
    document.head.append(tag);
    return () => tag.remove();
  }, 'dsh-game styles');
  bindLibrary(ctx);
  // 设置页（侧栏「插件」→ dsh-game）：要 DSH 的设置表单和凭据服务；没有这些服务的部署只是没有设置页，其他照常
  ctx.inject(['configForms', 'remote.credentials'], (sub) => {
    const page = new GameSettingsController(sub);
    sub.effect(() => () => page.dispose(), 'dsh-game settings form');
    sub.effect(() => sub.remote.$on('credentials/reference-updated', (ref) => page.refreshCredential(ref)), 'dsh-game credential updates');
    sub.slots.inject('plugins.bundle.config', () => sub.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE_NAME,
      inject: () => page.inject(),
    }, GameSettingsPage));
  });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LibraryPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: () => '游戏' }, GamepadIcon));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-game-stage', order: 60 }, FloatingFish));
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-game',
    order: 30,
    label: () => '游戏',
    // 终端要读这个会话的事件（她的思考、操作、主人的话），输入行要往这个会话发消息
    inject: (sessionId: string): GameTabInjected => ({
      sessionId,
      openSession: (id) => ctx.uiWorkspace.openSession(id),
      events: ctx.sessions.binding(sessionId)?.eventSource,
      // 发消息、停止：和游戏库一样先借用会话、等它就绪再调（直接用注册时拿到的会话对象，消息发不出去）
      send: (text) => ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
        const { session } = await reference.ready;
        // 她玩的时候一直在跑同一轮：用 steer 让她在下一步就看到，而不是排到这一轮结束
        const mode = session.getSnapshot?.()?.running ? 'steer' : 'queue';
        const handle = session.beginSubmission({ mode, text, attachments: [] });
        const result = await session.prompt([{ type: 'text', text }], mode, undefined, handle.requestId);
        // 她正在 game_continue 里等一整场戏：让这个时刻提前返回，她马上就能看到这句话
        if (result.ok && mode === 'steer') void fetch('/api/dsh-game/nudge', { method: 'POST' }).catch(() => {});
        return result;
      }),
      stop: () => ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
        const { session } = await reference.ready;
        await session.cancel();
      }),
    }),
  }, GameView));
}
