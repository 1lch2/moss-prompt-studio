import { DEFAULT_ENDPOINT, findPreset, supportsModelListing } from "./model-providers";
import { ModelServiceError, providerError, readBoundedText } from "./model-errors";
import { checkedEndpoint, cleanApiKey, validModelId } from "./model-settings";

export type ModelConnection = { endpoint: string; model: string; apiKey: string };
export type ChatMessage = { role: "system" | "user"; content: string };
export function completionBody(settings: ModelConnection, messages: ChatMessage[], maxTokens: number, jsonMode = false) {
  const endpoint = checkedEndpoint(settings.endpoint);
  const preset = findPreset(endpoint);
  return {
    model: settings.model,
    stream: false,
    // Vendor fields apply to exact known endpoints, never a custom model-name impersonator.
    ...(preset?.id === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(endpoint === DEFAULT_ENDPOINT ? { thinking: { type: "disabled" } } : {}),
    ...(jsonMode && endpoint === DEFAULT_ENDPOINT ? { response_format: { type: "json_object" } } : {}),
    messages,
  };
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
    try { return JSON.parse(body); }
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
  const data = await requestJson(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(completionBody({ ...settings, endpoint }, messages, maxTokens, jsonMode)),
  }, 500000, false, fetcher, callerSignal, 110000) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null;
  const result = data?.choices?.[0];
  if (typeof result?.message?.content !== "string" || !result.message.content.trim()) {
    throw new ModelServiceError("模型没有返回有效内容，请重试。");
  }
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
