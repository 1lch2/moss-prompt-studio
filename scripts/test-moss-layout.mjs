import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import ts from "typescript";

// Transpile only pure browser helpers into an ignored temporary directory;
// fixture keys and mocked providers only, no real visitor settings or API calls.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(root, ".test-runtime");
await mkdir(testRoot, { recursive: true });
const buildDir = await mkdtemp(join(testRoot, "layout-tests-"));
after(() => rm(buildDir, { recursive: true, force: true }));
for (const name of ["moss-layout", "layout-enhancement", "moss-rules", "model-errors", "model-providers", "model-settings", "model-client"]) {
  const source = await readFile(join(root, "lib", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from "(\.\/[^\"]+)"/g, 'from "$1.js"');
  await writeFile(join(buildDir, `${name}.js`), compiled);
}
const { compileLayout, layoutDraftSchema, layoutEnhanceRequestSchema, validateEnhancedLayout, applyEnhancedLayout } =
  await import(pathToFileURL(join(buildDir, "moss-layout.js")).href);
const { enhanceLayoutWithModel, parseStrictJson, readLimitedText } =
  await import(pathToFileURL(join(buildDir, "layout-enhancement.js")).href);

const draft = {
  width: 1024, height: 1024, summary: "A restrained editorial poster.",
  regions: [
    { id: "heading", label: "text", caption: "Large dark-blue heading.", text: "  HELLO\n世界！  ", box: [128, 96, 896, 224] },
    { id: "hero", label: "character", caption: "An adult in a green coat.", box: [256, 256, 768, 960] },
  ],
};
const enhancement = { summary: "A quiet editorial poster with soft side lighting.", regions: [
  { id: "hero", caption: "An adult in a textured green coat, standing calmly." },
  { id: "heading", caption: "Large dark-blue sans-serif lettering with generous spacing." },
] };
const request = { ...draft, mode: "写实", preferences: "保留原文字" };
function provider(content, finish_reason = "stop") {
  return Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason }] });
}

test("official example: top-left xyxy becomes centered yxyx without editor fields", () => {
  const json = compileLayout(draft);
  assert.deepEqual(Object.keys(json), ["summary", "items", "bbox_coord_space", "bbox_format"]);
  assert.deepEqual(json.items[0].bbox, [-416, -384, -288, 384]);
  assert.deepEqual(json.items[1].bbox, [-256, -256, 448, 256]);
  assert.equal(json.bbox_coord_space, "abs_centralized");
  assert.equal(json.bbox_format, "yxyx");
  assert.deepEqual(Object.keys(json.items[0]), ["label", "caption", "text", "bbox"]);
  assert.equal("id" in json.items[0], false);
  assert.equal("width" in json, false);
  assert.equal("text" in json.items[1], false);
  assert.equal(json.items[0].text, draft.regions[0].text);
  assert.equal(JSON.parse(JSON.stringify(json)).items[0].text, "  HELLO\n世界！  ");
});

test("non-square canvas, all edges, subpixel coverage and nine-place jitter", () => {
  const input = { width: 960, height: 640, summary: "Scene", regions: [
    { id: "a", label: "object", caption: "Canvas", box: [0, 0, 960, 640] },
    { id: "b", label: "object", caption: "Fractional", box: [1.2, 2.7, 20.1, 30.01] },
    { id: "c", label: "object", caption: "Jitter", box: [99.9999999999, 199.9999999999, 300.0000000001, 400.0000000001] },
  ] };
  assert.deepEqual(compileLayout(input).items.map((item) => item.bbox), [
    [-320, -480, 320, 480], [-318, -479, -289, -459], [-120, -380, 80, -180],
  ]);
});

test("invalid dimensions, geometry, duplicate IDs, empty captions and text are rejected", () => {
  for (const patch of [{ width: 1000 }, { height: 0 }, { width: 4112 }, { width: 640.5 }, { regions: [] }]) {
    assert.equal(layoutDraftSchema.safeParse({ ...draft, ...patch }).success, false);
  }
  for (const box of [[-1, 0, 50, 50], [0, 0, 1025, 40], [20, 20, 20, 30], [40, 40, 30, 50], [0, 0, NaN, 30], [0, 0, Infinity, 30], [0, 0, 1e-11, 1e-11]]) {
    assert.equal(layoutDraftSchema.safeParse({ ...draft, regions: [{ ...draft.regions[0], box }] }).success, false);
  }
  assert.equal(layoutDraftSchema.safeParse({ ...draft, regions: [draft.regions[0], draft.regions[0]] }).success, false);
  assert.equal(layoutDraftSchema.safeParse({ ...draft, regions: [{ ...draft.regions[0], text: " \n " }] }).success, false);
  assert.equal(layoutDraftSchema.safeParse({ ...draft, regions: [{ ...draft.regions[0], caption: " " }] }).success, false);
  assert.equal(layoutDraftSchema.safeParse({ ...draft, extra: "not official" }).success, false);
  assert.equal(layoutEnhanceRequestSchema.safeParse(request).success, true);
  assert.equal(layoutEnhanceRequestSchema.safeParse({ ...request, mode: "unsupported" }).success, false);
});

test("overlapping objects are valid; non-text literal data is not accidentally exported", () => {
  assert.equal(layoutDraftSchema.safeParse({ ...draft, regions: [draft.regions[1], { ...draft.regions[1], id: "second" }] }).success, true);
  assert.equal(layoutDraftSchema.safeParse({ ...draft, regions: [{ ...draft.regions[1], text: "hidden text" }] }).success, false);
});

test("enhancement uses IDs not array order and preserves all fixed layout and literal data", () => {
  const original = structuredClone(draft);
  const parsed = validateEnhancedLayout(enhancement, draft);
  assert.deepEqual(parsed.regions.map(({ id }) => id), ["heading", "hero"]);
  const updated = applyEnhancedLayout(draft, enhancement);
  assert.equal(updated.regions[0].caption, enhancement.regions[1].caption);
  assert.equal(updated.regions[0].text, draft.regions[0].text);
  assert.deepEqual(updated.regions.map(({ id, label, text, box }) => ({ id, label, text, box })),
    draft.regions.map(({ id, label, text, box }) => ({ id, label, text, box })));
  assert.deepEqual(draft, original);
});

test("missing, duplicate, injected, unknown and empty model fields are rejected", () => {
  const bad = [
    { ...enhancement, regions: enhancement.regions.slice(0, 1) },
    { ...enhancement, regions: [enhancement.regions[0], enhancement.regions[0]] },
    { ...enhancement, regions: [{ id: "unknown", caption: "Oops" }, enhancement.regions[0]] },
    { ...enhancement, bbox: [1, 2, 3, 4] },
    { ...enhancement, summary: " " },
    { ...enhancement, regions: [{ ...enhancement.regions[0], box: [1, 2, 3, 4] }, enhancement.regions[1]] },
    { ...enhancement, regions: [{ ...enhancement.regions[0], text: "mutated" }, enhancement.regions[1]] },
  ];
  for (const input of bad) assert.throws(() => validateEnhancedLayout(input, draft));
});

test("mocked enhancement compiles final JSON and only sends selected fixture credentials upstream", async () => {
  let calls = 0;
  const result = await enhanceLayoutWithModel(request, { model: "deepseek-flash", apiKey: "TEST_ONLY_NOT_REAL" }, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer TEST_ONLY_NOT_REAL");
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.type, "json_object");
    const userInput = JSON.parse(body.messages[1].content);
    assert.equal(userInput.regions[0].text, draft.regions[0].text);
    assert.equal(JSON.stringify(body).includes("TEST_ONLY_NOT_REAL"), false);
    return provider(enhancement);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.json, compileLayout(applyEnhancedLayout(draft, enhancement)));
  assert.equal(JSON.stringify(result).includes("TEST_ONLY_NOT_REAL"), false);
});

test("upstream HTTP failures, truncation, invalid JSON and changed IDs fail closed", async () => {
  for (const response of [
    new Response("private upstream debug", { status: 401 }),
    new Response("private upstream debug", { status: 429 }),
    provider(enhancement, "length"),
    provider(enhancement, "content_filter"),
    provider("```json\n{}\n```"),
    provider("{invalid}"),
    provider({ ...enhancement, regions: [] }),
    Response.json(null),
  ]) {
    await assert.rejects(() => enhanceLayoutWithModel(request, { model: "test", apiKey: "TEST" }, async () => response),
      (error) => error.status === 502 && !error.message.includes("private upstream debug"));
  }
});

test("timeout propagates without a partial result", async () => {
  await assert.rejects(() => enhanceLayoutWithModel(request, { model: "test", apiKey: "TEST" }, async () => {
    throw new DOMException("timed out", "TimeoutError");
  }), (error) => error.name === "ModelServiceError" && error.status === 504 && /超时/.test(error.message));
});

test("actual-byte body limits work without trustworthy Content-Length", async () => {
  await assert.rejects(() => readLimitedText(new Response("中文中文"), 5), (error) => error.status === 413);
  await assert.rejects(() => readLimitedText(new Response("x", { headers: { "Content-Length": "999" } }), 5), (error) => error.status === 413);
  assert.equal(await readLimitedText(new Response("中文"), 6), "中文");
});


test("strict JSON rejects duplicate keys, including escaped spellings and nested fields", () => {
  assert.throws(() => parseStrictJson('{"summary":"first","summary":"second"}'));
  assert.throws(() => parseStrictJson('{"regions":[{"id":"one","id":"two"}]}'));
  assert.throws(() => parseStrictJson('{"id":"one","\\u0069d":"two"}'));
  assert.deepEqual(parseStrictJson(JSON.stringify({ text: '\"quote\" \\ slash', array: [true, null, 42, { id: "a" }] })),
    { text: '\"quote\" \\ slash', array: [true, null, 42, { id: "a" }] });
  assert.throws(() => parseStrictJson("[".repeat(66) + "0" + "]".repeat(66)));
});


test("caller cancellation reaches the upstream request without a partial result", async () => {
  const controller = new AbortController();
  const pending = enhanceLayoutWithModel(request, { model: "test", apiKey: "TEST" }, async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    controller.abort();
    assert.equal(init.signal.aborted, true);
    init.signal.throwIfAborted();
    return provider(enhancement);
  }, controller.signal);
  await assert.rejects(() => pending, { name: "AbortError" });
});


test("custom layout endpoint uses selected model without vendor extras and preserves locked fields", async () => {
  const result = await enhanceLayoutWithModel(request, {
    endpoint: "https://provider.example.com/v1", model: "custom/model", apiKey: "FIXTURE_ONLY_KEY",
  }, async (url, init) => {
    assert.equal(url, "https://provider.example.com/v1/chat/completions");
    assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "custom/model");
    assert.equal("thinking" in body, false);
    assert.equal("response_format" in body, false);
    assert.match(body.messages[0].content, /禁止生成未成年人的性化内容/);
    assert.match(body.messages[0].content, /必须且仅返回 JSON 对象/);
    return provider(enhancement);
  });
  assert.deepEqual(result.json.items.map(({ label, text, bbox }) => ({ label, text, bbox })),
    compileLayout(draft).items.map(({ label, text, bbox }) => ({ label, text, bbox })));
  assert.equal(JSON.stringify(result).includes("FIXTURE_ONLY_KEY"), false);
});
