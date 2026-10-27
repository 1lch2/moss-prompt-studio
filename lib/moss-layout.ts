import { z } from "zod";

/** The editor uses top-left-origin, absolute pixel xyxy coordinates. */
const coordinate = z.number().finite();
const caption = z.string().trim().min(1, "请填写区域描述。").max(2000);
const regionSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.enum(["object", "character", "text"]),
  caption,
  text: z.string().max(4000).optional(),
  box: z.tuple([coordinate, coordinate, coordinate, coordinate]),
}).strict().superRefine((region, ctx) => {
  if (region.label === "text" && !region.text?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "文字区域需要填写原文。" });
  }
  if (region.label !== "text" && region.text) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "仅文字区域可包含原文。" });
  }
});

export const layoutDimensionSchema = z.number().int().min(64).max(4096).multipleOf(16);
const baseDraftSchema = z.object({
  width: layoutDimensionSchema,
  height: layoutDimensionSchema,
  summary: z.string().trim().min(1, "请填写全局提示词。").max(6000),
  regions: z.array(regionSchema).min(1, "请添加至少一个区域。").max(24),
}).strict();

export type LayoutRegion = z.infer<typeof regionSchema>;
export type LayoutDraft = z.infer<typeof baseDraftSchema>;

// Official compiler rounds pixel coordinates to 9 decimal places before floor/ceil.
// toFixed avoids magnifying near-integer floating-point noise during scaling.
function round9(value: number) { return Number(value.toFixed(9)); }

function validateGeometry(draft: LayoutDraft, ctx: z.RefinementCtx) {
  const ids = new Set<string>();
  for (const [index, region] of draft.regions.entries()) {
    if (ids.has(region.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["regions", index, "id"], message: "区域标识不能重复。" });
    }
    ids.add(region.id);
    const [x1, y1, x2, y2] = region.box;
    if (x1 < 0 || y1 < 0 || x2 > draft.width || y2 > draft.height || x1 >= x2 || y1 >= y2 ||
      Math.floor(round9(x1)) >= Math.ceil(round9(x2)) || Math.floor(round9(y1)) >= Math.ceil(round9(y2))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["regions", index, "box"], message: "区域必须位于画布内，且宽高大于 0。" });
    }
  }
}

export const layoutDraftSchema = baseDraftSchema.superRefine(validateGeometry);
export const layoutEnhanceRequestSchema = baseDraftSchema.extend({
  mode: z.enum(["写实", "二次元", "跨次元"]).default("写实"),
  preferences: z.string().max(2000).optional(),
}).superRefine(validateGeometry);
export type LayoutEnhanceRequest = z.infer<typeof layoutEnhanceRequestSchema>;

export type MossLayoutPrompt = {
  summary: { caption: string };
  items: Array<{
    label: LayoutRegion["label"];
    caption: string;
    text?: string;
    bbox: [number, number, number, number];
  }>;
  bbox_coord_space: "abs_centralized";
  bbox_format: "yxyx";
};

const generatedItemSchema = z.object({
  label: z.enum(["object", "character", "text"]),
  caption,
  text: z.string().max(4000).optional(),
  bbox: z.tuple([coordinate.int(), coordinate.int(), coordinate.int(), coordinate.int()]),
}).strict().superRefine((item, ctx) => {
  if (item.label === "text" && !item.text?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "文字区域需要填写原文。" });
  }
  if (item.label !== "text" && Object.prototype.hasOwnProperty.call(item, "text")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "仅文字区域可包含原文。" });
  }
});
const generatedLayoutSchema = z.object({
  summary: z.object({ caption: z.string().trim().min(1).max(6000) }).strict(),
  items: z.array(generatedItemSchema).min(1).max(24),
  bbox_coord_space: z.literal("abs_centralized"),
  bbox_format: z.literal("yxyx"),
}).strict();

/** Validate model-designed canonical JSON without repairing coordinates or stripping fields. */
export function validateGeneratedLayout(input: unknown, width: number, height: number): MossLayoutPrompt {
  layoutDimensionSchema.parse(width);
  layoutDimensionSchema.parse(height);
  const layout = generatedLayoutSchema.parse(input);
  for (const { bbox: [y1, x1, y2, x2] } of layout.items) {
    if (y1 < -height / 2 || x1 < -width / 2 || y2 > height / 2 || x2 > width / 2 || y1 >= y2 || x1 >= x2) {
      throw new Error("模型返回的区域必须位于画布内，且宽高大于 0。");
    }
  }
  return layout;
}

/** Canonical model prompt: no dimensions, editor IDs, colors or preferences leak out. */
export function compileLayout(input: LayoutDraft): MossLayoutPrompt {
  const draft = layoutDraftSchema.parse(input);
  return {
    summary: { caption: draft.summary },
    items: draft.regions.map((region) => {
      const [x1, y1, x2, y2] = region.box;
      return {
        label: region.label,
        caption: region.caption,
        ...(region.label === "text" ? { text: region.text! } : {}),
        bbox: [
          Math.floor(round9(y1)) - draft.height / 2,
          Math.floor(round9(x1)) - draft.width / 2,
          Math.ceil(round9(y2)) - draft.height / 2,
          Math.ceil(round9(x2)) - draft.width / 2,
        ] as [number, number, number, number],
      };
    }),
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  };
}

const enhancedSchema = z.object({
  summary: z.string().trim().min(1).max(6000),
  regions: z.array(z.object({ id: z.string().min(1).max(80), caption }).strict()).min(1).max(24),
}).strict();
export type EnhancedLayout = z.infer<typeof enhancedSchema>;

/** Only prose can come from the model; identities are matched, not trusted by order. */
export function validateEnhancedLayout(input: unknown, draft: LayoutDraft): EnhancedLayout {
  const enhanced = enhancedSchema.parse(input);
  const captions = new Map(enhanced.regions.map((region) => [region.id, region.caption]));
  if (enhanced.regions.length !== draft.regions.length || captions.size !== draft.regions.length ||
    draft.regions.some((region) => !captions.has(region.id))) {
    throw new Error("模型返回的区域标识不匹配；未应用任何更改。");
  }
  return { summary: enhanced.summary, regions: draft.regions.map(({ id }) => ({ id, caption: captions.get(id)! })) };
}

export function applyEnhancedLayout(draft: LayoutDraft, input: unknown): LayoutDraft {
  const enhanced = validateEnhancedLayout(input, draft);
  const captions = new Map(enhanced.regions.map((region) => [region.id, region.caption]));
  return {
    width: draft.width,
    height: draft.height,
    summary: enhanced.summary,
    regions: draft.regions.map((region) => ({ ...region, box: [...region.box], caption: captions.get(region.id)! })),
  };
}
