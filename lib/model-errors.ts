export class ModelServiceError extends Error {
  constructor(message: string, public status = 502) { super(message); this.name = "ModelServiceError"; }
}

/** Enforce an actual byte limit even without a trustworthy Content-Length. */
export async function readBoundedText(source: Request | Response, maxBytes: number): Promise<string> {
  if (Number(source.headers.get("content-length")) > maxBytes) {
    await source.body?.cancel();
    throw new ModelServiceError("输入或返回内容过长，请缩短后重试。", 413);
  }
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ModelServiceError("输入或返回内容过长，请缩短后重试。", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function providerError(status: number, models = false): ModelServiceError {
  return new ModelServiceError(status === 401 ? "API 密钥无效或与所选端点不匹配，请检查设置。" :
    status === 403 ? "API 无访问权限，请检查所选端点、密钥和模型权限。" :
    status === 402 ? "API 账户额度不足，请检查服务商账户。" :
    status === 429 ? "API 请求受限或额度不足，请稍后重试并检查账户。" :
    models ? "无法获取模型列表；此端点可能不支持列表，可手动填写模型 ID。" :
    "模型服务暂时无法完成请求，请检查模型兼容性或稍后重试。");
}
