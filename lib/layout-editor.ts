/** Integer-pixel editing helpers; geometric changes never touch prompts or literal text. */
export type PixelBox = [number, number, number, number];
export type ResizeCorner = "nw" | "ne" | "sw" | "se";
export const clampPixel = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function moveBox(box: PixelBox, dx: number, dy: number, width: number, height: number): PixelBox {
  const [x1, y1, x2, y2] = box;
  const x = clampPixel(Math.round(dx), -x1, width - x2);
  const y = clampPixel(Math.round(dy), -y1, height - y2);
  return [x1 + x, y1 + y, x2 + x, y2 + y];
}

export function resizeBox(box: PixelBox, corner: ResizeCorner, x: number, y: number, width: number, height: number): PixelBox {
  const [x1, y1, x2, y2] = box;
  return [
    corner.includes("w") ? clampPixel(Math.round(x), 0, x2 - 1) : x1,
    corner.includes("n") ? clampPixel(Math.round(y), 0, y2 - 1) : y1,
    corner.includes("e") ? clampPixel(Math.round(x), x1 + 1, width) : x2,
    corner.includes("s") ? clampPixel(Math.round(y), y1 + 1, height) : y2,
  ];
}

export function scaleBox(box: PixelBox, oldWidth: number, oldHeight: number, width: number, height: number): PixelBox {
  const x1 = clampPixel(Math.round(box[0] / oldWidth * width), 0, width - 1);
  const y1 = clampPixel(Math.round(box[1] / oldHeight * height), 0, height - 1);
  return [x1, y1,
    clampPixel(Math.round(box[2] / oldWidth * width), x1 + 1, width),
    clampPixel(Math.round(box[3] / oldHeight * height), y1 + 1, height),
  ];
}
