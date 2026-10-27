import type { ModelConnection } from "./model-client";
import { DEFAULT_MODEL } from "./model-providers";
import { checkedEndpoint, cleanApiKey, validModelId } from "./model-settings";

/** One app-owned key only. Never read another app's localStorage entries. */
export const LOCAL_SETTINGS_KEY = "moss-prompt-static.settings.v1";
export type LocalSettingsState = {
  version: 1;
  activeEndpoint: string | null;
  profiles: Record<string, { apiKey: string; model: string }>;
};
export type SettingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export class LocalSettingsError extends Error {
  constructor(message: string) { super(message); this.name = "LocalSettingsError"; }
}
export const emptyLocalSettings = (): LocalSettingsState => ({ version: 1, activeEndpoint: null, profiles: {} });
const corruptMessage = "本机模型配置已损坏，未读取或覆盖任何密钥。请点击「清除本机配置」后重新填写。";

function getStorage(storage?: SettingsStorage): SettingsStorage {
  try {
    const selected = storage ?? globalThis.localStorage;
    if (!selected) throw new Error();
    return selected;
  } catch {
    throw new LocalSettingsError("浏览器不允许访问本地存储。请允许此站点保存数据，或换用普通浏览窗口后重试。");
  }
}
function parseSettings(raw: string): LocalSettingsState {
  let value: unknown;
  try { if (raw.length > 512000) throw new Error(); value = JSON.parse(raw); }
  catch { throw new LocalSettingsError(corruptMessage); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LocalSettingsError(corruptMessage);
  const data = value as Record<string, unknown>;
  if (data.version !== 1) throw new LocalSettingsError("本机配置版本不兼容，未覆盖已有数据。请使用匹配版本，或清除本机配置后重新填写。");
  try {
    if (Object.keys(data).some((key) => !["version", "activeEndpoint", "profiles"].includes(key))) throw new Error();
    if (typeof data.profiles !== "object" || data.profiles === null || Array.isArray(data.profiles)) throw new Error();
    const profiles: LocalSettingsState["profiles"] = {};
    for (const [endpoint, profile] of Object.entries(data.profiles)) {
      if (checkedEndpoint(endpoint) !== endpoint || typeof profile !== "object" || profile === null || Array.isArray(profile)) throw new Error();
      const entry = profile as Record<string, unknown>;
      if (Object.keys(entry).length !== 2 || typeof entry.apiKey !== "string" || typeof entry.model !== "string") throw new Error();
      const key = cleanApiKey(entry.apiKey);
      if (!key || key !== entry.apiKey || !validModelId(entry.model)) throw new Error();
      profiles[endpoint] = { apiKey: key, model: entry.model };
    }
    const activeEndpoint = data.activeEndpoint;
    if (activeEndpoint !== null && (typeof activeEndpoint !== "string" || checkedEndpoint(activeEndpoint) !== activeEndpoint || !Object.hasOwn(profiles, activeEndpoint))) throw new Error();
    return { version: 1, activeEndpoint, profiles };
  } catch { throw new LocalSettingsError(corruptMessage); }
}

/** Invalid/blocked storage is an explicit error, never a silent empty fallback. */
export function loadLocalSettings(storage?: SettingsStorage): LocalSettingsState {
  const selected = getStorage(storage);
  let raw: string | null;
  try { raw = selected.getItem(LOCAL_SETTINGS_KEY); }
  catch { throw new LocalSettingsError("无法读取本机模型配置。请允许此站点使用本地存储后重试；已有数据未被更改。"); }
  return raw === null ? emptyLocalSettings() : parseSettings(raw);
}

/** Normalization is checked before looking up a credential; hosts/paths/ports never fall back. */
export function getStoredConnection(state: LocalSettingsState, endpoint: string): ModelConnection | null {
  const target = checkedEndpoint(endpoint);
  const profile = Object.hasOwn(state.profiles, target) ? state.profiles[target] : null;
  return profile ? { endpoint: target, apiKey: profile.apiKey, model: profile.model } : null;
}
export function getActiveConnection(state: LocalSettingsState): ModelConnection | null {
  return state.activeEndpoint ? getStoredConnection(state, state.activeEndpoint) : null;
}
export function resolveModelConnection(
  state: LocalSettingsState,
  input: { endpoint: string; apiKey: string; model?: string },
): ModelConnection {
  const endpoint = checkedEndpoint(input.endpoint);
  const freshKey = cleanApiKey(input.apiKey);
  const existing = getStoredConnection(state, endpoint);
  const apiKey = freshKey || existing?.apiKey;
  if (!apiKey) throw new LocalSettingsError("请填写此端点对应的 API 密钥；其他端点的密钥不会转发到这里。");
  const model = input.model === undefined ? existing?.model ?? DEFAULT_MODEL : input.model.trim();
  if (!validModelId(model)) throw new LocalSettingsError("请填写有效的模型 ID（不能含空格，最长 256 字符）。");
  return { endpoint, apiKey, model };
}

/** Re-read immediately before writing so saving one profile preserves other saved endpoints. */
export function saveLocalSettings(input: { endpoint: string; apiKey: string; model: string }, storage?: SettingsStorage): LocalSettingsState {
  checkedEndpoint(input.endpoint);
  const selected = getStorage(storage);
  const current = loadLocalSettings(selected);
  const connection = resolveModelConnection(current, input);
  const next: LocalSettingsState = {
    version: 1,
    activeEndpoint: connection.endpoint,
    profiles: { ...current.profiles, [connection.endpoint]: { apiKey: connection.apiKey, model: connection.model } },
  };
  const serialized = JSON.stringify(next);
  if (serialized.length > 512000) throw new LocalSettingsError("本机模型配置过多，未覆盖已有配置。请先清除不再需要的本机配置，再重新保存。");
  try { selected.setItem(LOCAL_SETTINGS_KEY, serialized); }
  catch { throw new LocalSettingsError("未能保存配置：本地存储可能已满或被浏览器禁用。请释放此站点存储空间或允许保存数据，然后重试。"); }
  return next;
}

/** Also works for corrupt data. Does not clear drafts or any other website/app's storage. */
export function clearLocalSettings(storage?: SettingsStorage): LocalSettingsState {
  const selected = getStorage(storage);
  try { selected.removeItem(LOCAL_SETTINGS_KEY); }
  catch { throw new LocalSettingsError("未能清除本机配置。请允许此站点使用本地存储后重试，或在浏览器设置中删除此站点数据。"); }
  return emptyLocalSettings();
}
