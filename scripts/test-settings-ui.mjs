import assert from "node:assert/strict";
import test from "node:test";
import { fixtureStorage, workbench } from "./ui-fixture.mjs";

const KEY = "moss-prompt-static.settings.v1";
const DEEPSEEK = "https://api.deepseek.com";
const OPENAI = "https://api.openai.com/v1";
const profile = (apiKey, model) => ({ apiKey, model });
const state = (profiles, activeEndpoint = DEEPSEEK) => JSON.stringify({ version: 1, activeEndpoint, profiles });
async function settingsApp({ storage = fixtureStorage(), fetcher } = {}) {
  const app = workbench({ storage, fetcher });
  await app.flush(); if (!app.id("provider")) await app.click("settings-toggle");
  return app;
}
const feedback = (app) => app.text(app.find((node) => node.props.className === "settings-actions"));
const readState = (app) => JSON.parse(app.storage.getItem(KEY));

test("opening and saving visitor settings never contacts a server or exposes saved keys", async () => {
  let calls = 0;
  const app = await settingsApp({ fetcher: async () => { calls++; throw new Error("No automatic calls"); } });
  assert.equal(app.id("api-key").props.value, "");
  assert.equal(app.id("api-key").props.required, true);
  assert.equal(app.button("enhance-button").props.disabled, true);
  app.change("api-key", "FIXTURE_DEEPSEEK"); app.change("model", "fixture-chat");
  await app.submit("settings-form");
  assert.deepEqual(readState(app), { version: 1, activeEndpoint: DEEPSEEK, profiles: { [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "fixture-chat") } });
  assert.equal(app.id("api-key").props.value, "");
  assert.equal(app.id("api-key").props.required, false);
  assert.equal(app.text(app.all()).includes("FIXTURE_DEEPSEEK"), false);
  assert.equal(calls, 0);
  app.unmount();
});

test("switching endpoint discards typed keys, retains scoped saved profiles and never forwards the old key", async () => {
  const requests = [];
  const storage = fixtureStorage({ [KEY]: state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "deepseek-model") }) });
  const app = await settingsApp({ storage, fetcher: async (url, init) => { requests.push({ url, key: init.headers.Authorization }); return Response.json({ data: [{ id: "openai-model" }] }); } });
  app.change("api-key", "UNSAVED_DRAFT_KEY");
  app.change("provider", "openai");
  assert.equal(app.id("api-endpoint").props.value, OPENAI);
  assert.equal(app.id("api-key").props.value, "");
  assert.equal(app.id("api-key").props.required, true);
  assert.equal(app.button("获取模型").props.disabled, true);
  app.change("api-key", "FIXTURE_OPENAI"); app.change("model", "openai-model");
  await app.click("获取模型");
  assert.deepEqual(requests, [{ url: `${OPENAI}/models`, key: "Bearer FIXTURE_OPENAI" }]);
  await app.submit("settings-form");
  assert.equal(readState(app).profiles[DEEPSEEK].apiKey, "FIXTURE_DEEPSEEK");
  assert.equal(readState(app).profiles[OPENAI].apiKey, "FIXTURE_OPENAI");
  app.change("provider", "deepseek");
  assert.equal(app.id("api-key").props.value, "");
  assert.equal(app.id("api-key").props.required, false);
  assert.equal(app.id("model").props.value, "deepseek-model");
  await app.submit("settings-form");
  assert.equal(readState(app).activeEndpoint, DEEPSEEK);
  assert.equal(readState(app).profiles[OPENAI].apiKey, "FIXTURE_OPENAI");
  assert.equal(requests.length, 1);
});

test("saved key model discovery is browser-direct and normalizes/deduplicates available model IDs", async () => {
  const storage = fixtureStorage({ [KEY]: state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "deepseek-model") }) });
  let calls = 0;
  const app = await settingsApp({ storage, fetcher: async (url, init) => {
    calls++; assert.equal(url, `${DEEPSEEK}/models`); assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer FIXTURE_DEEPSEEK");
    return Response.json({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }, { id: "bad model" }] });
  } });
  assert.equal(calls, 0); await app.click("获取模型");
  const options = app.id("available-model").props.children.flat(Infinity).filter((node) => node?.type === "option");
  assert.deepEqual(options.map((node) => node.props.value), ["", "model-a", "model-b"]);
  app.change("available-model", "model-a"); await app.submit("settings-form");
  assert.equal(readState(app).profiles[DEEPSEEK].model, "model-a"); assert.equal(calls, 1);
});

test("a later endpoint change aborts discovery and ignores a late old-provider response", async () => {
  const storage = fixtureStorage({ [KEY]: state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "deepseek-model") }) });
  let resolveResponse, requestSignal;
  const app = await settingsApp({ storage, fetcher: (_url, init) => { requestSignal = init.signal; return new Promise((resolve) => { resolveResponse = resolve; }); } });
  await app.click("获取模型");
  assert.equal(app.button("获取中…").props.disabled, true);
  app.change("provider", "openai"); assert.equal(requestSignal.aborted, true);
  resolveResponse(Response.json({ data: [{ id: "STALE_MODEL" }] })); await app.flush();
  assert.equal(app.id("api-endpoint").props.value, OPENAI);
  assert.equal(app.id("available-model").props.disabled, true);
  assert.equal(app.text(app.id("available-model")).includes("STALE_MODEL"), false);
  assert.equal(app.id("api-key").props.value, "");
});

test("quota failure reports unsaved settings without replacing the existing working profile", async () => {
  const original = state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "original-model") });
  const storage = fixtureStorage({ [KEY]: original });
  const app = await settingsApp({ storage });
  storage.failWrite = true;
  app.change("api-key", "NEW_UNSAVED_FIXTURE"); app.change("model", "new-model");
  await app.submit("settings-form");
  assert.equal(storage.getItem(KEY), original);
  assert.match(feedback(app), /未能保存|存储|保存失败/);
  assert.equal(app.text(app.all()).includes("NEW_UNSAVED_FIXTURE"), false);
});

test("blocked reads and corrupt settings surface actionable errors without making a request or overwriting data", async () => {
  for (const corrupted of [false, true]) {
    const storage = fixtureStorage(corrupted ? { [KEY]: "{broken" } : {});
    storage.failRead = !corrupted;
    const app = await settingsApp({ storage });
    assert.equal(app.button("enhance-button").props.disabled, true);
    assert.match(app.text(app.all()), corrupted ? /本机模型配置已损坏/ : /无法读取本机模型配置/);
    if (corrupted) assert.equal(storage.getItem(KEY), "{broken");
  }
});

test("clear removes every app-owned provider profile but leaves unrelated storage and prompt text", async () => {
  const storage = fixtureStorage({ unrelated: "KEEP", [KEY]: state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "model-a"), [OPENAI]: profile("FIXTURE_OPENAI", "model-b") }) });
  const app = await settingsApp({ storage });
  app.change("prompt", "Keep this draft");
  await app.click("清除本机配置");
  assert.equal(storage.getItem(KEY), null); assert.equal(storage.getItem("unrelated"), "KEEP");
  assert.equal(app.id("prompt").props.value, "Keep this draft");
  assert.equal(app.id("api-key").props.value, "");
  assert.equal(app.button("enhance-button").props.disabled, true);
});

test("failed clearing keeps persisted settings and reports browser recovery instructions", async () => {
  const original = state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "model-a") });
  const storage = fixtureStorage({ [KEY]: original });
  const app = await settingsApp({ storage });
  storage.failRemove = true; await app.click("清除本机配置");
  assert.equal(storage.getItem(KEY), original);
  assert.match(feedback(app), /未能清除|浏览器|存储/);
});

test("another tab's settings update clears unsaved credentials and restores only the new active profile", async () => {
  const storage = fixtureStorage({ [KEY]: state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "model-a") }) });
  let calls = 0;
  const app = await settingsApp({ storage, fetcher: async () => { calls++; throw new Error("No automatic calls"); } });
  app.change("api-key", "UNSAVED_DRAFT_KEY");
  storage.setItem(KEY, state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "model-a"), [OPENAI]: profile("FIXTURE_OPENAI", "model-b") }, OPENAI));
  app.storageEvent({ key: KEY }); await app.flush();
  assert.equal(app.id("api-key").props.value, "");
  assert.equal(app.id("api-endpoint").props.value, OPENAI);
  assert.equal(app.id("model").props.value, "model-b");
  assert.equal(app.id("api-key").props.required, false);
  storage.removeItem(KEY); app.storageEvent({ key: KEY }); await app.flush();
  assert.equal(app.id("api-key").props.value, "");
  assert.equal(app.id("api-key").props.required, true);
  assert.equal(app.button("enhance-button").props.disabled, true);
  assert.equal(calls, 0);
});

test("provider list failures use safe errors and leave manual model entry usable", async () => {
  const storage = fixtureStorage({ [KEY]: state({ [DEEPSEEK]: profile("FIXTURE_DEEPSEEK", "model-a") }) });
  const app = await settingsApp({ storage, fetcher: async () => new Response("SECRET_PROVIDER_DIAGNOSTIC", { status: 401 }) });
  await app.click("获取模型");
  assert.match(feedback(app), /密钥|权限/);
  assert.equal(feedback(app).includes("SECRET_PROVIDER_DIAGNOSTIC"), false);
  assert.equal(app.id("model").props.disabled, false);
  app.change("model", "manual-model"); await app.submit("settings-form");
  assert.equal(readState(app).profiles[DEEPSEEK].model, "manual-model");
});
