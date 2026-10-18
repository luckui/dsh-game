/**
 * 插件设置页：侧栏「插件」→ dsh-game 的页面里（plugins.bundle.config 槽位）。
 * 用 DSH 官方配置页同一套表单（ui-primitives 的 SettingsForm），写回本插件的配置节（cordis 条目 id `dsh-game`）；
 * 豆包密钥不进配置文件，走 DSH 凭据（和「网页搜索」配置页的 API Key 一样，页面只知道配没配，看不到明文）。
 */

import React from 'react';
import { DEFAULT_VOICE, usesNewConsole } from './voices.js';
import {
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  SettingsValueField,
  Switch,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFormScope,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** 本插件在 profile 里的条目 id（cordis.patch.yml），也是设置命名空间 */
export const SETTINGS_NS = 'dsh-game';
/** 插件页按包名找组合包的配置 */
export const PACKAGE_NAME = 'dsh-game';

const CREDENTIALS = [
  { field: 'doubaoApiKey', ref: 'DOUBAO_TTS_API_KEY', label: '豆包语音 API Key（新版控制台）', hint: '一般只填这一个。火山引擎「豆包语音」控制台 →「API Key 管理」里创建，并开通「豆包语音合成模型 2.0」。2.0 音色（…_uranus_bigtts）和复刻音色（S_ 开头）都用它。' },
  { field: 'doubaoAppId', ref: 'DOUBAO_TTS_APP_ID', label: '豆包语音 APP ID（旧版控制台，可不填）', hint: '只有把大肥鱼换成 1.0 音色时才要，和下面的 Access Token 一起。火山引擎说旧版控制台以后会下线。' },
  { field: 'doubaoAccessKey', ref: 'DOUBAO_TTS_ACCESS_KEY', label: '豆包语音 Access Token（旧版控制台，可不填）', hint: '同上，只有 1.0 音色要。' },
] as const;
type CredentialField = typeof CREDENTIALS[number]['field'];

const LABELS = {
  unavailable: 'dsh-game 当前没有加载，暂时不能设置。',
  readOnly: '这个部署的设置是只读的。',
  saveFailed: 'DSH 没有接受这些值，已保留，改好再保存。',
  save: '保存',
  saving: '保存中…',
};
const FIELD_LABELS = { overriddenLabel: '已修改', resetLabel: '恢复默认', invalidLabel: '' };

/** 开关字段：表单里存成 on / off 文本 */
function settingsSwitchField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === false ? 'off' : 'on'),
    parse: (text) => (text === 'on' || text === 'off' ? { kind: 'set', value: text === 'on' } : undefined),
  };
}

interface CredentialState { configured: boolean; writable: boolean }

export interface SettingsServices {
  configForms: { get(ns: string): SettingsFormScope<unknown> };
  remote: {
    credentials: {
      describe(refs: string[]): Promise<{ ok: boolean; value?: Record<string, { configured?: boolean; writable?: boolean } | undefined> }>;
      set(ref: string, value: string): Promise<unknown>;
    };
    $on(event: string, listener: (ref: string) => void): () => void;
  };
}

/** 表单状态：配置节（音色、开关、模型、目录）+ 两个凭据 */
export class GameSettingsController {
  private readonly form: SettingsFormModel<unknown>;
  readonly store;
  private credentials: Record<string, CredentialState> = {};

  constructor(private readonly services: SettingsServices) {
    this.form = new SettingsFormModel(
      services.configForms.get(SETTINGS_NS),
      [settingsTextField('voice'), settingsSwitchField('censor'), settingsSwitchField('director'), settingsTextField('summaryModel'), settingsTextField('ddlcDir')],
      CREDENTIALS.map(({ field, ref }) => ({ field, write: (text: string) => this.writeCredential(ref, text) })),
    );
    this.store = this.form.bind(() => this.projection());
    void this.readCredentials();
  }

  private projection() {
    return {
      ...this.form.shell(),
      voice: this.form.field('voice'),
      censor: this.form.field('censor'),
      director: this.form.field('director'),
      summaryModel: this.form.field('summaryModel'),
      ddlcDir: this.form.field('ddlcDir'),
      secrets: Object.fromEntries(CREDENTIALS.map(({ field, ref }) => [field, {
        text: this.form.field(field).text,
        configured: this.credentials[ref]?.configured ?? false,
        writable: this.credentials[ref]?.writable ?? true,
      }])) as Record<CredentialField, { text: string } & CredentialState>,
    };
  }

  /** 问 DSH 两个密钥配没配（只回答有没有，不给值） */
  async readCredentials(): Promise<void> {
    const refs = CREDENTIALS.map((c) => c.ref);
    const response = await this.services.remote.credentials.describe([...refs]).catch(() => null);
    if (!response?.ok || !response.value) return;
    for (const ref of refs) {
      const view = response.value[ref];
      this.credentials[ref] = { configured: view?.configured ?? false, writable: view?.writable ?? true };
    }
    this.store.set(this.projection());
  }

  refreshCredential(ref: string): void {
    if (CREDENTIALS.some((c) => c.ref === ref)) void this.readCredentials();
  }

  private async writeCredential(ref: string, value: string): Promise<boolean> {
    await this.services.remote.credentials.set(ref, value);
    await this.readCredentials();
    return this.credentials[ref]?.configured ?? false;
  }

  inject() {
    return { hooks: { gameSettings: this.store }, ...this.form.actions() };
  }

  dispose(): void {
    this.form.dispose();
  }
}

type Snapshot = ReturnType<GameSettingsController['projection']>;
interface PageProps {
  view?: 'page' | 'summary';
  useGameSettings: <T>(select: (s: Snapshot) => T) => T;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  discard: () => void;
}

export function GameSettingsPage(props: PageProps) {
  const state = props.useGameSettings((s) => s);
  if (props.view === 'summary') return <>大肥鱼的语音、打码、导演模式和游戏目录。</>;
  const disabled = !state.writable;
  const text = (field: 'voice' | 'summaryModel' | 'ddlcDir', label: string, hint: string) => (
    <SettingsValueField
      id={`dsh-game-${field}`}
      label={label}
      hint={hint}
      disabled={disabled}
      {...FIELD_LABELS}
      {...state[field]}
      onEdit={(t) => props.edit(field, t)}
      onReset={() => props.resetField(field)}
    />
  );
  const toggle = (field: 'censor' | 'director', label: string, hint: string) => (
    <div className="dg-setting-row">
      <div>
        <div className="dg-setting-label">{label}</div>
        <div className="dg-setting-hint">{hint}</div>
      </div>
      <Switch label={label} disabled={disabled} checked={state[field].text !== 'off'} onChange={(on) => props.edit(field, on ? 'on' : 'off')} />
    </div>
  );
  // 现在的密钥念得出哪些声音（按已经存下的密钥算；刚输入还没保存的不算）
  const voice = state.voice.text.trim() || DEFAULT_VOICE;
  const newKey = state.secrets.doubaoApiKey.configured;
  const oldKeys = state.secrets.doubaoAppId.configured && state.secrets.doubaoAccessKey.configured;
  const fishOk = usesNewConsole(voice) ? newKey : oldKeys;
  return (
    <SettingsForm labels={LABELS} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className="dg-setting-voice">
        <div className="dg-setting-label">语音（豆包，可选；不配就只有字幕）</div>
        <div className="dg-setting-hint">豆包语音有新旧两个控制台，密钥不通用。大肥鱼的默认音色和狼人杀里所有角色、法官都是 2.0 音色，所以只要新版控制台的 API Key；旧版的 APP ID 和 Access Token 只有你把大肥鱼换成 1.0 音色时才需要。</div>
        <div className="dg-setting-status">
          <span data-ok={fishOk ? '' : undefined}>{fishOk ? '✓' : '✗'} 大肥鱼{fishOk ? '' : usesNewConsole(voice) ? '：要新版的 API Key' : '：她现在是 1.0 音色，要旧版的 APP ID 和 Access Token'}</span>
          <span data-ok={newKey ? '' : undefined}>{newKey ? '✓' : '✗'} 狼人杀的角色和法官{newKey ? '' : '：要新版的 API Key'}</span>
        </div>
      </div>
      {CREDENTIALS.map(({ field, label, hint }) => (
        <SettingsSecretField
          key={field}
          id={`dsh-game-${field}`}
          label={label}
          hint={`${hint}存进 DSH 凭据，不写进设置文件。留空表示不改。`}
          disabled={!state.secrets[field].writable}
          text={state.secrets[field].text}
          configured={state.secrets[field].configured}
          stateLabel={state.secrets[field].configured ? '已配置。' : '还没配置。'}
          onEdit={(t) => props.edit(field, t)}
        />
      ))}
      {text('voice', '大肥鱼的音色', `豆包语音的音色 ID。默认是萌丫头 2.0（${DEFAULT_VOICE}）；也可以填别的 2.0 音色（…_uranus_bigtts）、你的复刻音色（S_ 开头），或 1.0 音色（要旧版控制台的密钥）。`)}
      {toggle('censor', '打码', '给游戏里的死亡、自残、血腥画面打码（直播和录视频建议开着）。')}
      {toggle('director', '导演模式', '日常段落快进，交给她一段摘要；关键剧情放慢，一场一场地看。')}
      {text('summaryModel', '摘要模型', '快进摘要用的模型，写成 provider/model。')}
      {text('ddlcDir', '《心跳文学部》游戏目录', '有 DDLC.exe 的那一层。不填就在 Steam 的各个库里找。')}
      <div className="dg-setting-row">
        <div>
          <div className="dg-setting-label">狼人杀：谁上桌、每个座位用什么模型</div>
          <div className="dg-setting-hint">在侧栏「游戏」→ 狼人杀 → 开局设置里选。每个座位可以用 DSH 里配好的任意模型，或者你电脑上的 Codex（走你的 ChatGPT 订阅）。</div>
        </div>
      </div>
    </SettingsForm>
  );
}

export const SETTINGS_CSS = `
.dg-setting-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 0}
.dg-setting-label{font-size:13px;color:var(--text-primary,inherit)}
.dg-setting-hint{font-size:12px;opacity:.6;margin-top:2px}
.dg-setting-voice{padding:8px 0 4px}
.dg-setting-status{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;font-size:12px}
.dg-setting-status span{color:#e0a3a3}
.dg-setting-status span[data-ok]{color:#8fd6a8}
`;
