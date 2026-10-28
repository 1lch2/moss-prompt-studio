import { DEFAULT_ENDPOINT, findPreset, supportsModelListing } from "./model-providers";
import { ModelServiceError, providerError, readBoundedText } from "./model-errors";
import { checkedEndpoint, cleanApiKey, validModelId } from "./model-settings";

export type ModelConnection = { endpoint: string; model: string; apiKey: string };
export type ChatMessage = { role: "system" | "user"; content: string };

type ThinkingOptions = { thinking?: { type: "enabled" }; reasoning_effort?: "medium"; enable_thinking?: true; thinking_budget?: number; stream?: true };
/** Known provider/model contracts only. An OpenAI-compatible URL alone says nothing about reasoning support. */
function thinkingConfig(endpoint: string, model: string): { options: ThinkingOptions; totalBudget?: number } | undefined {
  const provider = findPreset(endpoint)?.id ?? (endpoint === `${DEFAULT_ENDPOINT}/v1` ? "deepseek" : undefined);
  const id = model.toLowerCase();
  const enabled = { thinking: { type: "enabled" as const } };
  const separateBudget = { enable_thinking: true as const, thinking_budget: 8192 };
  if (provider === "deepseek" && /^(deepseek-flash|deepseek-v4-(pro|flash|flash-vision-exp))$/.test(id)) {
    return { options: enabled, totalBudget: 32768 };
  }
  if (provider === "openai" && /^(o1|o3|o3-mini|o4-mini|gpt-5(?:-mini|-nano|\.1|\.2|\.4(?:-mini|-nano)?|\.5)?|gpt-5\.6-(sol|terra|luna)|gpt-6-(astra|sol|luna)|gpt-6\.1-(sol|terra))(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return { options: { reasoning_effort: "medium" }, totalBudget: 32768 };
  }
  if (provider === "moonshot") {
    if (/^kimi-k2\.[56]$/.test(id)) return { options: enabled, totalBudget: 32768 };
    // Dedicated reasoning models (notably K3) do not accept the hybrid thinking switch.
    if (/^kimi-(k2-thinking(?:-turbo)?|k2\.7-code(?:-highspeed)?|k3|k3\.1-pro(?:-highspeed)?)$/.test(id)) return { options: {}, totalBudget: 32768 };
  }
  if (provider === "zhipu" && /^glm-(4\.[567](?:v)?(?:-air|-airx|-flash|-flashx)?|5(?:\.[123])?(?:-turbo|-code|-code-turbo)?)(?:-\d{8})?$/.test(id)) {
    return { options: id.startsWith("glm-5.3") ? {} : enabled, totalBudget: id.startsWith("glm-4.5v") ? 16384 : 32768 };
  }
  if (provider === "qwen-cn" || provider === "qwen-intl") {
    if (/(instruct|coder|embedding|tts|omni)/.test(id)) return;
    const commercial = /^(qwen-plus|qwen-flash|qwen3-max)(?:-(latest|\d{4}-\d{2}-\d{2}))?$/.exec(id);
    const since = commercial?.[1] === "qwen-plus" ? "2025-04-28" : commercial?.[1] === "qwen-flash" ? "2025-07-28" : "2026-01-23";
    const hybrid = (commercial && (!commercial[2] || commercial[2] === "latest" || commercial[2] >= since)) ||
      /^qwen3-(235b-a22b|32b|30b-a3b|14b|8b)$/.test(id) ||
      /^qwen3\.[5-8]-(plus|flash|max|\d+b(?:-a\d+b)?)(?:-(latest|\d{4}-\d{2}-\d{2}))?$/.test(id);
    if (hybrid) return { options: { ...separateBudget, stream: true } };
    if (/^qwen3[\w.-]*-thinking(?:-\d+)?$/.test(id)) return { options: { thinking_budget: 8192, stream: true } };
    if (/^(qwq|qvq)-(plus|32b|72b-preview)(?:-latest)?$/.test(id)) return { options: { stream: true }, totalBudget: 32768 };
  }
  if (provider === "siliconflow") {
    const name = id.replace(/^pro\//, "");
    const hybrid = /^deepseek-ai\/deepseek-(v3\.[12](?:-terminus|-exp)?|v4(?:-flash|-pro)?)$/.test(name) ||
      /^qwen\/qwen3(?:\.[5-8])?-(\d+b(?:-a\d+b)?)$/.test(name) ||
      /^(zai-org|thudm)\/glm-(4\.[567](?:v)?(?:-air|-flash)?|5(?:\.[12])?)$/.test(name) ||
      /^moonshotai\/kimi-k2\.[56]$/.test(name);
    if (hybrid) return { options: separateBudget };
    if (/^deepseek-ai\/deepseek-r1(?:-[\w.-]+)?$/.test(name) || /^qwen\/(qwq-32b|qwen3[\w.-]*-thinking(?:-\d+)?)$/.test(name)) return { options: { thinking_budget: 8192 } };
  }
}

export function completionBody(settings: ModelConnection, messages: ChatMessage[], maxTokens: number, jsonMode = false) {
  const endpoint = checkedEndpoint(settings.endpoint);
  const preset = findPreset(endpoint);
  const thinking = thinkingConfig(endpoint, settings.model);
  const budget = thinking?.totalBudget ? Math.max(maxTokens, thinking.totalBudget) : maxTokens;
  return {
    model: settings.model,
    stream: false,
    // Vendor fields apply to exact known endpoints, never a custom model-name impersonator.
    ...(preset?.id === "openai" ? { max_completion_tokens: budget } : { max_tokens: budget }),
    ...thinking?.options,
    ...(jsonMode && (endpoint === DEFAULT_ENDPOINT || endpoint === `${DEFAULT_ENDPOINT}/v1`) ? { response_format: { type: "json_object" } } : {}),
    messages,
  };
}

/** Collect final output only; Qwen's open-source thinking models require SSE even without a live-output UI. */
function parseCompletionStream(body: string) {
  let content = "";
  let finishReason: string | undefined;
  let done = false;
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { done = true; break; }
    const chunk = JSON.parse(data);
    if (chunk?.error) throw new Error("Invalid completion");
    const choice = chunk?.choices?.[0];
    // Deliberately ignore reasoning_content (including reasoning-only chunks).
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
  }
  if (!done || !finishReason || new TextEncoder().encode(content).byteLength > 500000) throw new Error("Incomplete completion");
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

/** Own timer/listener so old requests are cleaned up without requiring AbortSignal.any. */
function createRequestSignal(callerSignal: AbortSignal | undefined, timeout: number) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => { clearTimeout(timer); callerSignal?.removeEventListener("abort", cancel); },
  };
}
async function requestJson(
  url: string,
  init: RequestInit,
  maxBytes: number,
  models: boolean,
  fetcher: typeof fetch,
  callerSignal: AbortSignal | undefined,
  timeout: number,
  stream = false,
): Promise<unknown> {
  const request = createRequestSignal(callerSignal, timeout);
  try {
    if (request.signal.aborted) throw new DOMException("请求已取消。", "AbortError");
    const response = await fetcher(url, {
      ...init,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: request.signal,
    });
    if (request.signal.aborted) throw new DOMException("请求已取消。", "AbortError");
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Ignore an already-closed response body. */ }
      throw providerError(response.status, models);
    }
    const body = await readBoundedText(response, maxBytes);
    if (request.signal.aborted) throw new DOMException("请求已取消。", "AbortError");
    try { return stream ? parseCompletionStream(body) : JSON.parse(body); }
    catch { throw new ModelServiceError(models ? "模型列表格式不可用，请手动填写模型 ID。" : "模型没有返回有效内容，请重试。"); }
  } catch (error) {
    if (callerSignal?.aborted) throw new DOMException("请求已取消。", "AbortError");
    if (request.didTimeout() || (error instanceof Error && error.name === "TimeoutError")) {
      throw new ModelServiceError(models ? "获取模型列表超时，可重试或手动填写模型 ID。" : "模型请求超时，请缩短输入或稍后重试。", 504);
    }
    if (error instanceof ModelServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new DOMException("请求已取消。", "AbortError");
    // Never reflect provider/network error text, request headers, or credentials in the UI.
    throw new ModelServiceError("无法连接所选 API 端点，请检查地址、网络与服务商的浏览器跨域支持。");
  } finally { request.cleanup(); }
}

export async function fetchCompletion(
  settings: ModelConnection,
  messages: ChatMessage[],
  maxTokens: number,
  jsonMode = false,
  fetcher: typeof fetch = fetch,
  callerSignal?: AbortSignal,
): Promise<{ content: string; finishReason: string | undefined }> {
  const endpoint = checkedEndpoint(settings.endpoint);
  const key = cleanApiKey(settings.apiKey);
  if (!key || !validModelId(settings.model)) throw new ModelServiceError("请检查 API 密钥和模型设置。", 400);
  const body = completionBody({ ...settings, endpoint }, messages, maxTokens, jsonMode);
  const thinking = thinkingConfig(endpoint, settings.model);
  const data = await requestJson(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, body.stream ? 16000000 : thinking ? 2000000 : 500000, false, fetcher, callerSignal, thinking ? 300000 : 110000, body.stream) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null;
  const result = data?.choices?.[0];
  if (typeof result?.message?.content !== "string" || !result.message.content.trim()) {
    throw new ModelServiceError("模型没有返回有效内容，请重试。");
  }
  if (new TextEncoder().encode(result.message.content).byteLength > 500000) throw new ModelServiceError("返回内容过长，请缩短后重试。", 413);
  return { content: result.message.content, finishReason: typeof result.finish_reason === "string" ? result.finish_reason : undefined };
}

export async function fetchModels(
  settings: Pick<ModelConnection, "endpoint" | "apiKey">,
  fetcher: typeof fetch = fetch,
  callerSignal?: AbortSignal,
): Promise<string[]> {
  const endpoint = checkedEndpoint(settings.endpoint);
  const key = cleanApiKey(settings.apiKey);
  if (!key) throw new ModelServiceError("请填写所选端点的 API 密钥。", 400);
  const preset = findPreset(endpoint);
  if (!supportsModelListing(endpoint)) {
    throw new ModelServiceError("此预设未提供兼容的模型列表接口，请手动填写服务商控制台中的模型 ID。", 400);
  }
  const data = await requestJson(`${endpoint}/models${preset?.id === "siliconflow" ? "?sub_type=chat" : ""}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
  }, 1000000, true, fetcher, callerSignal, 15000) as { data?: { id?: unknown }[] } | null;
  if (!Array.isArray(data?.data)) throw new ModelServiceError("模型列表格式不可用，请手动填写模型 ID。");
  return [...new Set(data.data.map((item) => item?.id).filter((id): id is string => typeof id === "string" && validModelId(id)))].sort().slice(0, 2000);
}
