/** Common presets calculated from https://github.com/OpenMOSS/MOSS-Image/blob/main/gradio_presets.py.
 * Image references are editor-only browser object URLs; never part of LayoutDraft. */
export const RESOLUTION_PRESETS: ReadonlyArray<{ group: string; sizes: ReadonlyArray<readonly [string, number, number]> }> = [
  { group: "1M", sizes: [["1:1", 1024, 1024], ["4:3", 1184, 880], ["3:4", 880, 1184], ["3:2", 1248, 832], ["2:3", 832, 1248], ["16:9", 1360, 768], ["9:16", 768, 1360]] },
  { group: "1.5M", sizes: [["1:1", 1248, 1248], ["4:3", 1456, 1088], ["3:4", 1088, 1456], ["3:2", 1536, 1024], ["2:3", 1024, 1536], ["16:9", 1680, 944], ["9:16", 944, 1680]] },
  { group: "2M", sizes: [["1:1", 1456, 1456], ["4:3", 1680, 1248], ["3:4", 1248, 1680], ["3:2", 1776, 1184], ["2:3", 1184, 1776], ["16:9", 1936, 1088], ["9:16", 1088, 1936]] },
] as const;

export type CanvasReference = { url: string; name: string; width: number; height: number; naturalWidth: number; naturalHeight: number };
export const REFERENCE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp";

export function roundedImageDimensions(width: number, height: number) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw new Error("无法读取图片尺寸，请选择有效的图片文件。");
  const rounded = { width: Math.round(width / 16) * 16, height: Math.round(height / 16) * 16 };
  if (![rounded.width, rounded.height].every((value) => value >= 64 && value <= 4096)) throw new Error(`图片尺寸 ${width} × ${height} 超出画布范围；取整后宽高须在 64–4096 之间。`);
  return rounded;
}

/** Metadata is sometimes absent for dragged files. Sniff only supported raster headers, then decode. */
export function hasRasterImageHeader(bytes: Uint8Array) {
  const matches = (offset: number, values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  const ascii = (offset: number, value: string) => matches(offset, Array.from(value, (character) => character.charCodeAt(0)));
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) || matches(0, [255, 216, 255]) ||
      ascii(0, "GIF87a") || ascii(0, "GIF89a") || ascii(0, "BM") || (ascii(0, "RIFF") && ascii(8, "WEBP"))) return true;
  if (!ascii(4, "ftyp")) return false;
  // AVIF's major brand or a compatible brand; skip the minor-version field at byte 12.
  for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
    if (offset !== 12 && (ascii(offset, "avif") || ascii(offset, "avis"))) return true;
  }
  return false;
}

async function isSupportedImage(file: File) {
  if (!file.size) return false;
  if (file.type && file.type !== "application/octet-stream") return /^image\/(png|jpeg|webp|gif|avif|bmp|x-ms-bmp)$/i.test(file.type);
  try { return hasRasterImageHeader(new Uint8Array(await file.slice(0, 64).arrayBuffer())); }
  catch { return false; }
}

/** Owns both decoded and pending object URLs. Newer loads and clear() invalidate old results. */
export class LocalReferenceImageLoader {
  private generation = 0;
  private currentUrl: string | null = null;
  private cancelPending: (() => void) | null = null;

  async load(file: File): Promise<CanvasReference | null> {
    const generation = ++this.generation;
    this.cancelPending?.();
    this.cancelPending = null;
    const supported = await isSupportedImage(file);
    if (generation !== this.generation) return null;
    if (!supported) throw new Error("请选择 PNG、JPEG、WebP、GIF、AVIF 或 BMP 图片文件。");
    const url = URL.createObjectURL(file);
    const image = new Image();
    let retained = false;
    try {
      const loaded = await new Promise<boolean>((resolve, reject) => {
        const cleanup = () => { image.onload = null; image.onerror = null; };
        this.cancelPending = () => { cleanup(); image.src = ""; resolve(false); };
        image.onload = () => { cleanup(); resolve(true); };
        image.onerror = () => { cleanup(); reject(new Error("图片无法解码，请换一张有效图片。原有底图与布局已保留。")); };
        image.src = url;
      });
      if (!loaded || generation !== this.generation) return null;
      const dimensions = roundedImageDimensions(image.naturalWidth, image.naturalHeight);
      if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = url;
      retained = true;
      return { url, name: file.name, ...dimensions, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
    } catch (cause) {
      if (generation !== this.generation) return null;
      throw cause;
    } finally {
      if (!retained) URL.revokeObjectURL(url);
      if (generation === this.generation) this.cancelPending = null;
    }
  }

  clear() {
    ++this.generation;
    this.cancelPending?.();
    this.cancelPending = null;
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = null;
  }
}
