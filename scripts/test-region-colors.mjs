import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/region-colors.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { REGION_COLORS, nextRegionColor, assignRegionColor, releaseRegionColor } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("all 24 region colors are unique and support readable white labels", () => {
  assert.equal(REGION_COLORS.length, 24);
  assert.equal(new Set(REGION_COLORS).size, 24);
  for (const color of REGION_COLORS) {
    assert.match(color, /^#[0-9A-F]{6}$/);
    const [r, g, b] = color.match(/[0-9A-F]{2}/g).map((hex) => parseInt(hex, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    assert.ok(1.05 / (.2126 * r + .7152 * g + .0722 * b + .05) >= 4.5, color);
  }
});

test("allocation follows identity and is stable when an existing ID is revisited", () => {
  let colors = {};
  for (let id = 1; id <= 24; id++) {
    const preview = nextRegionColor(colors);
    const previous = colors;
    colors = assignRegionColor(colors, `region-${id}`);
    assert.equal(colors[`region-${id}`], preview);
    for (const [existingId, color] of Object.entries(previous)) assert.equal(colors[existingId], color);
    assert.equal(assignRegionColor(colors, `region-${id}`), colors);
  }
  assert.equal(new Set(Object.values(colors)).size, 24);
  assert.equal(nextRegionColor(colors), undefined);
  assert.throws(() => assignRegionColor(colors, "region-25"), /24/);
});

test("deleting and replacing a region frees only its color, even after repeated churn", () => {
  let colors = {};
  for (let id = 1; id <= 24; id++) colors = assignRegionColor(colors, `region-${id}`);
  for (let replacement = 25; replacement <= 150; replacement++) {
    const removedId = Object.keys(colors)[7];
    const previous = colors;
    const freed = colors[removedId];
    colors = releaseRegionColor(colors, removedId);
    assert.equal(previous[removedId], freed); // Helpers do not mutate React state.
    assert.equal(colors[removedId], undefined);
    assert.equal(nextRegionColor(colors), freed);
    colors = assignRegionColor(colors, `region-${replacement}`);
    assert.equal(colors[`region-${replacement}`], freed);
    for (const [id, color] of Object.entries(previous)) if (id !== removedId) assert.equal(colors[id], color);
    assert.equal(new Set(Object.values(colors)).size, 24);
  }
  for (const id of Object.keys(colors)) colors = releaseRegionColor(colors, id);
  assert.deepEqual(colors, {});
  assert.equal(nextRegionColor(colors), REGION_COLORS[0]);
});

test("canvas, list, handles and preview share editor-only colors; model draft stays clean", async () => {
  const component = await readFile(new URL("../components/bbox-workbench.tsx", import.meta.url), "utf8");
  assert.match(component, /background: regionColors\[region\.id\]/);
  assert.match(component, /const color = regionColors\[region\.id\]/);
  assert.match(component, /stroke=\{regionColors\[selected\.id\]\}/);
  assert.match(component, /fill=\{previewColor\} fillOpacity=\{\.12\} stroke=\{previewColor\}/);
  assert.match(component, /const draft: LayoutDraft = \{ width, height, summary, regions \}/);
  assert.match(component, /enhanceLayoutWithModel\(\{ \.\.\.draft, mode, preferences \}, connection, fetch, controller\.signal\)/);
  assert.doesNotMatch(component, /COLORS\[region\.label\]|isSelected \? "#222222"/);
  // Only add/remove write the map, so selection, type/prose edits and resizing cannot recolor it.
  assert.equal((component.match(/setRegionColors\(/g) ?? []).length, 2);
});
