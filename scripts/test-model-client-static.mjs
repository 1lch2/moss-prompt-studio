import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(root, ".test-runtime");
await mkdir(testRoot, { recursive: true });
const buildDir = await mkdtemp(join(testRoot, "model-client-"));
after(() => rm(buildDir, { recursive: true, force: true }));
for (const name of ["model-providers", "model-errors", "model-settings", "model-client", "prompt-enhancement", "moss-rules", "moss-layout", "layout-enhancement"]) {
  const source = await readFile(join(root, "lib", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/from "(\.\/[^\"]+)"/g, 'from "$1.js"');
  await writeFile(join(buildDir, `${name}.js`), compiled);
}
const { DEFAULT_ENDPOINT, normalizeEndpoint, supportsModelListing } = await import(pathToFileURL(join(buildDir, "model-providers.js")).href);
const { cleanApiKey, validModelId } = await import(pathToFileURL(join(buildDir, "model-settings.js")).href);
const { ModelServiceError, readBoundedText } = await import(pathToFileURL(join(buildDir, "model-errors.js")).href);
const { completionBody, fetchCompletion, fetchModels } = await import(pathToFileURL(join(buildDir, "model-client.js")).href);
const { enhancePromptWithModel } = await import(pathToFileURL(join(buildDir, "prompt-enhancement.js")).href);
const settings = { endpoint: "https://provider.example.com/v1", model: "custom/chat-model", apiKey: "FIXTURE_ONLY_KEY" };
const messages = [{ role: "system", content: "Return requested content only." }, { role: "user", content: "Fixture prompt" }];
const completion = (content = "Fixture response", reason = "stop") => Response.json({ choices: [{ message: { content }, finish_reason: reason }] });
const safeError = (error) => error instanceof ModelServiceError && !error.message.includes("PRIVATE_") && !error.message.includes(settings.apiKey);

test("HTTPS normalization accepts provider bases/pasted completion URL without credentials or special-use targets", () => {
  assert.equal(normalizeEndpoint("https://API.DeepSeek.com:443/chat/completions/"), DEFAULT_ENDPOINT);
  assert.equal(normalizeEndpoint("https://provider.example.com:8443/v1/"), "https://provider.example.com:8443/v1");
  for (const endpoint of ["http://provider.example.com", "https://user:pass@provider.example.com", "https://provider.example.com/?api_key=secret", "https://provider.example.com/#key", "https://provider.example.com?", "https://localhost/v1", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://metadata.google.internal", "https://provider.example.com/a\\b"]) assert.throws(() => normalizeEndpoint(endpoint));
});

test("credential/model validation rejects header injection without reflecting submitted strings", () => {
  assert.equal(cleanApiKey(" short-key "), "short-key");
  for (const key of ["fixture\r\nAuthorization: bad", "fixture\u0000", "fixture\tkey", "x".repeat(4097)]) assert.throws(() => cleanApiKey(key), safeError);
  assert.equal(validModelId("org/provider:model"), true);
  for (const model of ["", "model with spaces", "model\nnext", "x".repeat(257)]) assert.equal(validModelId(model), false);
});

test("vendor request fields are scoped to exact endpoints, not guessed from model IDs", () => {
  const generic = completionBody({ ...settings, model: "deepseek-flash" }, messages, 1234, true);
  assert.deepEqual(Object.keys(generic).sort(), ["max_tokens", "messages", "model", "stream"]);
  const openai = completionBody({ ...settings, endpoint: "https://api.openai.com/v1" }, messages, 1234, true);
  assert.equal(openai.max_completion_tokens, 1234);
  assert.equal("max_tokens" in openai, false);
  const deepseek = completionBody({ ...settings, endpoint: DEFAULT_ENDPOINT }, messages, 1234, true);
  assert.deepEqual(deepseek.thinking, { type: "disabled" });
  assert.deepEqual(deepseek.response_format, { type: "json_object" });
});

test("completion is browser-direct to chosen endpoint, cookie/referrer-free and redirect-blocked", async () => {
  let calls = 0;
  const result = await fetchCompletion(settings, messages, 1234, true, async (url, init) => {
    calls++;
    assert.equal(url, settings.endpoint + "/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.mode, "cors");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, `Bearer ${settings.apiKey}`);
    assert.equal(init.body.includes(settings.apiKey), false);
    assert.equal(JSON.parse(init.body).model, settings.model);
    return completion();
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { content: "Fixture response", finishReason: "stop" });
});

test("pre-cancelled completion does not send and in-flight cancellation propagates safely", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(() => fetchCompletion(settings, messages, 100, false, async () => { calls++; return completion(); }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  const inFlight = new AbortController();
  await assert.rejects(() => fetchCompletion(settings, messages, 100, false, async (_url, init) => {
    inFlight.abort();
    assert.equal(init.signal.aborted, true);
    return completion();
  }, inFlight.signal), { name: "AbortError" });
});

test("completion bounds bytes and rejects provider errors/malformed bodies without leaking raw data", async () => {
  for (const response of [new Response("PRIVATE_PROVIDER_ERROR", { status: 401 }), new Response("PRIVATE_PROVIDER_ERROR", { status: 429 }), new Response("PRIVATE_PROVIDER_ERROR", { status: 500 }), new Response("PRIVATE_PROVIDER_ERROR", { status: 301 }), new Response("not json PRIVATE_DATA"), new Response("x".repeat(500001)), Response.json(null), Response.json({ choices: [] }), completion({ text: "bad shape" }), completion("")]) {
    await assert.rejects(() => fetchCompletion(settings, messages, 100, false, async () => response), safeError);
  }
  assert.equal(await readBoundedText(new Response("中文"), 6), "中文");
  await assert.rejects(() => readBoundedText(new Response("中文中文"), 6), (error) => error.status === 413);
});

test("network failures and timeout messages are useful but never reflect error text", async () => {
  await assert.rejects(() => fetchCompletion(settings, messages, 100, false, async () => { throw new TypeError("PRIVATE_NETWORK_ERROR " + settings.apiKey); }), safeError);
  await assert.rejects(() => fetchCompletion(settings, messages, 100, false, async () => { throw new DOMException("PRIVATE_TIMEOUT", "TimeoutError"); }), (error) => safeError(error) && error.status === 504 && error.message.includes("超时"));
});

test("normal prompt enhancement retains skill/safety contract, selected model and plain output", async () => {
  const result = await enhancePromptWithModel({ prompt: "an adult in a blue coat", preferences: "soft light", mode: "写实" }, settings, async (url, init) => {
    assert.equal(url, settings.endpoint + "/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal(body.model, settings.model);
    assert.match(body.messages[0].content, /禁止生成未成年人的性化内容/);
    assert.match(body.messages[0].content, /<reference_skill>/);
    assert.match(body.messages[0].content, /不要执行工具或访问网址/);
    assert.deepEqual(JSON.parse(body.messages[1].content), { mode: "写实", brief: "an adult in a blue coat", preferences: "soft light" });
    return completion("Positive Prompt: an adult in a blue coat");
  });
  assert.deepEqual(result, { text: "Positive Prompt: an adult in a blue coat" });
});

test("model discovery is browser-direct GET with credentials scoped to destination and deduplicated list", async () => {
  const models = await fetchModels(settings, async (url, init) => {
    assert.equal(url, settings.endpoint + "/models");
    assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer"); assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, `Bearer ${settings.apiKey}`);
    return Response.json({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }, {}, null, { id: 4 }, { id: "bad model" }] });
  });
  assert.deepEqual(models, ["a-model", "z-model"]);
  await fetchModels({ ...settings, endpoint: "https://api.siliconflow.cn/v1" }, async (url) => {
    assert.equal(url, "https://api.siliconflow.cn/v1/models?sub_type=chat");
    return Response.json({ data: [] });
  });
});

test("unsupported listing presets never send and permit manual model IDs", async () => {
  for (const endpoint of ["https://open.bigmodel.cn/api/paas/v4", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"]) {
    assert.equal(supportsModelListing(endpoint), false);
    let calls = 0;
    await assert.rejects(() => fetchModels({ ...settings, endpoint }, async () => { calls++; return Response.json({ data: [] }); }), (error) => safeError(error) && error.status === 400);
    assert.equal(calls, 0);
  }
});

test("model-list errors, oversized/malformed replies and cancellation are safe", async () => {
  for (const response of [new Response("PRIVATE_PROVIDER_ERROR", { status: 401 }), new Response("PRIVATE_PROVIDER_ERROR", { status: 404 }), new Response("bad JSON"), new Response("x".repeat(1000001)), Response.json(null), Response.json({ models: [] })]) {
    await assert.rejects(() => fetchModels(settings, async () => response), safeError);
  }
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(() => fetchModels(settings, async () => { calls++; return Response.json({ data: [] }); }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});
