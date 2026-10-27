import { normalizeEndpoint } from "./model-providers";
import { ModelServiceError } from "./model-errors";

export function validModelId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
}
export function cleanApiKey(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ModelServiceError("API 密钥格式不正确。", 400);
  }
  return value.trim();
}
export function checkedEndpoint(value: string): string {
  try { return normalizeEndpoint(value); }
  catch (error) { throw new ModelServiceError(error instanceof Error ? error.message : "API 端点无效。", 400); }
}
