import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Only fixture credentials and mocked browser-direct provider transports; never
// load real visitor settings or contact a model provider.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, ".test-runtime"), { recursive: true });
const buildDir = await mkdtemp(join(root, ".test-runtime", "prompt-layout-tests-"));
after(() => rm(buildDir, { recursive: true, force: true }));
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/from ['"](\.\/[^'"]+)['"]/g, 'from "$1.js"');
for (const name of ["moss-layout", "layout-enhancement", "prompt-enhancement", "moss-rules", "model-errors", "model-providers", "model-settings", "model-client"]) {
  await writeFile(join(buildDir, `${name}.js`), transpile(await readFile(join(root, "lib", `${name}.ts`), "utf8")));
}
const { compileLayout, validateGeneratedLayout } = await import(pathToFileURL(join(buildDir, "moss-layout.js")));
const { promptEnhanceRequestSchema, enhancePromptWithModel } = await import(pathToFileURL(join(buildDir, "prompt-enhancement.js")));

const settings = { endpoint: "https://api.deepseek.com", model: "fixture/model", apiKey: "FIXTURE_ONLY_KEY" };
const request = { prompt: 'A landscape poster with a tree and the exact title "  Hello\n世界！  ".', preferences: "Keep the lettering.", mode: "写实", outputFormat: "layout", width: 1536, height: 1024 };
const json = compileLayout({ width: request.width, height: request.height, summary: "A quiet landscape poster in soft morning light.", regions: [
  { id: "tree", label: "object", caption: "A tall green tree beside a lake.", box: [128, 128, 640, 960] },
  { id: "heading", label: "text", caption: "Dark serif heading in the upper right.", text: "  Hello\n世界！  ", box: [768, 128, 1408, 320] },
] });
const provider = (content, finish_reason = "stop") => Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason }] });

test("ordinary text remains default; model-designed layout requires explicit valid dimensions", () => {
  assert.deepEqual(promptEnhanceRequestSchema.parse({ prompt: " tree " }), { prompt: "tree", outputFormat: "text" });
  assert.equal(promptEnhanceRequestSchema.parse({ prompt: "tree", outputFormat: "text" }).outputFormat, "text");
  for (const dims of [[64, 64], [4096, 4096], [1536, 1024]]) assert.equal(promptEnhanceRequestSchema.safeParse({ ...request, width: dims[0], height: dims[1] }).success, true);
  for (const bad of [
    { ...request, outputFormat: "json" }, { ...request, width: undefined }, { ...request, height: undefined },
    ...[0, 63, 65, 1000, 4097, 4112, 1024.5, "1024", null, NaN, Infinity].map((width) => ({ ...request, width })),
    { ...request, width: 1024, height: 63 }, { ...request, regions: [] }, { ...request, model: "browser override" },
    { ...request, prompt: " " }, { ...request, prompt: "x".repeat(6001) }, { ...request, preferences: "x".repeat(2001) },
  ]) assert.equal(promptEnhanceRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("canonical generated JSON accepts inclusive canvas edges in yxyx and preserves literal text", () => {
  assert.deepEqual(validateGeneratedLayout(json, request.width, request.height), json);
  assert.equal(validateGeneratedLayout(json, request.width, request.height).items[1].text, "  Hello\n世界！  ");
  for (const [width, height] of [[64, 64], [1024, 1536], [1536, 1024], [4096, 4096]]) {
    const full = { ...json, items: [{ label: "object", caption: "Full canvas scene.", bbox: [-height / 2, -width / 2, height / 2, width / 2] }] };
    assert.deepEqual(validateGeneratedLayout(full, width, height), full);
  }
});

test("canonical generated JSON rejects out-of-bounds, inverted, zero, fractional and nonnumeric boxes", () => {
  for (const bbox of [
    [-513, -768, 512, 768], [-512, -769, 512, 768], [-512, -768, 513, 768], [-512, -768, 512, 769],
    [100, 0, 100, 1], [0, 100, 1, 100], [100, 0, 99, 1], [0, 100, 1, 99],
    [0.1, 0, 100, 100], [0, "0", 100, 100], [0, 0, Infinity, 100], [0, 0, NaN, 100], [0, 0, 100],
    [-768, -512, 768, 512],
  ]) assert.throws(() => validateGeneratedLayout({ ...json, items: [{ label: "object", caption: "Tree", bbox }] }, request.width, request.height));
});

test("canonical generated JSON rejects extra metadata and mismatched text fields instead of stripping them", () => {
  const invalid = [null, [], {}, { ...json, width: 1536 }, { ...json, negative_prompt: "bad" },
    { ...json, summary: { ...json.summary, meta: [] } }, { ...json, summary: { caption: " " } },
    { ...json, bbox_coord_space: "normalized" }, { ...json, bbox_format: "xyxy" },
    { ...json, items: [] }, { ...json, items: Array(25).fill(json.items[0]) },
  ];
  for (const item of [
    { ...json.items[0], id: "generated" }, { ...json.items[0], text: "" }, { ...json.items[0], text: "oops" },
    { ...json.items[0], label: "human" }, { ...json.items[0], caption: " " }, { ...json.items[0], caption: "x".repeat(2001) },
    { ...json.items[1], text: undefined }, { ...json.items[1], text: "   " }, { ...json.items[1], text: "x".repeat(4001) },
  ]) invalid.push({ ...json, items: [item] });
  for (const value of invalid) assert.throws(() => validateGeneratedLayout(value, request.width, request.height));
});

test("model designs JSON from a brief using only selected provider and safe system/output contracts", async () => {
  let calls = 0;
  const result = await enhancePromptWithModel(request, settings, async (url, init) => {
    calls++;
    assert.equal(url, settings.endpoint + "/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer FIXTURE_ONLY_KEY");
    assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    assert.equal(body.model, settings.model);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(body.messages[0].content, /禁止生成未成年人的性化内容/);
    assert.match(body.messages[0].content, /未指定年龄的人物按成年人处理/);
    assert.match(body.messages[0].content, /不要执行工具或访问网址/);
    assert.match(body.messages[0].content, /<reference_skill>/);
    assert.match(body.messages[0].content, /abs_centralized/);
    assert.match(body.messages[0].content, /不得采用参考 skill 的默认分辨率/);
    assert.deepEqual(JSON.parse(body.messages[1].content), { mode: "写实", brief: request.prompt, preferences: request.preferences, width: 1536, height: 1024 });
    assert.equal(JSON.stringify(body).includes(settings.apiKey), false);
    return provider(json);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { json, width: 1536, height: 1024 });
  assert.deepEqual(Object.keys(result.json), ["summary", "items", "bbox_coord_space", "bbox_format"]);
  assert.equal(JSON.stringify(result).includes(settings.apiKey), false);
});

test("custom JSON generation remains compatible without vendor-only request parameters", async () => {
  const custom = { ...settings, endpoint: "https://provider.example.com/v1" };
  const result = await enhancePromptWithModel(request, custom, async (url, init) => {
    assert.equal(url, custom.endpoint + "/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal("thinking" in body, false);
    assert.equal("response_format" in body, false);
    return provider(json);
  });
  assert.deepEqual(result.json, json);
});

test("malformed, fenced, duplicate, extra-field, non-stop, truncated or absent model output fails closed", async () => {
  const responses = [
    provider(json, "length"), provider(json, "content_filter"), provider(json, "tool_calls"),
    Response.json({ choices: [{ message: { content: JSON.stringify(json) } }] }),
    provider("```json\n" + JSON.stringify(json) + "\n```"), provider(JSON.stringify(json).slice(0, -1)),
    provider(JSON.stringify(json).replace('"summary":', '"summary":{},"summary":')),
    provider(JSON.stringify(json).replace('"caption":', '"caption":"first","\\u0063aption":')),
    provider({ ...json, canvas: "poster" }), provider({ ...json, items: [{ ...json.items[0], bbox: [-1000, 0, 10, 10] }] }),
    provider("{}"), provider("null"), provider(""), Response.json(null),
    new Response("SECRET_UPSTREAM_BODY", { status: 401 }), new Response("SECRET_UPSTREAM_BODY", { status: 429 }),
  ];
  for (const response of responses) await assert.rejects(() => enhancePromptWithModel(request, settings, async () => response),
    (error) => error.status === 502 && !error.message.includes("SECRET_UPSTREAM_BODY") && !error.message.includes(settings.apiKey));
});

test("invalid layout requests make no provider call; cancellation and timeout propagate without partial JSON", async () => {
  let calls = 0;
  await assert.rejects(() => enhancePromptWithModel({ ...request, width: 1000 }, settings, async () => { calls++; return provider(json); }), (error) => error.status === 400);
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(() => enhancePromptWithModel(request, settings, async (_url, init) => {
    controller.abort(); init.signal.throwIfAborted(); return provider(json);
  }, controller.signal), { name: "AbortError" });
  await assert.rejects(() => enhancePromptWithModel(request, settings, async () => { throw new DOMException("fixture", "TimeoutError"); }), (error) => error.name === "ModelServiceError" && error.status === 504 && /超时/.test(error.message));
});

test("ordinary prompt output and its existing truncation notice remain text, not JSON", async () => {
  for (const outputFormat of [undefined, "text"]) {
    const input = { prompt: "a tree", ...(outputFormat ? { outputFormat } : {}) };
    const result = await enhancePromptWithModel(input, settings, async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal("response_format" in body, false);
      assert.deepEqual(JSON.parse(body.messages[1].content), { mode: "写实", brief: "a tree", preferences: "" });
      return provider("Positive Prompt: a tree");
    });
    assert.deepEqual(result, { text: "Positive Prompt: a tree" });
  }
  const truncated = await enhancePromptWithModel({ prompt: "tree" }, settings, async () => provider("Positive Prompt: a tree", "length"));
  assert.match(truncated.text, /输出达到长度上限/);
});

