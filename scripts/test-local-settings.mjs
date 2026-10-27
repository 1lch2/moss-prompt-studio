import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(root, ".test-runtime");
await mkdir(testRoot, { recursive: true });
const buildDir = await mkdtemp(join(testRoot, "local-settings-"));
after(() => rm(buildDir, { recursive: true, force: true }));
for (const name of ["model-providers", "model-errors", "model-settings", "local-settings"]) {
  const source = await readFile(join(root, "lib", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/from "(\.\/[^\"]+)"/g, 'from "$1.js"');
  await writeFile(join(buildDir, `${name}.js`), compiled);
}
const { LOCAL_SETTINGS_KEY, LocalSettingsError, emptyLocalSettings, loadLocalSettings, getStoredConnection, getActiveConnection, resolveModelConnection, saveLocalSettings, clearLocalSettings } = await import(pathToFileURL(join(buildDir, "local-settings.js")).href);
const a = { endpoint: "https://api.deepseek.com", apiKey: "FIXTURE_ONLY_A", model: "model-a" };
const b = { endpoint: "https://api.openai.com/v1", apiKey: "FIXTURE_ONLY_B", model: "model-b" };
function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
const safeError = (error) => error instanceof LocalSettingsError && !error.message.includes("FIXTURE_ONLY") && !error.message.includes("SECRET_ERROR");

test("fresh browser is unconfigured with independent state objects and no storage writes", () => {
  const store = storage({ unrelated: "keep-me" });
  assert.deepEqual(loadLocalSettings(store), { version: 1, activeEndpoint: null, profiles: {} });
  assert.equal(getActiveConnection(loadLocalSettings(store)), null);
  assert.equal(store.values.size, 1);
  assert.notEqual(emptyLocalSettings().profiles, emptyLocalSettings().profiles);
});

test("save persists only app-owned versioned local settings; reload restores active endpoint/model/key", () => {
  const store = storage({ unrelated: "keep-me" });
  const saved = saveLocalSettings(a, store);
  assert.deepEqual(getActiveConnection(saved), a);
  assert.deepEqual(loadLocalSettings(store), saved);
  assert.equal(store.values.get("unrelated"), "keep-me");
  assert.equal(store.values.size, 2);
});

test("normalization safely reuses an existing endpoint; blank key retains only that profile", () => {
  const store = storage();
  saveLocalSettings(a, store);
  const state = saveLocalSettings({ endpoint: a.endpoint + "/chat/completions/", apiKey: "", model: "updated-a" }, store);
  assert.deepEqual(getActiveConnection(state), { ...a, model: "updated-a" });
  assert.equal(Object.keys(state.profiles).length, 1);
  assert.deepEqual(resolveModelConnection(state, { endpoint: a.endpoint, apiKey: "" }), { ...a, model: "updated-a" });
});

test("switching providers retains endpoint-scoped model/key and re-selecting never carries another endpoint key", () => {
  const store = storage();
  saveLocalSettings(a, store);
  const both = saveLocalSettings(b, store);
  assert.deepEqual(getActiveConnection(both), b);
  assert.deepEqual(getStoredConnection(both, a.endpoint), a);
  const restored = saveLocalSettings({ ...a, apiKey: "" }, store);
  assert.deepEqual(getActiveConnection(restored), a);
  assert.deepEqual(getStoredConnection(restored, b.endpoint), b);
});

test("destination changes in host, port, or path require that exact endpoint's credential", () => {
  const store = storage();
  const state = saveLocalSettings(a, store);
  const before = store.values.get(LOCAL_SETTINGS_KEY);
  for (const endpoint of [b.endpoint, a.endpoint + "/v1", a.endpoint + ":8443", "https://custom.example.com/v1"]) {
    assert.equal(getStoredConnection(state, endpoint), null);
    assert.throws(() => resolveModelConnection(state, { endpoint, apiKey: "" }), safeError);
    assert.throws(() => saveLocalSettings({ endpoint, apiKey: "", model: "new-model" }, store), safeError);
    assert.equal(store.values.get(LOCAL_SETTINGS_KEY), before);
  }
});

test("typed key can query another selected endpoint without saving or changing active settings", () => {
  const store = storage();
  const state = saveLocalSettings(a, store);
  const before = store.values.get(LOCAL_SETTINGS_KEY);
  assert.deepEqual(resolveModelConnection(state, b), b);
  assert.equal(store.values.get(LOCAL_SETTINGS_KEY), before);
  assert.deepEqual(getActiveConnection(loadLocalSettings(store)), a);
});

test("save reads latest storage rather than overwriting profiles added in another tab", () => {
  const store = storage();
  saveLocalSettings(a, store);
  saveLocalSettings(b, store);
  const state = saveLocalSettings({ ...a, apiKey: "", model: "new-a" }, store);
  assert.deepEqual(getStoredConnection(state, b.endpoint), b);
});

test("unsupported/corrupt data is explicit and never silently erased or overwritten", () => {
  for (const raw of ["not-json", "null", "[]", "{}", JSON.stringify({ version: 2, activeEndpoint: null, profiles: {} }),
    JSON.stringify({ version: 1, activeEndpoint: a.endpoint, profiles: {} }),
    JSON.stringify({ version: 1, activeEndpoint: null, profiles: { [a.endpoint]: { apiKey: "", model: "valid-model" } } }),
    JSON.stringify({ version: 1, activeEndpoint: a.endpoint, profiles: { [a.endpoint]: { apiKey: a.apiKey, model: "invalid model" } } }),
    JSON.stringify({ version: 1, activeEndpoint: "http://bad.example.com", profiles: { "http://bad.example.com": { apiKey: a.apiKey, model: a.model } } }),
    JSON.stringify({ version: 1, activeEndpoint: null, profiles: {}, unexpected: a.apiKey }), "x".repeat(512001)]) {
    const store = storage({ [LOCAL_SETTINGS_KEY]: raw });
    assert.throws(() => loadLocalSettings(store), safeError);
    assert.throws(() => saveLocalSettings(a, store), safeError);
    assert.equal(store.values.get(LOCAL_SETTINGS_KEY), raw);
  }
});

test("clear removes all this app's endpoint profiles, not unrelated storage, including corrupt settings", () => {
  const store = storage({ unrelated: "keep-me" });
  saveLocalSettings(a, store); saveLocalSettings(b, store);
  assert.deepEqual(clearLocalSettings(store), emptyLocalSettings());
  assert.deepEqual([...store.values.entries()], [["unrelated", "keep-me"]]);
  store.setItem(LOCAL_SETTINGS_KEY, "invalid json");
  clearLocalSettings(store);
  assert.deepEqual(loadLocalSettings(store), emptyLocalSettings());
});

test("read-denied storage is actionable; save never writes if read failed", () => {
  let writes = 0;
  const store = { getItem() { throw new Error("SECRET_ERROR"); }, setItem() { writes++; }, removeItem() {} };
  assert.throws(() => loadLocalSettings(store), safeError);
  assert.throws(() => saveLocalSettings(a, store), safeError);
  assert.equal(writes, 0);
});

test("quota/write errors do not report success and preserve existing settings", () => {
  const store = storage();
  saveLocalSettings(a, store);
  const before = store.values.get(LOCAL_SETTINGS_KEY);
  store.setItem = () => { throw new DOMException("SECRET_ERROR", "QuotaExceededError"); };
  assert.throws(() => saveLocalSettings(b, store), safeError);
  assert.equal(store.values.get(LOCAL_SETTINGS_KEY), before);
  assert.deepEqual(getActiveConnection(loadLocalSettings(store)), a);
});

test("failed clear remains a failure and never empties in-memory state falsely", () => {
  const store = storage();
  saveLocalSettings(a, store);
  store.removeItem = () => { throw new Error("SECRET_ERROR"); };
  assert.throws(() => clearLocalSettings(store), safeError);
  assert.deepEqual(getActiveConnection(loadLocalSettings(store)), a);
});

test("denied browser localStorage getter is caught before use", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("SECRET_ERROR", "SecurityError"); } });
  try {
    assert.throws(() => loadLocalSettings(), safeError);
    assert.throws(() => clearLocalSettings(), safeError);
    assert.throws(() => saveLocalSettings(a), safeError);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("invalid endpoint/key/model inputs are rejected without storing credentials", () => {
  const store = storage();
  for (const bad of [{ ...a, endpoint: "http://unsafe.example.com" }, { ...a, apiKey: "fixture\nAuthorization: bad" }, { ...a, model: "model with spaces" }, { ...a, model: "" }]) {
    assert.throws(() => saveLocalSettings(bad, store));
    assert.equal(store.values.size, 0);
  }
});


test("save cannot create a profile document too large to reload", () => {
  const profiles = {};
  let raw = "";
  let index = 0;
  do {
    profiles[`https://provider-${index++}.example.com`] = { apiKey: "x".repeat(4096), model: "fixture-model" };
    raw = JSON.stringify({ version: 1, activeEndpoint: null, profiles });
  } while (raw.length < 508000);
  assert.ok(raw.length <= 512000);
  const store = storage({ [LOCAL_SETTINGS_KEY]: raw });
  assert.equal(loadLocalSettings(store).activeEndpoint, null);
  assert.throws(() => saveLocalSettings({ ...a, apiKey: "y".repeat(4096) }, store), safeError);
  assert.equal(store.values.get(LOCAL_SETTINGS_KEY), raw);
});
