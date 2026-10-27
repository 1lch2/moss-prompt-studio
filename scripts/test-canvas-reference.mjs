import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../lib/canvas-reference.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { RESOLUTION_PRESETS, LocalReferenceImageLoader, roundedImageDimensions, hasRasterImageHeader } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("official 1M / 1.5M / 2M presets cover common landscape/portrait ratios with valid dimensions", () => {
  assert.deepEqual(RESOLUTION_PRESETS.map(({ group }) => group), ["1M", "1.5M", "2M"]);
  assert.equal(RESOLUTION_PRESETS.flatMap(({ sizes }) => sizes).length, 21);
  for (const { sizes } of RESOLUTION_PRESETS) for (const [, width, height] of sizes) {
    assert.ok(width % 16 === 0 && height % 16 === 0 && width >= 64 && height <= 4096);
    assert.ok(sizes.some(([, w, h]) => w === height && h === width));
  }
  assert.deepEqual(RESOLUTION_PRESETS[0].sizes.find(([ratio]) => ratio === "16:9"), ["16:9", 1360, 768]);
});

test("natural dimensions round to nearest16 and reject unsupported sizes instead of distorting", () => {
  assert.deepEqual(roundedImageDimensions(1001, 777), { width: 1008, height: 784 });
  assert.deepEqual(roundedImageDimensions(1000, 760), { width: 1008, height: 768 });
  assert.deepEqual(roundedImageDimensions(1024, 1024), { width: 1024, height: 1024 });
  assert.deepEqual(roundedImageDimensions(4095, 64), { width: 4096, height: 64 });
  for (const [w, h] of [[1, 1], [8200, 4000], [0, 100], [Infinity, 100], [100, NaN]]) assert.throws(() => roundedImageDimensions(w, h));
});

test("local image loader validates, replaces safely, ignores out-of-order decode and cleans all URLs", async (t) => {
  const images = [], created = [], revoked = [];
  t.mock.method(URL, "createObjectURL", () => { const url = `blob:local-${created.length}`; created.push(url); return url; });
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    naturalWidth = 1001; naturalHeight = 777; src = ""; onload = null; onerror = null;
    constructor() { images.push(this); }
  };
  t.after(() => { if (originalImage) globalThis.Image = originalImage; else delete globalThis.Image; });
  const file = (name = "reference.png", type = "image/png") => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type });
  const loader = new LocalReferenceImageLoader();
  await assert.rejects(loader.load(file("document.txt", "text/plain")), /请选择/);
  await assert.rejects(loader.load(new File(["<svg></svg>"], "uuid", { type: "" })), /请选择/);
  assert.equal(created.length, 0);

  const first = loader.load(file()); await new Promise(setImmediate); images[0].onload();
  const reference = await first;
  assert.equal(reference.url, "blob:local-0");
  assert.deepEqual([reference.width, reference.height], [1008, 784]);
  assert.equal(revoked.length, 0);

  const invalid = loader.load(file()); await new Promise(setImmediate); images[1].onerror();
  await assert.rejects(invalid, /无法解码/);
  assert.deepEqual(revoked, ["blob:local-1"]); // Existing background survives invalid replacement.

  const old = loader.load(file()); await new Promise(setImmediate); const oldOnload = images[2].onload;
  const latest = loader.load(file("uuid-with-no-extension", "application/octet-stream"));
  await new Promise(setImmediate);
  images[3].naturalWidth = 1360; images[3].naturalHeight = 768;
  images[3].onload();
  const latestReference = await latest;
  oldOnload();
  assert.equal(await old, null);
  assert.equal(latestReference.name, "uuid-with-no-extension");
  assert.deepEqual([latestReference.width, latestReference.height], [1360, 768]);
  assert.ok(revoked.includes("blob:local-0") && revoked.includes("blob:local-2"));

  const pending = loader.load(file("untyped.png", ""));
  await new Promise(setImmediate);
  loader.clear();
  assert.equal(await pending, null);
  assert.ok(revoked.includes("blob:local-3") && revoked.includes("blob:local-4"));
  loader.clear();
  assert.equal(new Set(revoked).size, created.length);
  assert.equal(revoked.length, created.length); // Each object URL revoked exactly once.
});

test("oversized decoded image preserves original background and cleans rejected URL", async (t) => {
  const images = [], revoked = [];
  let count = 0;
  t.mock.method(URL, "createObjectURL", () => `blob:local-${count++}`);
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    naturalWidth = 1024; naturalHeight = 1024; src = ""; onload = null; onerror = null;
    constructor() { images.push(this); }
  };
  t.after(() => { if (originalImage) globalThis.Image = originalImage; else delete globalThis.Image; });
  const loader = new LocalReferenceImageLoader();
  const file = new File(["image"], "image.png", { type: "image/png" });
  const first = loader.load(file); await new Promise(setImmediate); images[0].onload(); await first;
  const tooLarge = loader.load(file); await new Promise(setImmediate); images[1].naturalWidth = 6000; images[1].onload();
  await assert.rejects(tooLarge, /64–4096/);
  assert.deepEqual(revoked, ["blob:local-1"]);
  loader.clear();
  assert.deepEqual(revoked, ["blob:local-1", "blob:local-0"]);
});


test("signature fallback accepts only supported raster headers, including unnamed AVIF", () => {
  const bytes = (text) => new Uint8Array(Buffer.from(text, "binary"));
  for (const header of [bytes("GIF87a"), bytes("GIF89a"), bytes("BM"), bytes("RIFF0000WEBP"), bytes("0000ftypavif"), bytes("0000ftypmif10000avif"), new Uint8Array([255, 216, 255]), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]) assert.equal(hasRasterImageHeader(header), true);
  for (const header of [bytes("<svg></svg>"), bytes("RIFF0000WAVE"), bytes("0000ftypheic"), bytes("just text"), new Uint8Array()]) assert.equal(hasRasterImageHeader(header), false);
});

test("clearing while unnamed-file signature is pending cannot create a late object URL", async (t) => {
  let finishRead;
  const createUrl = t.mock.method(URL, "createObjectURL", () => { throw new Error("late URL must not be created"); });
  const loader = new LocalReferenceImageLoader();
  const file = { name: "uuid", type: "", size: 8, slice: () => ({ arrayBuffer: () => new Promise((resolve) => { finishRead = resolve; }) }) };
  const pending = loader.load(file);
  loader.clear();
  finishRead(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer);
  assert.equal(await pending, null);
  assert.equal(createUrl.mock.callCount(), 0);
});
