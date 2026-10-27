/** Public, client-safe endpoint metadata. Keys never belong in this module. */
export const DEFAULT_ENDPOINT = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-flash";
export const PROVIDER_PRESETS = [
  { id: "deepseek", label: "DeepSeek", endpoint: DEFAULT_ENDPOINT },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1" },
  { id: "qwen-cn", label: "通义千问 · 中国内地", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "qwen-intl", label: "通义千问 · 国际（新加坡）", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { id: "moonshot", label: "Moonshot / Kimi", endpoint: "https://api.moonshot.cn/v1" },
  { id: "zhipu", label: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "siliconflow", label: "硅基流动 SiliconFlow", endpoint: "https://api.siliconflow.cn/v1" },
] as const;

/** Reject special-use IPv4 and non-global IPv6, including mapped/transition forms. */
export function isPublicAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":")) {
    if (!/^[0-9a-f:]+$/.test(host)) return false;
    const halves = host.split("::");
    if (halves.length > 2) return false;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return false;
    const missing = 8 - left.length - right.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return false;
    const words = [...left, ...Array(missing).fill("0"), ...right].map((part) => parseInt(part, 16));
    if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
    if (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) return false;
    if (words[0] === 0x2002 || (words[0] === 0x3fff && words[1] < 0x1000)) return false;
    return true;
  }
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export function normalizeEndpoint(input: string): string {
  if (typeof input !== "string" || input.length > 2048 || /[\x00-\x20\x7f\\]/.test(input.trim())) {
    throw new Error("请填写有效的 HTTPS API 端点。");
  }
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("请填写完整的 HTTPS API 端点。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || input.includes("?") || input.includes("#")) {
    throw new Error("API 端点必须使用 HTTPS，且不能含账号、查询参数或片段。");
  }
  const host = url.hostname.toLowerCase();
  if (!host || host.endsWith(".") || (!host.includes(".") && !host.includes(":")) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(host) ||
      host === "metadata.google.internal" || host === "metadata.google" ||
      ((host.startsWith("[") || /^[\d.]+$/.test(host)) && !isPublicAddress(host))) {
    throw new Error("API 端点必须指向公网服务，不能使用本地、内网或保留地址。");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) path = path.slice(0, -"/chat/completions".length).replace(/\/+$/, "");
  url.pathname = path || "/";
  return url.origin + (url.pathname === "/" ? "" : url.pathname);
}

export function findPreset(endpoint: string) {
  let normalized: string;
  try { normalized = normalizeEndpoint(endpoint); } catch { return undefined; }
  return PROVIDER_PRESETS.find((provider) => provider.endpoint === normalized);
}

/** Only these exact presets lack a verified compatible model-list endpoint. */
export function supportsModelListing(endpoint: string): boolean {
  const preset = findPreset(endpoint);
  return preset?.id !== "qwen-cn" && preset?.id !== "qwen-intl" && preset?.id !== "zhipu";
}
