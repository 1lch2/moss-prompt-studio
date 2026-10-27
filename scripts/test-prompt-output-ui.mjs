import assert from "node:assert/strict";
import test from "node:test";
import { fixtureStorage, workbench } from "./ui-fixture.mjs";

const LOCAL_SETTINGS_KEY = "moss-prompt-static.settings.v1";
const ENDPOINT = "https://api.deepseek.com";
async function readyWorkbench(fetcher, clipboardFails = false) {
  const storage = fixtureStorage({ [LOCAL_SETTINGS_KEY]: JSON.stringify({ version: 1, activeEndpoint: ENDPOINT, profiles: { [ENDPOINT]: { apiKey: "FIXTURE_ONLY_KEY", model: "fixture-model" } } }) });
  const app = workbench({ fetcher, clipboardFails, storage });
  await app.flush();
  return app;
}
const provider = (content, finish_reason = "stop") => Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason }] });
const userBody = (init) => JSON.parse(JSON.parse(init.body).messages[1].content);

const json = {
  summary: { caption: "A quiet editorial poster." },
  items: [{ label: "text", caption: "Small uppercase lettering.", text: "  HELLO\nWORLD!  ", bbox: [-448, -384, -256, 384] }],
  bbox_coord_space: "abs_centralized", bbox_format: "yxyx",
};
function layoutResponse(_width = 1024, _height = 1024, content = json) { return provider(content); }

test("ordinary mode comes first, is selected by default, and matches keyboard order", async () => {
  const app = await readyWorkbench();
  const tabs = app.all().filter((node) => node.props.role === "tab");
  assert.deepEqual(tabs.map((node) => node.props.id), ["tab-prompt", "tab-layout"]);
  assert.equal(app.id("tab-prompt").props["aria-selected"], true);
  assert.equal(app.id("panel-prompt").props.hidden, false);
  assert.equal(app.id("panel-layout").props.hidden, true);
  assert.equal(app.id("output-format").props.value, "text");
  assert.equal(app.id("prompt-width"), undefined);
  app.key("End"); assert.equal(app.id("tab-layout").props["aria-selected"], true); assert.equal(app.focus(), "tab-layout");
  app.key("Home"); assert.equal(app.id("tab-prompt").props["aria-selected"], true); assert.equal(app.focus(), "tab-prompt");
});

test("ordinary text stays default and sends no dimensions", async () => {
  let request;
  const app = await readyWorkbench(async (url, init) => { assert.equal(url, `${ENDPOINT}/chat/completions`); assert.equal(init.headers.Authorization, "Bearer FIXTURE_ONLY_KEY"); request = userBody(init); return provider(" Positive Prompt: test \n"); });
  app.change("prompt", "  A quiet park  ");
  await app.submit();
  assert.deepEqual(request, { brief: "A quiet park", preferences: "", mode: "写实" });
  assert.equal(app.output(), "Positive Prompt: test");
  await app.copy(); assert.deepEqual(app.clipboard, ["Positive Prompt: test"]);
});

test("output type stays beside submit in the bottom action row, with JSON-only dimensions", async () => {
  const app = await readyWorkbench();
  for (const format of ["text", "layout", "text"]) {
    app.change("output-format", format);
    const actions = app.find((node) => node.props.className === "input-actions");
    const actionChildren = actions.props.children;
    assert.equal(actionChildren[0].props.className, "clear-button");
    assert.equal(actionChildren[1].props.className, "prompt-submit-actions");
    const submitChildren = actionChildren[1].props.children;
    assert.equal(submitChildren[0].props.htmlFor, "output-format");
    assert.equal(app.text(submitChildren[0]), "输出");
    assert.equal(submitChildren[1], app.id("output-format"));
    assert.equal(submitChildren[2].props.type, "submit");
    assert.equal(submitChildren[2].props.className, "enhance-button");
    assert.equal(app.find((node) => node.props.className === "prompt-output-options"), undefined);
    assert.equal(!!app.id("prompt-width"), format === "layout");
    assert.equal(!!app.id("prompt-height"), format === "layout");
    assert.equal(!!app.id("prompt-resolution"), format === "layout");
  }
});

test("layout mode sends dimensions, previews pretty JSON and copies only compact canonical JSON", async () => {
  let request;
  const app = await readyWorkbench(async (_url, init) => { request = userBody(init); return layoutResponse(); });
  app.change("prompt", "An editorial poster"); app.change("output-format", "layout");
  assert.equal(app.id("prompt-width").props.value, "1024"); assert.equal(app.id("prompt-height").props.value, "1024");
  await app.submit();
  assert.deepEqual(request, { brief: "An editorial poster", preferences: "", mode: "写实", width: 1024, height: 1024 });
  assert.equal(app.output(), JSON.stringify(json, null, 2));
  assert.equal(app.text(app.id("output-title")), "Layout JSON");
  assert.match(app.text(app.find((node) => node.props.className === "prompt-result-size")), /1024 × 1024/);
  app.change("prompt-width", "2048"); app.change("output-format", "text");
  assert.match(app.text(app.find((node) => node.props.className === "prompt-result-size")), /1024 × 1024/);
  await app.copy(); assert.deepEqual(app.clipboard, [JSON.stringify(json)]);
});

test("presets apply together; invalid manual sizes never send a request", async () => {
  let calls = 0;
  const app = await readyWorkbench(async (_url, init) => { calls++; const request = userBody(init); assert.equal(request.width, 1360); assert.equal(request.height, 768); return layoutResponse(1360, 768, { ...json, items: [{ ...json.items[0], bbox: [-320, -384, -256, 384] }] }); });
  app.change("prompt", "A poster"); app.change("output-format", "layout");
  app.change("prompt-resolution", "1360x768");
  assert.equal(app.id("prompt-width").props.value, "1360"); assert.equal(app.id("prompt-height").props.value, "768");
  for (const value of ["", "32", "1025", "8192", "1024.5"]) {
    app.change("prompt-width", value); await app.submit();
    assert.equal(calls, 0); assert.match(app.text(app.find((node) => node.props.role === "alert")), /16 的倍数/);
  }
  app.change("prompt-width", "1360"); await app.submit(); assert.equal(calls, 1); assert.ok(app.output());
});

test("a pending generation freezes output controls and duplicate submissions do not overlap", async () => {
  let resolveResponse, calls = 0;
  const app = await readyWorkbench(() => { calls++; return new Promise((resolvePromise) => { resolveResponse = resolvePromise; }); });
  app.change("prompt", "A poster"); app.change("output-format", "layout");
  const pending = app.submit();
  assert.equal(app.id("output-format").props.disabled, true); assert.equal(app.id("prompt-width").props.disabled, true);
  assert.equal(app.id("prompt").props.disabled, true);
  await app.submit(); assert.equal(calls, 1);
  resolveResponse(layoutResponse()); await pending;
  assert.equal(app.id("output-format").props.disabled, false); assert.equal(app.output(), JSON.stringify(json, null, 2));
});

test("truncation, extra metadata, invalid geometry and provider errors never become output", async () => {
  for (const response of [
    () => provider(json, "length"),
    () => layoutResponse(1024, 1024, { ...json, width: 1024 }),
    () => layoutResponse(1024, 1024, { ...json, items: [{ ...json.items[0], bbox: [-900, -384, -256, 384] }] }),
    () => Response.json({ error: "模型返回被截断，请重试。" }, { status: 502 }),
  ]) {
    const app = await readyWorkbench(async () => response());
    app.change("prompt", "A poster"); app.change("output-format", "layout"); await app.submit();
    assert.equal(app.output(), undefined); assert.ok(app.find((node) => node.props.role === "alert"));
    assert.equal(app.find((node) => node.props.className === "copy-button").props.disabled, true);
  }
});

test("clipboard denial selects JSON only, with dimensions remaining outside the selected content", async () => {
  const app = await readyWorkbench(async () => layoutResponse(), true);
  app.change("prompt", "A poster"); app.change("output-format", "layout"); await app.submit(); await app.copy();
  assert.equal(app.selected(), true); assert.equal(app.focus(), "output");
  assert.deepEqual(JSON.parse(app.output()), json); assert.equal(app.output().includes("出图尺寸"), false);
});

test("unmount cancels an outstanding direct provider request and never installs its result", async () => {
  let signal;
  const app = await readyWorkbench((_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Fixture cancellation", "AbortError")), { once: true }));
  });
  app.change("prompt", "A quiet lake");
  const pending = app.submit();
  assert.equal(signal.aborted, false);
  app.unmount(); assert.equal(signal.aborted, true);
  await pending;
  assert.equal(app.output(), undefined);
});

test("provider failure preserves a previous result and allows a successful retry", async () => {
  let calls = 0;
  const app = await readyWorkbench(async () => ++calls === 2 ? new Response("SECRET_PROVIDER_DIAGNOSTIC", { status: 429 }) : provider(`Positive Prompt: result ${calls}`));
  app.change("prompt", "A quiet park"); await app.submit();
  assert.equal(app.output(), "Positive Prompt: result 1");
  await app.submit();
  assert.equal(app.output(), "Positive Prompt: result 1");
  assert.match(app.text(app.find((node) => node.props.role === "alert")), /请求受限|额度不足/);
  assert.equal(app.text(app.all()).includes("SECRET_PROVIDER_DIAGNOSTIC"), false);
  await app.submit();
  assert.equal(app.output(), "Positive Prompt: result 3");
  assert.equal(app.find((node) => node.props.role === "alert"), undefined);
});
