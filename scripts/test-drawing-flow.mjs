import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
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

// Exercise actual component handlers and state transitions without a browser dependency.
// Effects and DOM layout are omitted here; browser QA separately covers rendering and pointer capture.
function workbench({ imageLoad, ready = false, fetch: mockFetch } = {}) {
  const hooks = [];
  let cursor = 0, tree;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value) => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ??= { current: initial };
    },
    useEffect() { cursor++; },
  };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const loadedModule = { exports: {} };
    modules.set(file, loadedModule.exports);
    const localRequire = (name) => {
      if (name === "react") return react;
      if (name === "lucide-react" || name === "./ui/tooltip") return new Proxy({}, { get: (_, key) => String(key) });
      if (name.startsWith(".")) {
        const imported = load(resolve(dirname(file), `${name}.ts`));
        if (name === "../lib/canvas-reference" && imageLoad) return { ...imported, LocalReferenceImageLoader: class { load = imageLoad; clear() {} } };
        return imported;
      }
      return require(name);
    };
    new Function("require", "module", "exports", "fetch", sourceCode(file))(localRequire, loadedModule, loadedModule.exports, mockFetch ?? (() => { throw new Error("Unexpected network request"); }));
    return loadedModule.exports;
  }
  const Component = load(resolve(root, "components/bbox-workbench.tsx")).default;
  const captures = new Set();
  const svg = {
    focus() {},
    getScreenCTM: () => ({ inverse: () => ({}) }),
    createSVGPoint: () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }),
    setPointerCapture: (id) => captures.add(id),
    hasPointerCapture: (id) => captures.has(id),
    releasePointerCapture: (id) => captures.delete(id),
  };
  function all(node = tree) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((item) => all(item ?? null));
    return [node, ...all(node.props?.children ?? null)];
  }
  const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : text(node?.props?.children ?? "");
  function render() {
    cursor = 0;
    tree = Component({ ready, connection: ready ? { endpoint: "https://api.deepseek.com", model: "fixture-model", apiKey: "FIXTURE_ONLY_KEY" } : null, saving: false, onBusyChange() {} });
    all().find((node) => node.type === "svg").props.ref.current = svg;
  }
  const find = (predicate) => all().find(predicate);
  const button = (name) => find((node) => node.type === "button" && (node.props["aria-label"] === name || text(node) === name));
  const act = (callback) => { callback(); render(); };
  function point(handler, x, y, target = {}, pointerId = 1) {
    const node = find((item) => item.type === "svg");
    act(() => node.props[handler]({
      button: 0, pointerId, clientX: x, clientY: y, currentTarget: svg,
      target: { closest: () => target.id ? { getAttribute: () => target.id } : null, getAttribute: () => target.corner ?? null },
      preventDefault() {},
    }));
  }
  render();
  return {
    all, find, button, act, point, captures,
    click: (name) => act(() => { const node = button(name); assert.ok(node, `Missing button ${name}`); node.props.onClick(); }),
    key: (key) => act(() => tree.props.onKeyDownCapture({ key, preventDefault() {}, stopPropagation() {} })),
    draw(x1 = 100, y1 = 100, x2 = 400, y2 = 400, target) { point("onPointerDown", x1, y1, target); point("onPointerMove", x2, y2); point("onPointerUp", x2, y2); },
    boxes: () => all().filter((node) => node.type === "g" && node.props["data-region"]).map((node) => {
      const rect = all(node).find((child) => child.type === "rect");
      return { id: node.props["data-region"], box: [rect.props.x, rect.props.y, rect.props.x + rect.props.width, rect.props.y + rect.props.height], color: rect.props.fill };
    }),
    drawing: () => !!find((node) => node.props?.className === "canvas-draw-hint"),
  };
}

test("both Add buttons enter draw mode without creating a default box; header controls are replaced", () => {
  for (const index of [0, 1]) {
    const app = workbench();
    assert.equal(app.drawing(), false);
    const add = app.all().filter((node) => node.props?.["aria-label"] === "添加区域")[index];
    app.act(() => add.props.onClick());
    assert.equal(app.drawing(), true);
    assert.deepEqual(app.boxes(), []);
    assert.ok(app.button("退出"));
    for (const hidden of ["导入底图", "选择", "画框"]) assert.equal(app.button(hidden), undefined);
    assert.equal(app.find((node) => node.props?.id === "canvas-title").props.children, "开始画框");
    app.click("退出");
    assert.equal(app.drawing(), false);
    assert.deepEqual(app.boxes(), []);
    assert.ok(app.button("导入底图"));
  }
});

test("valid reverse-direction drawing creates one exact box and returns to selection", () => {
  const app = workbench();
  app.click("画框");
  app.draw(600, 500, 100, 200);
  assert.deepEqual(app.boxes().map(({ box }) => box), [[100, 200, 600, 500]]);
  assert.equal(app.drawing(), false);
  assert.equal(app.captures.size, 0);
  app.draw(700, 700, 900, 900); // Selection mode does not add another region.
  assert.equal(app.boxes().length, 1);
});

test("clicks, tiny drags and interrupted pointers create nothing and allow retry", () => {
  const app = workbench();
  app.click("添加区域");
  app.draw(100, 100, 100, 100);
  app.draw(100, 100, 103, 300);
  assert.deepEqual(app.boxes(), []);
  for (const event of ["onPointerCancel", "onLostPointerCapture"]) {
    app.point("onPointerDown", 100, 100);
    app.point("onPointerMove", 400, 400);
    app.point(event, 400, 400);
    app.point("onPointerUp", 400, 400);
    assert.deepEqual(app.boxes(), []);
    assert.equal(app.captures.size, 0);
    assert.equal(app.drawing(), true);
  }
  app.draw();
  assert.equal(app.boxes().length, 1);
});

test("Exit and Escape discard an in-flight preview; late pointer-up cannot add a region", () => {
  for (const cancel of [(app) => app.click("退出"), (app) => app.key("Escape")]) {
    const app = workbench();
    app.click("添加区域");
    app.point("onPointerDown", 100, 100);
    app.point("onPointerMove", 400, 400);
    cancel(app);
    app.point("onPointerUp", 400, 400);
    assert.equal(app.drawing(), false);
    assert.equal(app.captures.size, 0);
    assert.deepEqual(app.boxes(), []);
  }
});

test("drawing over existing regions cannot move or resize them, and colors stay distinct", () => {
  const app = workbench();
  app.click("添加区域"); app.draw();
  const original = app.boxes()[0];
  app.click("添加区域");
  assert.equal(app.all().filter((node) => node.props?.["data-corner"]).length, 0);
  app.draw(100, 100, 500, 500, { id: original.id, corner: "nw" });
  assert.deepEqual(app.boxes()[0], original);
  assert.equal(app.boxes().length, 2);
  assert.notEqual(app.boxes()[0].color, app.boxes()[1].color);
});

test("region limit blocks all entry points and no default geometry can bypass it", () => {
  const app = workbench();
  for (let index = 0; index < 24; index++) { app.click("添加区域"); app.draw(); }
  assert.equal(app.boxes().length, 24);
  assert.equal(app.button("画框").props.disabled, true);
  const adds = app.all().filter((node) => node.props?.["aria-label"] === "添加区域");
  assert.equal(adds.length, 2);
  for (const add of adds) {
    assert.equal(add.props.disabled, true);
    app.act(() => add.props.onClick()); // Handler guard as well as disabled UI.
    assert.equal(app.drawing(), false);
  }
  assert.equal(new Set(app.boxes().map(({ color }) => color)).size, 24);
});

test("dropping a reference image exits drawing and blocks entry until loading completes", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const app = workbench({ imageLoad: () => pending });
  app.click("添加区域");
  app.point("onPointerDown", 100, 100);
  app.point("onPointerMove", 400, 400);
  const stage = app.find((node) => node.props?.className === "canvas-stage-wrap");
  app.act(() => stage.props.onDrop({ preventDefault() {}, dataTransfer: { files: [{}] } }));
  assert.equal(app.drawing(), false);
  assert.equal(app.button("画框").props.disabled, true);
  app.click("添加区域");
  app.point("onPointerUp", 400, 400);
  assert.deepEqual(app.boxes(), []);
  assert.equal(app.drawing(), false);
  finish(null);
  await pending;
  app.act(() => {});
  app.click("添加区域");
  assert.equal(app.drawing(), true);
});

test("enhancement exits drawing, retains the existing layout and blocks a new draw while busy", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const app = workbench({ ready: true, fetch: () => pending });
  app.click("添加区域"); app.draw();
  for (const id of ["layout-summary", "region-caption"]) {
    app.act(() => app.find((node) => node.props?.id === id).props.onChange({ target: { value: "test description" } }));
  }
  const original = app.boxes();
  app.click("添加区域");
  app.click("增强并生成 JSON");
  assert.equal(app.drawing(), false);
  assert.equal(app.button("画框").props.disabled, true);
  app.click("添加区域");
  app.draw();
  assert.equal(app.drawing(), false);
  assert.deepEqual(app.boxes(), original);
  finish(new Response("Synthetic upstream failure", { status: 502 }));
  await pending;
  for (let tick = 0; tick < 12; tick++) await Promise.resolve();
  app.act(() => {});
  app.click("添加区域");
  assert.equal(app.drawing(), true);
});
