// DSH 网页外壳提供的共享组件（运行时由 DSH 的模块加载器给，不打进包里）。这里只声明设置页用到的部分，
// 照 @deepseek-ai/dsh-client-ui-primitives 0.2.0-rc.2 的类型抄写
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { JSX, ReactNode } from 'react';

  export interface SettingsFormScopeSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable';
    value: T | undefined;
    base: unknown;
    user: unknown;
    writable: boolean;
    revision: number | undefined;
  }
  export type SettingsFormPathOp = { op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] };
  export interface SettingsFormScope<T> {
    getSnapshot(): SettingsFormScopeSnapshot<T>;
    subscribe(listener: () => void): () => void;
    mutate(ops: readonly SettingsFormPathOp[], expectedRevision?: number): Promise<boolean>;
  }
  export type SettingsFieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' };
  export interface SettingsFieldSpec {
    field: string;
    format: (value: unknown) => string;
    parse: (text: string) => SettingsFieldWrite | undefined;
  }
  export interface SettingsSecretSpec {
    field: string;
    write: (text: string) => Promise<boolean>;
  }
  export interface SettingsFieldState { text: string; overridden: boolean; invalid: boolean }
  export interface SettingsFormShell { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean }
  export interface SettingsFormActions {
    edit: (field: string, text: string) => void;
    resetField: (field: string) => void;
    save: () => void;
    discard: () => void;
  }
  export interface SnapshotStore<S> { getSnapshot(): S; subscribe(listener: () => void): () => void; set(next: S): void }
  export function settingsTextField(field: string): SettingsFieldSpec;
  export function settingsNumberField(field: string): SettingsFieldSpec;
  export class SettingsFormModel<T> {
    constructor(scope: SettingsFormScope<T>, specs: SettingsFieldSpec[], secrets?: SettingsSecretSpec[]);
    bind<S>(project: () => S): SnapshotStore<S>;
    shell(): SettingsFormShell;
    field(field: string): SettingsFieldState;
    actions(): SettingsFormActions;
    save(): Promise<void>;
    dispose(): void;
  }
  export function SettingsForm(props: {
    labels: { unavailable: string; readOnly: string; saveFailed: string; save: string; saving: string };
    state: SettingsFormShell;
    onSave: () => void;
    onDiscard: () => void;
    children: ReactNode;
  }): JSX.Element;
  export function SettingsValueField(props: {
    id: string; label: string; hint?: string; text: string; overridden: boolean; invalid: boolean;
    overriddenLabel: string; resetLabel: string; invalidLabel: string; disabled: boolean;
    onEdit: (text: string) => void; onReset: () => void; numeric?: boolean; placeholder?: string;
  }): JSX.Element;
  export function SettingsSecretField(props: {
    id: string; label: string; hint: string; text: string; disabled: boolean; onEdit: (text: string) => void;
    configured: boolean; stateLabel: string;
  }): JSX.Element;
  export function Switch(props: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; title?: string; className?: string }): JSX.Element;
}
