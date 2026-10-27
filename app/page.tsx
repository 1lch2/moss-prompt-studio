"use client";

import BboxWorkbench from "../components/bbox-workbench";
import { fetchModels, type ModelConnection } from "../lib/model-client";
import { enhancePromptWithModel } from "../lib/prompt-enhancement";
import { clearLocalSettings, emptyLocalSettings, getActiveConnection, getStoredConnection, loadLocalSettings, resolveModelConnection, saveLocalSettings, LOCAL_SETTINGS_KEY, type LocalSettingsState } from "../lib/local-settings";
import { RESOLUTION_PRESETS } from "../lib/canvas-reference";
import { validateGeneratedLayout, type MossLayoutPrompt } from "../lib/moss-layout";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, PROVIDER_PRESETS, normalizeEndpoint, findPreset, supportsModelListing } from "../lib/model-providers";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, ChevronDown, CircleAlert, Copy, LoaderCircle, RotateCcw, Settings2, Sparkles } from "lucide-react";

type Connection = "checking" | "ready" | "unconfigured" | "error";
type Mode = "写实" | "二次元" | "跨次元";
type OutputFormat = "text" | "layout";
type PromptResult = { text: string; copy: string; dimensions?: { width: number; height: number } };

function validDimension(value: string) {
  const size = Number(value);
  return !!value.trim() && Number.isInteger(size) && size >= 64 && size <= 4096 && size % 16 === 0;
}

function validEndpoint(value: string) {
  try { return normalizeEndpoint(value); } catch { return ""; }
}

export default function Home() {
  const [workspaceMode, setWorkspaceMode] = useState<"prompt" | "layout">("prompt");
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [preferences, setPreferences] = useState("");
  const [mode, setMode] = useState<Mode>("写实");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("text");
  const [outputWidth, setOutputWidth] = useState("1024");
  const [outputHeight, setOutputHeight] = useState("1024");
  const [result, setResult] = useState<PromptResult | null>(null);
  const [connection, setConnection] = useState<Connection>("checking");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [localSettings, setLocalSettings] = useState<LocalSettingsState>(emptyLocalSettings);
  const [providerId, setProviderId] = useState(findPreset(DEFAULT_ENDPOINT)?.id ?? "custom");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [listingModels, setListingModels] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const requestRef = useRef<AbortController | null>(null);
  const modelRequestRef = useRef<AbortController | null>(null);
  const settingsRevisionRef = useRef(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);

  const checkConnection = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    settingsRevisionRef.current++;
    modelRequestRef.current?.abort();
    modelRequestRef.current = null;
    setListingModels(false);
    setAvailableModels([]);
    setApiKey("");
    try {
      const saved = loadLocalSettings();
      const active = getActiveConnection(saved);
      setLocalSettings(saved);
      setConnection(active ? "ready" : "unconfigured");
      setSettingsError("");
      setModel(active?.model ?? DEFAULT_MODEL);
      setSelectedModel(active?.model ?? DEFAULT_MODEL);
      setEndpoint(active?.endpoint ?? DEFAULT_ENDPOINT);
      setProviderId(findPreset(active?.endpoint ?? DEFAULT_ENDPOINT)?.id ?? "custom");
    } catch (cause) {
      setLocalSettings(emptyLocalSettings());
      setConnection("error");
      setSettingsError(cause instanceof Error ? cause.message : "无法读取浏览器配置，请允许站点存储后重试，或清除本机配置。");
      setSettingsOpen(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => checkConnection(controller.signal));
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCAL_SETTINGS_KEY || event.key === null) void checkConnection(controller.signal);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      controller.abort(); requestRef.current?.abort(); modelRequestRef.current?.abort();
      window.removeEventListener("storage", onStorage);
    };
  }, [checkConnection]);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const normalizedEndpoint = validEndpoint(endpoint);
  const modelsListSupported = supportsModelListing(normalizedEndpoint);
  const savedForEndpoint = normalizedEndpoint ? getStoredConnection(localSettings, normalizedEndpoint) : null;
  const activeConnection: ModelConnection | null = getActiveConnection(localSettings);
  const canKeepKey = !!savedForEndpoint;
  const settingsBusy = saving || loading || layoutBusy || connection === "checking";
  const outputDimensionsValid = validDimension(outputWidth) && validDimension(outputHeight);
  const outputResolution = `${Number(outputWidth)}x${Number(outputHeight)}`;
  const presetResolution = RESOLUTION_PRESETS.some((group) => group.sizes.some(([, width, height]) => `${width}x${height}` === outputResolution)) ? outputResolution : "";

  function resetDiscovery() {
    settingsRevisionRef.current++;
    modelRequestRef.current?.abort();
    modelRequestRef.current = null;
    setListingModels(false);
    setAvailableModels([]);
    setSettingsMessage("");
    setSettingsError("");
  }

  function changeEndpoint(value: string) {
    resetDiscovery();
    setApiKey("");
    setEndpoint(value);
    const saved = validEndpoint(value) ? getStoredConnection(localSettings, value) : null;
    setSelectedModel(saved?.model ?? (validEndpoint(value) === DEFAULT_ENDPOINT ? DEFAULT_MODEL : ""));
  }

  function changeProvider(value: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === value);
    setProviderId(value);
    changeEndpoint(preset?.endpoint ?? endpoint);
  }

  async function discoverModels() {
    if (listingModels || settingsBusy || !modelsListSupported) return;
    setSettingsError("");
    setSettingsMessage("");
    if (!normalizedEndpoint) { setSettingsError("请填写有效的公开 HTTPS API 端点。"); return; }
    if (!apiKey.trim() && !canKeepKey) { setSettingsError("新端点需要填写对应的 API 密钥。"); return; }
    const controller = new AbortController();
    modelRequestRef.current?.abort();
    modelRequestRef.current = controller;
    const revision = settingsRevisionRef.current;
    setListingModels(true);
    try {
      const selected = resolveModelConnection(localSettings, { endpoint: normalizedEndpoint, apiKey: apiKey.trim() });
      const models = await fetchModels(selected, fetch, controller.signal);
      if (controller.signal.aborted || revision !== settingsRevisionRef.current) return;
      setAvailableModels(models);
      setSelectedModel((current) => current || models[0] || "");
      setSettingsMessage(models.length ? `已获取 ${models.length} 个模型，请选择支持 Chat Completions 的模型。` : "此端点未返回可用模型，请手动填写模型 ID。");
    } catch (cause) {
      if (!controller.signal.aborted && revision === settingsRevisionRef.current) setSettingsError(cause instanceof Error && cause.message !== "Failed to fetch" ? cause.message : "无法连接所选端点，请检查网络、地址或浏览器访问权限；也可手动填写模型 ID。");
    } finally {
      if (revision === settingsRevisionRef.current && modelRequestRef.current === controller) {
        setListingModels(false);
        modelRequestRef.current = null;
      }
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (settingsBusy || listingModels) return;
    setSettingsError("");
    setSettingsMessage("");
    if (!normalizedEndpoint) { setSettingsError("请填写有效的公开 HTTPS API 端点。"); return; }
    if (!apiKey.trim() && !canKeepKey) { setSettingsError("更换端点后，请填写该端点的 API 密钥。"); return; }
    if (!selectedModel.trim()) { setSettingsError("请选择或填写模型 ID。"); return; }
    setSaving(true);
    try {
      const saved = saveLocalSettings({ endpoint: normalizedEndpoint, apiKey: apiKey.trim(), model: selectedModel.trim() });
      const active = getActiveConnection(saved)!;
      setLocalSettings(saved);
      setApiKey("");
      setConnection("ready");
      setEndpoint(active.endpoint);
      setModel(active.model);
      setSelectedModel(active.model);
      setSettingsMessage("已保存到本浏览器。仅点击增强时才会生成内容并消耗 API 额度。");
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : "无法保存到浏览器，请检查站点存储权限与可用空间。");
    } finally { setSaving(false); }
  }

  function clearSettings() {
    if (settingsBusy || listingModels) return;
    resetDiscovery();
    try {
      const cleared = clearLocalSettings();
      setLocalSettings(cleared);
      setApiKey("");
      setEndpoint(DEFAULT_ENDPOINT);
      setProviderId(findPreset(DEFAULT_ENDPOINT)?.id ?? "custom");
      setModel(DEFAULT_MODEL);
      setSelectedModel(DEFAULT_MODEL);
      setConnection("unconfigured");
      setSettingsMessage("已清除本浏览器中此工作台的全部端点、密钥和模型配置。");
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : "清除失败，请检查浏览器站点存储权限，或在浏览器设置中清除本站数据。");
    }
  }

  async function enhance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || loading || requestRef.current || saving || layoutBusy || listingModels || connection !== "ready") return;
    if (outputFormat === "layout" && !outputDimensionsValid) { setError("宽高须为 64–4096 之间、16 的倍数。"); return; }
    const requestedFormat = outputFormat;
    const dimensions = { width: Number(outputWidth), height: Number(outputHeight) };
    setLoading(true);
    setError("");
    setCopyState("idle");
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      if (!activeConnection) throw new Error("请先保存本浏览器的模型配置。");
      const data = await enhancePromptWithModel(
        requestedFormat === "layout"
          ? { prompt: prompt.trim(), preferences: preferences.trim(), mode, outputFormat: "layout", ...dimensions }
          : { prompt: prompt.trim(), preferences: preferences.trim(), mode, outputFormat: "text" },
        activeConnection, fetch, controller.signal,
      );
      if (controller.signal.aborted || requestRef.current !== controller) return;
      if (requestedFormat === "layout") {
        if (!("json" in data) || data.width !== dimensions.width || data.height !== dimensions.height) throw new Error("这次没有返回匹配尺寸的布局 JSON，请重试。");
        let json: MossLayoutPrompt;
        try { json = validateGeneratedLayout(data.json, dimensions.width, dimensions.height); }
        catch { throw new Error("这次没有返回有效的布局 JSON，请重试。"); }
        setResult({ text: JSON.stringify(json, null, 2), copy: JSON.stringify(json), dimensions });
      } else {
        if (!("text" in data) || typeof data.text !== "string" || !data.text.trim()) throw new Error("这次没有生成成功，请稍后重试。");
        setResult({ text: data.text.trim(), copy: data.text.trim() });
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error && cause.message !== "Failed to fetch" ? cause.message : "连接中断了，请检查网络后重试。");
    } finally {
      if (requestRef.current === controller) {
        if (!controller.signal.aborted) setLoading(false);
        requestRef.current = null;
      }
    }
  }

  function clear() {
    setPrompt(""); setPreferences(""); setResult(null); setError(""); setCopyState("idle");
    promptRef.current?.focus();
  }

  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.copy); setCopyState("copied"); }
    catch { outputRef.current?.focus(); outputRef.current?.select(); setCopyState("failed"); }
  }

  const ready = connection === "ready" && !!activeConnection;
  const connectionLabel = connection === "checking" ? "正在检查配置" : ready ? "模型已配置" : connection === "error" ? "配置暂不可用" : "等待配置模型";

  return (
    <div className="studio">
      <main className="main-content" aria-label="提示词工作台">
        <section className="settings-section" aria-label="工作模式与设置">
          <div className="workbench-toolbar">
            <div className="workspace-tabs" role="tablist" aria-label="提示词工作模式" onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "prompt" : event.key === "End" ? "layout" : workspaceMode === "layout" ? "prompt" : "layout";
              setWorkspaceMode(next); document.getElementById(`tab-${next}`)?.focus();
            }}>
              <button type="button" role="tab" id="tab-prompt" aria-controls="panel-prompt" aria-selected={workspaceMode === "prompt"} tabIndex={workspaceMode === "prompt" ? 0 : -1} onClick={() => setWorkspaceMode("prompt")}>普通提示词</button>
              <button type="button" role="tab" id="tab-layout" aria-controls="panel-layout" aria-selected={workspaceMode === "layout"} tabIndex={workspaceMode === "layout" ? 0 : -1} onClick={() => setWorkspaceMode("layout")}>Bbox 布局 <span>JSON</span></button>
            </div>
            <div className="toolbar-settings">
              <div className={`connection-indicator ${ready ? "is-ready" : ""}`} role="status">
                {connection === "checking" ? <LoaderCircle className="spin" size={12} /> : <span className="status-dot" />}<span>{connectionLabel}</span>
              </div>
              <button className="settings-toggle" type="button" aria-expanded={settingsOpen} aria-controls="settings-content" onClick={() => setSettingsOpen(!settingsOpen)}>
                <Settings2 size={15} /><span>模型设置</span><ChevronDown size={14} className={settingsOpen ? "chevron-open" : ""} />
              </button>
            </div>
          </div>
          {settingsOpen && <form id="settings-content" className="settings-form" onSubmit={saveSettings} autoComplete="off">
            <div className="settings-fields">
              <div className="field"><label htmlFor="provider">API 端点预设</label><select id="provider" value={providerId} disabled={settingsBusy} onChange={(event) => changeProvider(event.target.value)}>{PROVIDER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}<option value="custom">自定义 OpenAI Chat Completions</option></select></div>
              <div className="field"><label htmlFor="api-endpoint">API 基础地址</label><input id="api-endpoint" type="url" value={endpoint} onChange={(event) => changeEndpoint(event.target.value)} readOnly={providerId !== "custom"} disabled={settingsBusy} autoComplete="off" spellCheck={false} maxLength={2048} placeholder="https://api.example.com/v1" required /></div>
              <div className="field"><label htmlFor="api-key">API 密钥</label><input id="api-key" type="password" value={apiKey} onChange={(event) => { resetDiscovery(); setApiKey(event.target.value); }} autoComplete="off" spellCheck={false} maxLength={4096} disabled={settingsBusy} placeholder={canKeepKey ? "留空保留此端点已保存的密钥" : "填写此端点对应的 API 密钥"} required={!canKeepKey} /><p className="settings-field-hint">{canKeepKey ? "此端点已有本地密钥；留空可继续使用，不会回显。" : "每个端点独立保存密钥，不会把其他端点的密钥转发至此。"}</p></div>
              <div className="field"><div className="settings-label-row"><label htmlFor="available-model">可用模型</label><button type="button" className="text-button" disabled={settingsBusy || listingModels || !modelsListSupported || !normalizedEndpoint || (!apiKey.trim() && !canKeepKey)} onClick={() => void discoverModels()}>{listingModels && <LoaderCircle size={12} className="spin" />}{listingModels ? "获取中…" : "获取模型"}</button></div><select id="available-model" value={availableModels.includes(selectedModel) ? selectedModel : ""} disabled={settingsBusy || listingModels || !availableModels.length} onChange={(event) => { setSelectedModel(event.target.value); setSettingsMessage(""); }}><option value="">{!modelsListSupported ? "此预设请在下方手动填写模型 ID" : availableModels.length ? "选择模型，或在下方手动填写" : "先获取列表，或手动填写模型 ID"}</option>{availableModels.map((item) => <option key={item} value={item}>{item}</option>)}</select>{!modelsListSupported && <p className="settings-field-hint">此预设尚未确认兼容的模型列表接口，请手动填写模型 ID。</p>}</div>
              <div className="field settings-model-field"><label htmlFor="model">模型 ID（可手动填写）</label><input id="model" value={selectedModel} onChange={(event) => { setSelectedModel(event.target.value); setSettingsMessage(""); }} disabled={settingsBusy || listingModels} maxLength={256} autoComplete="off" spellCheck={false} placeholder="填写此端点支持的 Chat Completions 模型 ID" required /></div>
            </div>
            <p className="settings-consent">配置仅保存在当前浏览器（未加密）。</p>
            <div className="settings-actions"><button type="button" className="clear-button" onClick={clearSettings} disabled={settingsBusy || listingModels}>清除本机配置</button><span className={settingsError ? "settings-error" : "settings-success"} role="status">{settingsError || settingsMessage}</span><button className="save-button" type="submit" disabled={(!apiKey.trim() && !canKeepKey) || !normalizedEndpoint || !selectedModel.trim() || settingsBusy || listingModels}>{saving && <LoaderCircle size={13} className="spin" />}{saving ? "正在保存…" : "保存配置"}</button></div>
            <div className="settings-about">基于 <a href="https://github.com/Moeblack/moss-image-prompt-skill" target="_blank" rel="noopener noreferrer">moss-image-prompt-skill</a><span>·</span><a href="https://creativecommons.org/licenses/by-nc-nd/4.0/" target="_blank" rel="noopener noreferrer">CC BY-NC-ND 4.0</a></div>
          </form>}
        </section>

        {connection === "error" && <div className="connection-notice"><CircleAlert size={15} /><p>无法读取本机配置，请检查浏览器存储权限或清除本机配置。你仍可编辑内容与直接生成 JSON。</p><button type="button" onClick={() => { setConnection("checking"); void checkConnection(); }} className="text-button">重新检查<RotateCcw size={12} /></button></div>}

        <div id="panel-layout" role="tabpanel" aria-labelledby="tab-layout" hidden={workspaceMode !== "layout"}>
          <BboxWorkbench ready={ready} connection={activeConnection} saving={saving || loading || listingModels} onBusyChange={setLayoutBusy} />
        </div>
        <div id="panel-prompt" role="tabpanel" aria-labelledby="tab-prompt" hidden={workspaceMode !== "prompt"}>
        <div className="workspace">
          <form className="panel input-panel" onSubmit={enhance}>
            <div className="panel-heading"><div className="panel-title"><span className="step-number">01</span><h2>画面描述</h2></div></div>
            <div className="input-content">
              {outputFormat === "layout" && <div className="prompt-output-dimensions">
                  <select id="prompt-resolution" aria-label="出图尺寸预设" value={presetResolution} disabled={loading} onChange={(event) => { if (!event.target.value) return; const [width, height] = event.target.value.split("x"); setOutputWidth(width); setOutputHeight(height); setError(""); }}>
                    <option value="">自定义尺寸</option>
                    {RESOLUTION_PRESETS.map((group) => <optgroup key={group.group} label={group.group}>{group.sizes.map(([ratio, width, height]) => <option key={`${width}x${height}`} value={`${width}x${height}`}>{group.group} · {ratio}</option>)}</optgroup>)}
                  </select>
                  <label htmlFor="prompt-width">宽<input id="prompt-width" aria-label="Layout JSON 出图宽度" type="number" min={64} max={4096} step={16} value={outputWidth} disabled={loading} onChange={(event) => { setOutputWidth(event.target.value); setError(""); }} required title="64–4096，16 的倍数" /></label>
                  <span aria-hidden="true">×</span>
                  <label htmlFor="prompt-height">高<input id="prompt-height" aria-label="Layout JSON 出图高度" type="number" min={64} max={4096} step={16} value={outputHeight} disabled={loading} onChange={(event) => { setOutputHeight(event.target.value); setError(""); }} required title="64–4096，16 的倍数" /></label>
              </div>}
              <div className="field">
                <div className="field-label-row"><label htmlFor="prompt">画面内容</label><span>必填</span></div>
                <textarea id="prompt" name="prompt" ref={promptRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="主体、场景、氛围…" className="prompt-input" maxLength={6000} disabled={loading} required />
              </div>
              <fieldset className="mode-field"><legend>画面类型</legend><div className="mode-options">{(["写实", "二次元", "跨次元"] as Mode[]).map((item) => <label key={item} className={mode === item ? "mode-option selected" : "mode-option"}><input type="radio" name="mode" value={item} checked={mode === item} disabled={loading} onChange={() => setMode(item)} />{item}</label>)}</div></fieldset>
              <div className="field preference-field">
                <div className="field-label-row"><label htmlFor="preferences">风格与其他要求</label><span>选填</span></div>
                <textarea id="preferences" name="preferences" value={preferences} onChange={(event) => setPreferences(event.target.value)} placeholder="画风、构图、需要保留的细节…" className="preference-input" maxLength={2000} disabled={loading} />
              </div>
              {error && <div className="error-message" role="alert"><CircleAlert size={16} /><p>{error}</p></div>}
            </div>
            <div className="input-actions">
                <button className="clear-button" type="button" onClick={clear} disabled={loading || (!prompt && !preferences && !result && !error)}><RotateCcw size={14} />清空</button>
                <div className="prompt-submit-actions">
                  <label htmlFor="output-format" className="sr-only">输出</label>
                  <select id="output-format" value={outputFormat} disabled={loading} onChange={(event) => { setOutputFormat(event.target.value as OutputFormat); setError(""); }}><option value="text">普通文本</option><option value="layout">Layout JSON</option></select>
                  <button className="enhance-button" type="submit" disabled={!ready || !prompt.trim() || loading || saving || layoutBusy || listingModels || (outputFormat === "layout" && !outputDimensionsValid)}>{loading ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{loading ? "正在生成…" : outputFormat === "layout" ? "生成布局 JSON" : "增强提示词"}{!loading && <ArrowRight size={15} className="button-arrow" />}</button>
                </div>
            </div>
            {!ready && <div className="panel-footnote">增强需先配置模型。</div>}
          </form>

          <section className="panel output-panel" aria-labelledby="output-title" aria-busy={loading}>
            <div className="panel-heading"><div className="panel-title"><span className="step-number">02</span><h2 id="output-title">{(result ? !!result.dimensions : outputFormat === "layout") ? "Layout JSON" : "增强后的提示词"}</h2></div><button type="button" className="copy-button" onClick={() => void copy()} disabled={!result || loading}>{copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}{copyState === "copied" ? "已复制" : "复制"}</button></div>
            <div className="output-content">
              {loading ? <div className="empty-state loading-state" role="status"><LoaderCircle className="spin" size={20} /><span>正在生成…</span></div>
              : result ? <textarea ref={outputRef} className={`result-text${result.dimensions ? " prompt-json-text" : ""}`} value={result.text} readOnly aria-label={result.dimensions ? "Layout JSON 内容" : "增强后的提示词内容"} spellCheck={false} wrap={result.dimensions ? "off" : "soft"} />
              : <div className="empty-state"><span>{outputFormat === "layout" ? "等待生成布局 JSON" : "等待生成提示词"}</span></div>}
            </div>
            <div className="panel-footnote output-footnote" aria-live="polite"><div className="prompt-result-status">{result?.dimensions && <span className="prompt-result-size">出图尺寸 {result.dimensions.width} × {result.dimensions.height}</span>}<span>{copyState === "failed" ? "自动复制不可用，已选中文本，请手动复制。" : copyState === "copied" ? "已复制到剪贴板。" : ""}</span></div>{ready && <span className="model-name" title={model}>{model}</span>}</div>
          </section>
        </div>
        </div>
      </main>
    </div>
  );
}
