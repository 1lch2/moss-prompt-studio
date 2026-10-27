import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = new Map();
function sourceCode(file) {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText);
  return compiled.get(file);
}
export function fixtureStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values, failRead: false, failWrite: false, failRemove: false,
    getItem(key) { if (this.failRead) throw new DOMException("Fixture denied", "SecurityError"); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw new DOMException("Fixture full", "QuotaExceededError"); values.set(key, value); },
    removeItem(key) { if (this.failRemove) throw new DOMException("Fixture denied", "SecurityError"); values.delete(key); },
    clear() { throw new Error("App must not clear unrelated localStorage"); },
  };
}

// Actual component + imported browser helpers; only React scheduling/DOM APIs and
// browser transport/storage are fixture-controlled. This is not a pixel/DOM test.
export function workbench({ fetcher = async () => { throw new Error("Unexpected network request"); }, clipboardFails = false, storage = fixtureStorage() } = {}) {
  const hooks = [], pendingEffects = [], listeners = new Map(), clipboard = [];
  let cursor = 0, tree, focused, selected = false, dirty = false, disposed = false;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (value) => { const next = typeof value === "function" ? value(hooks[index]) : value; if (!Object.is(hooks[index], next)) { hooks[index] = next; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!sameDeps(hooks[index]?.deps, deps)) {
        const old = hooks[index];
        hooks[index] = { deps, cleanup: old?.cleanup };
        pendingEffects.push(() => { old?.cleanup?.(); hooks[index].cleanup = callback(); });
      }
    },
    useCallback(callback, deps) { const index = cursor++; if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, callback }; return hooks[index].callback; },
  };
  const window = {
    localStorage: storage,
    setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
    addEventListener(type, callback) { const handlers = listeners.get(type) ?? new Set(); handlers.add(callback); listeners.set(type, handlers); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const loadedModule = { exports: {} };
    modules.set(file, loadedModule.exports);
    const localRequire = (name) => {
      if (name === "react") return react;
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
      if (name === "../components/bbox-workbench") return { default: "BboxWorkbench" };
      if (name.startsWith(".")) return load(resolve(dirname(file), `${name}.ts`));
      return require(name);
    };
    new Function("require", "module", "exports", "fetch", "navigator", "document", "window", "localStorage", "globalThis", sourceCode(file))(
      localRequire, loadedModule, loadedModule.exports, fetcher,
      { clipboard: { async writeText(text) { if (clipboardFails) throw new Error("Clipboard unavailable"); clipboard.push(text); } } },
      { getElementById: (id) => ({ focus: () => { focused = id; } }) }, window, storage, { localStorage: storage, fetch: fetcher },
    );
    return loadedModule.exports;
  }
  const Component = load(resolve(root, "app/page.tsx")).default;
  function all(node = tree) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((item) => all(item ?? null));
    return [node, ...all(node.props?.children ?? null)];
  }
  const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : text(node?.props?.children ?? "");
  const find = (predicate) => all().find(predicate);
  const id = (name) => find((node) => node.props?.id === name);
  function render() {
    assert.equal(disposed, false, "render after unmount");
    cursor = 0; dirty = false; tree = Component();
    for (const node of all().filter((item) => item.type === "textarea" && item.props.ref)) {
      node.props.ref.current = { focus: () => { focused = node.props.id ?? "output"; }, select: () => { selected = true; } };
    }
    for (const effect of pendingEffects.splice(0)) effect();
  }
  async function flush() {
    for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(); }
  }
  const change = (name, value) => { assert.ok(id(name), `Missing field ${name}`); id(name).props.onChange({ target: { value } }); render(); };
  const submit = (className = "panel input-panel") => {
    const pending = find((node) => node.type === "form" && node.props.className === className).props.onSubmit({ preventDefault() {} });
    render();
    return Promise.resolve(pending).then(flush);
  };
  const button = (name) => find((node) => node.type === "button" && (node.props["aria-label"] === name || text(node) === name || node.props.className === name));
  const click = (name) => { const node = button(name); assert.ok(node, `Missing button ${name}`); const pending = node.props.onClick(); render(); return Promise.resolve(pending).then(flush); };
  render();
  return { all, id, find, text, render, flush, change, submit, clipboard, storage, button, click,
    output: () => find((node) => node.type === "textarea" && node.props.readOnly)?.props.value,
    copy: () => click("copy-button"),
    key(key) { find((node) => node.props.role === "tablist").props.onKeyDown({ key, preventDefault() {} }); render(); },
    storageEvent(event = {}) { for (const listener of listeners.get("storage") ?? []) listener({ storageArea: storage, ...event }); render(); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); disposed = true; },
    focus: () => focused, selected: () => selected,
  };
}
