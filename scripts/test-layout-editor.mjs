import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../lib/layout-editor.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { moveBox, resizeBox, scaleBox } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("dragging clamps at all canvas boundaries without changing rectangle dimensions", () => {
  const box = [100, 200, 400, 500];
  assert.deepEqual(moveBox(box, -500, 9999, 1024, 768), [0, 468, 300, 768]);
  assert.deepEqual(moveBox(box, 9999, -500, 1024, 768), [724, 0, 1024, 300]);
  assert.deepEqual(box, [100, 200, 400, 500]);
});

test("all four resize corners clamp to a positive box and preserve opposite corner", () => {
  const box = [100, 200, 400, 500];
  assert.deepEqual(resizeBox(box, "nw", 500, 600, 1024, 768), [399, 499, 400, 500]);
  assert.deepEqual(resizeBox(box, "ne", 0, 600, 1024, 768), [100, 499, 101, 500]);
  assert.deepEqual(resizeBox(box, "sw", 500, 0, 1024, 768), [399, 200, 400, 201]);
  assert.deepEqual(resizeBox(box, "se", 9999, 9999, 1024, 768), [100, 200, 1024, 768]);
  assert.deepEqual(resizeBox(box, "nw", -999, -999, 1024, 768), [0, 0, 400, 500]);
});

test("canvas resizing scales coordinates on each axis, keeps tiny and edge boxes valid", () => {
  assert.deepEqual(scaleBox([128, 96, 896, 224], 1024, 1024, 2048, 512), [256, 48, 1792, 112]);
  assert.deepEqual(scaleBox([1023, 1023, 1024, 1024], 1024, 1024, 64, 64), [63, 63, 64, 64]);
  assert.deepEqual(scaleBox([0, 0, 1024, 1024], 1024, 1024, 640, 960), [0, 0, 640, 960]);
});

test("repeated drag, corner resize and canvas scaling stays finite, integer and in bounds", () => {
  let box = [20, 40, 400, 600];
  for (let i = 0; i < 500; i++) {
    box = moveBox(box, Math.sin(i) * 800, Math.cos(i) * 800, 1024, 768);
    box = resizeBox(box, ["nw", "ne", "sw", "se"][i % 4], Math.sin(i * 2) * 1200, Math.cos(i * 2) * 1200, 1024, 768);
    assert.ok(box.every(Number.isInteger));
    assert.ok(box[0] >= 0 && box[1] >= 0 && box[2] <= 1024 && box[3] <= 768 && box[0] < box[2] && box[1] < box[3]);
  }
});
