"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Check, CircleAlert, Copy, Download, ImagePlus, Keyboard, LoaderCircle, MousePointer2, Plus, Scan, Sparkles, Trash2, X } from "lucide-react";
import { applyEnhancedLayout, compileLayout, layoutDraftSchema, type LayoutDraft, type LayoutRegion, type MossLayoutPrompt } from "../lib/moss-layout";

import { enhanceLayoutWithModel } from "../lib/layout-enhancement";
import type { ModelConnection } from "../lib/model-client";
import { moveBox, resizeBox, scaleBox } from "../lib/layout-editor";
import { assignRegionColor, nextRegionColor, releaseRegionColor, type RegionColors } from "../lib/region-colors";
import { LocalReferenceImageLoader, REFERENCE_IMAGE_ACCEPT, RESOLUTION_PRESETS, type CanvasReference } from "../lib/canvas-reference";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type Mode = "写实" | "二次元" | "跨次元";
type Box = [number, number, number, number];
type Point = { x: number; y: number };
type Corner = "nw" | "ne" | "sw" | "se";
type Gesture = { kind: "draw"; start: Point } | { kind: "move" | "resize"; start: Point; id: string; original: Box; corner?: Corner };
const LABELS = { object: "物体", character: "人物", text: "文字" };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const orderedBox = (a: Point, b: Point): Box => [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];

function getDraftError(draft: LayoutDraft) {
  if (!draft.summary.trim()) return "先填写全局画面描述。";
  if (!draft.regions.length) return "点击「添加区域」，再在画布中拖动创建第一个框。";
  const index = draft.regions.findIndex((region) => !region.caption.trim() || (region.label === "text" && !region.text?.trim()));
  if (index !== -1) return `请补全区域 ${String(index + 1).padStart(2, "0")} 的${draft.regions[index].label === "text" ? "外观描述与原样文字" : "提示词"}。`;
  return layoutDraftSchema.safeParse(draft).success ? "" : "请检查画布尺寸和区域坐标，所有框必须位于画布内。";
}

export default function BboxWorkbench({ ready, connection, saving, onBusyChange }: { ready: boolean; connection: ModelConnection | null; saving: boolean; onBusyChange: (busy: boolean) => void }) {
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [dimensionWidth, setDimensionWidth] = useState("1024");
  const [dimensionHeight, setDimensionHeight] = useState("1024");
  const [summary, setSummary] = useState("");
  const [preferences, setPreferences] = useState("");
  const [mode, setMode] = useState<Mode>("写实");
  const [regions, setRegions] = useState<LayoutRegion[]>([]);
  const [regionColors, setRegionColors] = useState<RegionColors>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<"draw" | "select">("select");
  const [previewBox, setPreviewBox] = useState<Box | null>(null);
  const [result, setResult] = useState("");
  const [resultKind, setResultKind] = useState<"raw" | "enhanced">("raw");
  const [resultDraft, setResultDraft] = useState("");
  const [resultSize, setResultSize] = useState({ width: 1024, height: 1024 });
  const [error, setError] = useState("");
  const [dimensionError, setDimensionError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reference, setReference] = useState<CanvasReference | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState("");
  const [imageStatus, setImageStatus] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [stageSize, setStageSize] = useState({ width: 400, height: 400 });
  const svgRef = useRef<SVGSVGElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const referenceLoader = useRef<LocalReferenceImageLoader | null>(null);
  const imageRequest = useRef(0);
  const imageBusyRef = useRef(false);
  const dimensionsRef = useRef({ width: 1024, height: 1024 });
  const dragDepth = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const activePointer = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const idRef = useRef(0);
  const selected = regions.find((region) => region.id === selectedId);
  const selectedIndex = regions.findIndex((region) => region.id === selectedId);
  const draft: LayoutDraft = { width, height, summary, regions };
  const currentSignature = JSON.stringify({ ...draft, mode, preferences });
  const dimensionsPending = dimensionWidth !== String(width) || dimensionHeight !== String(height);
  const stale = !!result && (resultDraft !== currentSignature || dimensionsPending);
  const resultNote = copyState === "failed" ? "自动复制不可用，已选中文本，请手动复制。" : copyState === "copied" ? "已复制紧凑 JSON，可粘贴为正向提示词。" : result && !stale ? `${resultKind === "enhanced" ? "已增强" : "未增强"} · 出图尺寸须为 ${resultSize.width} × ${resultSize.height}` : "";
  const scale = Math.min(stageSize.width / width, stageSize.height / height) || 1;
  const handleSize = 11 / scale;
  const editorLocked = loading || imageLoading;
  const previewColor = nextRegionColor(regionColors);
  const selectedPreset = RESOLUTION_PRESETS.flatMap((group) => group.sizes).some(([, w, h]) => String(w) === dimensionWidth && String(h) === dimensionHeight) ? `${dimensionWidth}x${dimensionHeight}` : "";

  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => {
    requestRef.current?.abort();
    ++imageRequest.current;
    referenceLoader.current?.clear();
  }, []);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  function updateRegion(id: string, changes: Partial<LayoutRegion>) {
    setRegions((current) => current.map((region) => region.id === id ? { ...region, ...changes } : region));
    setError("");
    setCopyState("idle");
  }

  function startDrawing() {
    if (regions.length >= 24 || editorLocked || busyRef.current || imageBusyRef.current) return;
    cancelGesture();
    setTool("draw");
    setError("");
    svgRef.current?.focus();
  }

  function exitDrawing() {
    cancelGesture();
    setTool("select");
  }

  function addRegion(box: Box) {
    if (regions.length >= 24 || editorLocked || busyRef.current || imageBusyRef.current) return;
    const id = `region-${++idRef.current}`;
    setRegionColors((current) => assignRegionColor(current, id));
    setRegions((current) => [...current, { id, label: "object", caption: "", box }]);
    setSelectedId(id);
    setTool("select");
    setError("");
    setCopyState("idle");
  }

  function removeRegion() {
    if (!selectedId || editorLocked) return;
    const next = regions.filter((region) => region.id !== selectedId);
    setRegionColors((current) => releaseRegionColor(current, selectedId));
    setRegions(next);
    setSelectedId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null);
    setError("");
    setCopyState("idle");
  }

  function canvasPoint(event: PointerEvent<SVGSVGElement>): Point | null {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: clamp(Math.round(local.x), 0, width), y: clamp(Math.round(local.y), 0, height) };
  }

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (editorLocked || busyRef.current || imageBusyRef.current || event.button !== 0 || gesture.current) return;
    const point = canvasPoint(event);
    if (!point) return;
    const target = event.target as SVGElement;
    const id = target.closest("[data-region]")?.getAttribute("data-region");
    const corner = target.getAttribute("data-corner") as Corner | null;
    const region = regions.find((item) => item.id === id);
    if (tool === "draw" && regions.length < 24) {
      gesture.current = { kind: "draw", start: point };
      setPreviewBox([point.x, point.y, point.x, point.y]);
    } else if (tool === "select" && corner && region) {
      gesture.current = { kind: "resize", start: point, id: region.id, original: [...region.box] as Box, corner };
    } else if (tool === "select" && region) {
      setSelectedId(region.id);
      gesture.current = { kind: "move", start: point, id: region.id, original: [...region.box] as Box };
    } else { setSelectedId(null); }
    event.currentTarget.focus();
    if (gesture.current) { activePointer.current = event.pointerId; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const current = gesture.current;
    const point = canvasPoint(event);
    if (!current || !point || activePointer.current !== event.pointerId) return;
    event.preventDefault();
    if (current.kind === "draw") { setPreviewBox(orderedBox(current.start, point)); return; }
    const box = current.kind === "move"
      ? moveBox(current.original, point.x - current.start.x, point.y - current.start.y, width, height)
      : resizeBox(current.original, current.corner!, point.x, point.y, width, height);
    updateRegion(current.id, { box });
  }

  function pointerEnd(event: PointerEvent<SVGSVGElement>, cancel = false) {
    const current = gesture.current;
    if (!current || activePointer.current !== event.pointerId) return;
    if (current.kind === "draw" && !cancel) {
      const point = canvasPoint(event);
      if (point) { const box = orderedBox(current.start, point); if (box[2] - box[0] >= 4 && box[3] - box[1] >= 4) addRegion(box); }
    } else if (cancel && current.kind !== "draw") updateRegion(current.id, { box: current.original });
    gesture.current = null;
    activePointer.current = null;
    setPreviewBox(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function canvasKeys(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === "Escape") {
      cancelGesture();
      setSelectedId(null);
      return;
    }
    if (!selected || editorLocked || gesture.current || tool === "draw") return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeRegion(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    updateRegion(selected.id, { box: moveBox(selected.box, dx, dy, width, height) });
  }

  function updateCoordinate(field: "x" | "y" | "w" | "h", raw: string) {
    if (!selected || raw === "") return;
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value)) return;
    const [x1, y1, x2, y2] = selected.box;
    let box: Box = [...selected.box] as Box;
    if (field === "x") { const x = clamp(value, 0, width - (x2 - x1)); box = [x, y1, x + x2 - x1, y2]; }
    if (field === "y") { const y = clamp(value, 0, height - (y2 - y1)); box = [x1, y, x2, y + y2 - y1]; }
    if (field === "w") box[2] = x1 + clamp(value, 1, width - x1);
    if (field === "h") box[3] = y1 + clamp(value, 1, height - y1);
    updateRegion(selected.id, { box });
  }

  function cancelGesture() {
    const current = gesture.current;
    if (current && current.kind !== "draw") updateRegion(current.id, { box: current.original });
    gesture.current = null;
    setPreviewBox(null);
    const pointer = activePointer.current;
    activePointer.current = null;
    if (pointer !== null && svgRef.current?.hasPointerCapture(pointer)) svgRef.current.releasePointerCapture(pointer);
  }

  function resizeCanvas(w: number, h: number) {
    cancelGesture();
    const previous = dimensionsRef.current;
    setRegions((current) => current.map((region) => ({ ...region, box: scaleBox(region.box, previous.width, previous.height, w, h) })));
    dimensionsRef.current = { width: w, height: h };
    setWidth(w); setHeight(h); setDimensionWidth(String(w)); setDimensionHeight(String(h));
    setDimensionError(""); setError(""); setCopyState("idle");
  }

  function applyDimensions() {
    if (editorLocked) return;
    const w = Number(dimensionWidth), h = Number(dimensionHeight);
    if (![w, h].every((value) => Number.isInteger(value) && value >= 64 && value <= 4096 && value % 16 === 0)) { setDimensionError("宽高须为 64–4096 之间、16 的整数倍。"); return; }
    resizeCanvas(w, h);
  }

  function selectPreset(value: string) {
    const preset = RESOLUTION_PRESETS.flatMap((group) => group.sizes).find(([, w, h]) => `${w}x${h}` === value);
    if (preset && !editorLocked) resizeCanvas(preset[1], preset[2]);
  }

  async function importReference(file: File) {
    if (busyRef.current) return;
    exitDrawing();
    const request = ++imageRequest.current;
    imageBusyRef.current = true;
    setImageLoading(true); setImageError(""); setImageStatus("");
    referenceLoader.current ??= new LocalReferenceImageLoader();
    try {
      const next = await referenceLoader.current.load(file);
      if (!next || request !== imageRequest.current) return;
      resizeCanvas(next.width, next.height);
      setReference(next);
      setImageStatus(`底图已导入，画布 ${next.width} × ${next.height}；已有区域已按比例缩放。`);
    } catch (cause) {
      if (request === imageRequest.current) setImageError(cause instanceof Error ? cause.message : "图片导入失败，请重试。");
    } finally {
      if (request === imageRequest.current) { imageBusyRef.current = false; setImageLoading(false); }
    }
  }

  function removeReference() {
    ++imageRequest.current;
    referenceLoader.current?.clear();
    imageBusyRef.current = false;
    setReference(null); setImageLoading(false); setImageError(""); setImageStatus("底图已移除，画布尺寸与区域保持不变。");
  }

  function dragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (!loading) { dragDepth.current += 1; setDragOver(true); }
  }

  function dragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragOver(false);
  }

  function dropReference(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0; setDragOver(false);
    if (loading) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) { setImageError("每次请拖入一张本地图片。"); return; }
    void importReference(files[0]);
  }

  function storeResult(json: MossLayoutPrompt, kind: "raw" | "enhanced", signature: string) {
    setResult(JSON.stringify(json, null, 2));
    setResultKind(kind); setResultDraft(signature); setResultSize({ width, height }); setCopyState("idle");
  }

  function currentDraftError() {
    if (dimensionsPending) return "尺寸已修改，请先点击「应用尺寸」，同步缩放区域后再生成。";
    return getDraftError(draft);
  }

  function generate() {
    if (imageBusyRef.current) return;
    const message = currentDraftError();
    if (message) { setError(message); return; }
    setError("");
    try { storeResult(compileLayout(draft), "raw", currentSignature); }
    catch { setError("JSON 编译失败，请检查区域输入和坐标。"); }
  }

  async function enhance() {
    if (busyRef.current || imageBusyRef.current || !ready || saving) return;
    const message = currentDraftError();
    if (message) { setError(message); return; }
    exitDrawing();
    busyRef.current = true;
    setLoading(true); onBusyChange(true); setError(""); setCopyState("idle");
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      if (!connection) throw new Error("请先保存本浏览器的模型配置。");
      const data = await enhanceLayoutWithModel({ ...draft, mode, preferences }, connection, fetch, controller.signal);
      if (controller.signal.aborted || requestRef.current !== controller) return;
      // Geometry and literal text remain local; never accept model-created coordinates or items.
      let nextDraft: LayoutDraft;
      try { nextDraft = applyEnhancedLayout(draft, data.enhanced); }
      catch { throw new Error("增强结果的格式或区域标识不匹配，原有布局已保留。请重试。"); }
      const compiled = compileLayout(nextDraft);
      setSummary(nextDraft.summary); setRegions(nextDraft.regions);
      storeResult(compiled, "enhanced", JSON.stringify({ ...nextDraft, mode, preferences }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error && cause.message !== "Failed to fetch" ? cause.message : "连接中断，请检查网络后重试。原有布局与结果已保留。");
    } finally { busyRef.current = false; setLoading(false); onBusyChange(false); requestRef.current = null; }
  }

  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(JSON.stringify(JSON.parse(result))); setCopyState("copied"); }
    catch { outputRef.current?.focus(); outputRef.current?.select(); setCopyState("failed"); }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(JSON.parse(result))], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `moss-layout-${resultSize.width}x${resultSize.height}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="bbox-workbench" aria-label="Bbox 布局工作台" onKeyDownCapture={(event) => { if (event.key === "Escape" && tool === "draw") { event.preventDefault(); event.stopPropagation(); exitDrawing(); } }}>
    <section className="panel bbox-controls" aria-labelledby="layout-title">
      <div className="panel-heading"><div className="panel-title"><span className="step-number">01</span><h2 id="layout-title">画面与区域</h2></div><span className="panel-caption">{regions.length} / 24</span></div>
      <div className="bbox-controls-scroll">
        <fieldset disabled={editorLocked} className="bbox-fieldset">
          <div className="field"><div className="field-label-row"><label htmlFor="layout-summary">全局画面描述</label><span>必填</span></div><textarea id="layout-summary" value={summary} onChange={(event) => { setSummary(event.target.value); setError(""); }} maxLength={6000} className="bbox-summary" placeholder="整体场景、画风、光线…" /></div>
          <div className="bbox-mode" role="group" aria-label="布局画面类型">{(["写实", "二次元", "跨次元"] as Mode[]).map((item) => <button type="button" key={item} aria-pressed={mode === item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item}</button>)}</div>
          <details className="bbox-preferences"><summary>增强偏好 <span>选填</span></summary><textarea aria-label="布局增强偏好" value={preferences} onChange={(event) => setPreferences(event.target.value)} maxLength={2000} placeholder="例如：克制的设计感，保留人物年龄与服装。仅增强时使用。" /></details>
          <div className="bbox-section-label"><span>区域列表</span><button className="icon-button" type="button" onClick={startDrawing} disabled={regions.length >= 24} aria-label="添加区域"><Plus size={14} /></button></div>
          <div className="region-list" aria-label="选择区域">{regions.length ? regions.map((region, index) => <button key={region.id} type="button" aria-pressed={region.id === selectedId} onClick={() => { exitDrawing(); setSelectedId(region.id); }} className={`region-list-item ${region.id === selectedId ? "selected" : ""}`}><span className="region-dot" aria-hidden="true" style={{ background: regionColors[region.id] }} /><span className="region-number">{String(index + 1).padStart(2, "0")}</span><span className="region-list-title">{region.label === "text" ? region.text?.trim() || "待填写文字" : region.caption.trim() || `新的${LABELS[region.label]}区域`}</span><span className="region-type">{LABELS[region.label]}</span></button>) : <p className="regions-empty">点击「添加区域」，<br />再在画布中拖动画框。</p>}</div>
          {selected && <div className="region-editor">
            <div className="bbox-section-label"><span>区域 {String(selectedIndex + 1).padStart(2, "0")}</span><button type="button" className="icon-button delete-region" onClick={removeRegion} aria-label={`删除区域 ${selectedIndex + 1}`} title="删除选中区域"><Trash2 size={14} /></button></div>
            <label className="bbox-small-label" htmlFor="region-type">区域类型</label><select id="region-type" value={selected.label} onChange={(event) => updateRegion(selected.id, { label: event.target.value as LayoutRegion["label"], ...(event.target.value !== "text" ? { text: undefined } : {}) })}>{Object.entries(LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
            <label className="bbox-small-label" htmlFor="region-caption">{selected.label === "text" ? "文字外观 / 字体与颜色" : "区域提示词"} <span>必填</span></label><textarea id="region-caption" value={selected.caption} maxLength={2000} onChange={(event) => updateRegion(selected.id, { caption: event.target.value })} placeholder={selected.label === "text" ? "例如：深绿色粗体无衬线标题，居中排版。" : "描述这个区域里的主体、外观、动作或材质。"} />
            {selected.label === "text" && <><label className="bbox-small-label" htmlFor="region-text">画面中原样显示的文字 <span>必填</span></label><textarea id="region-text" value={selected.text ?? ""} onChange={(event) => updateRegion(selected.id, { text: event.target.value })} maxLength={4000} className="literal-text" placeholder={"COFFEE\n& SLOW DAYS"} spellCheck={false} /><p className="field-hint">文字、大小写、标点和换行均原样保留，不经过模型改写。</p></>}
            <div className="coordinate-fields">{([['x', 'X', selected.box[0]], ['y', 'Y', selected.box[1]], ['w', '宽', selected.box[2] - selected.box[0]], ['h', '高', selected.box[3] - selected.box[1]]] as const).map(([field, label, value]) => <label key={field}>{label}<input type="number" inputMode="numeric" value={value} min={field === "x" || field === "y" ? 0 : 1} max={field === "x" || field === "w" ? width : height} step={1} onChange={(event) => updateCoordinate(field, event.target.value)} aria-label={`区域${label}坐标或尺寸`} /></label>)}</div>
          </div>}
        </fieldset>
      </div>
    </section>

    <section className="panel bbox-canvas-panel" aria-labelledby="canvas-title">
      <div className="panel-heading canvas-heading">
        <div className="panel-title"><span className="step-number">02</span><h2 id="canvas-title">{tool === "draw" ? "开始画框" : "布局画布"}</h2></div>
        {tool === "draw" ? <div className="canvas-draw-hint" role="status"><Scan size={14} />拖动画出区域</div> : <div className="canvas-tools" role="group" aria-label="画布工具"><button type="button" className="active" aria-pressed={true} onClick={() => setTool("select")} disabled={editorLocked}><MousePointer2 size={14} />选择</button><button type="button" aria-pressed={false} onClick={startDrawing} disabled={editorLocked || regions.length >= 24}><Scan size={14} />画框</button></div>}
        <div className="canvas-reference-actions"><input ref={imageInputRef} type="file" accept={REFERENCE_IMAGE_ACCEPT} hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importReference(file); }} />{tool === "draw" ? <button type="button" className="copy-button" onClick={exitDrawing}><X size={13} />退出</button> : <><button type="button" className="icon-button" disabled={loading} onClick={() => imageInputRef.current?.click()} title={reference ? "替换底图（仅本地）" : "导入底图（或拖入画布，仅本地）"} aria-label={reference ? "替换底图" : "导入底图"}>{imageLoading ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}</button>{(reference || imageLoading) && <button type="button" className="icon-button" disabled={loading} onClick={removeReference} title="移除底图，保留尺寸和区域" aria-label="移除底图"><X size={14} /></button>}<button type="button" className="copy-button canvas-add-region" onClick={startDrawing} disabled={editorLocked || regions.length >= 24} aria-label="添加区域" title="添加区域"><Plus size={13} /><span>添加区域</span></button></>}</div>
      </div>
      <div className={`canvas-stage-wrap${dragOver ? " image-drag-over" : ""}`} onDragEnter={dragEnter} onDragLeave={dragLeave} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = loading ? "none" : "copy"; } }} onDrop={dropReference}><div className="canvas-stage" ref={stageRef}>
        <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" className={`layout-canvas tool-${tool}`} tabIndex={0} role="application" aria-label="区域布局画布。画框模式拖动创建；选择模式拖动移动，拖角点缩放。方向键移动，Shift 加速，Delete 删除。" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(event) => pointerEnd(event)} onPointerCancel={(event) => pointerEnd(event, true)} onLostPointerCapture={(event) => pointerEnd(event, true)} onKeyDown={canvasKeys}>
          <defs><pattern id="layout-grid" width={width / 16} height={height / 16} patternUnits="userSpaceOnUse"><path d={`M ${width / 16} 0 L 0 0 0 ${height / 16}`} fill="none" stroke="#e5e5e5" strokeWidth={0.6 / scale} /></pattern></defs>
          <rect width={width} height={height} fill="#ffffff" />
          {reference && <g pointerEvents="none" aria-hidden="true"><image href={reference.url} x={0} y={0} width={width} height={height} preserveAspectRatio="none" /><rect width={width} height={height} fill="#ffffff" fillOpacity={.38} /></g>}
          <rect width={width} height={height} fill="url(#layout-grid)" opacity={reference ? .3 : 1} /><rect x={.5 / scale} y={.5 / scale} width={width - 1 / scale} height={height - 1 / scale} fill="none" stroke="#cccccc" strokeWidth={1 / scale} />
          {regions.map((region, index) => { const [x1, y1, x2, y2] = region.box; const isSelected = region.id === selectedId; const color = regionColors[region.id]; return <g key={region.id} data-region={region.id} className={isSelected ? "canvas-region selected" : "canvas-region"}>
            <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill={color} fillOpacity={isSelected ? .14 : .07} stroke={color} strokeWidth={(isSelected ? 2.5 : 1.2) / scale} />
            <g pointerEvents="none"><rect x={x1} y={y1} width={Math.min(63 / scale, x2 - x1)} height={Math.min(22 / scale, y2 - y1)} fill={color} /><text x={x1 + 6 / scale} y={y1 + 15 / scale} fill="white" fontSize={10 / scale} fontFamily="inherit">{String(index + 1).padStart(2, "0")} · {LABELS[region.label]}</text></g>
          </g>; })}
          {selected && tool === "select" && !editorLocked && (['nw', 'ne', 'sw', 'se'] as Corner[]).map((corner) => <rect key={corner} data-region={selected.id} data-corner={corner} x={(corner.includes('w') ? selected.box[0] : selected.box[2]) - handleSize / 2} y={(corner.includes('n') ? selected.box[1] : selected.box[3]) - handleSize / 2} width={handleSize} height={handleSize} fill="white" stroke={regionColors[selected.id]} strokeWidth={2 / scale} style={{ cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' }} />)}
          {previewBox && <rect x={previewBox[0]} y={previewBox[1]} width={previewBox[2] - previewBox[0]} height={previewBox[3] - previewBox[1]} fill={previewColor} fillOpacity={.12} stroke={previewColor} strokeWidth={1.5 / scale} strokeDasharray={`${5 / scale} ${4 / scale}`} pointerEvents="none" />}
        </svg>
        {!regions.length && !previewBox && !reference && <div className="canvas-empty" aria-hidden="true"><Scan size={24} strokeWidth={1.2} /><span>{tool === "draw" ? "拖动画出区域" : "添加区域 · 或拖入图片"}</span></div>}
        {dragOver && <div className="canvas-drop-hint" aria-hidden="true"><ImagePlus size={22} /><span>松开以导入底图与尺寸</span></div>}
      </div></div>
      <div className="canvas-dimensions">
        <select className="canvas-preset" aria-label="画布分辨率预设" value={selectedPreset} onChange={(event) => selectPreset(event.target.value)} disabled={editorLocked} title="官方 1M / 1.5M / 2M 常用比例；选择即应用并缩放区域"><option value="" disabled>自定义</option>{RESOLUTION_PRESETS.map((group) => <optgroup key={group.group} label={group.group}>{group.sizes.map(([ratio, w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{ratio} · {w} × {h}</option>)}</optgroup>)}</select>
        <label>宽<input aria-label="画布宽度" type="number" min={64} max={4096} step={16} value={dimensionWidth} onChange={(event) => { setDimensionWidth(event.target.value); setDimensionError(""); setError(""); }} disabled={editorLocked} /></label><span>×</span><label>高<input aria-label="画布高度" type="number" min={64} max={4096} step={16} value={dimensionHeight} onChange={(event) => { setDimensionHeight(event.target.value); setDimensionError(""); setError(""); }} disabled={editorLocked} /></label><button type="button" className="copy-button" onClick={applyDimensions} disabled={editorLocked || !dimensionsPending} aria-label="应用尺寸并按比例缩放区域" title="应用尺寸，并按各轴比例缩放区域">应用</button>
        <TooltipProvider><Tooltip open={helpOpen} onOpenChange={setHelpOpen}><TooltipTrigger asChild><button type="button" className="icon-button canvas-help" aria-label="画布快捷键与尺寸说明" onClick={(event) => { event.preventDefault(); setHelpOpen(!helpOpen); }}><Keyboard size={14} /></button></TooltipTrigger><TooltipContent side="top" sideOffset={8} className="canvas-help-tooltip"><p>方向键微调 · Shift ×10 · Delete 删除</p><p>Escape 退出画框 / 取消拖动 · 拖角点调整大小</p><p>尺寸变化按各轴比例缩放区域；宽高为 16 的倍数。</p><p>拖入图片或点图片按钮：尺寸取最近的 16 倍数。</p><p>底图仅在浏览器内使用，不上传、不写入 JSON。</p></TooltipContent></Tooltip></TooltipProvider>
      </div>
      {dimensionError && <p className="dimension-error" role="alert">{dimensionError}</p>}
      {imageError && <p className="dimension-error" role="alert">{imageError}</p>}
      <span className="sr-only" role="status">{imageLoading ? "正在读取本地图片…" : imageStatus}</span>
    </section>

    <section className="panel bbox-output" aria-labelledby="layout-output-title" aria-busy={loading}>
      <div className="panel-heading"><div className="panel-title"><span className="step-number">03</span><h2 id="layout-output-title">MOSS JSON</h2></div><div className="json-export"><button type="button" className="icon-button" onClick={download} disabled={!result || loading || stale} title="下载 JSON" aria-label="下载 JSON"><Download size={15} /></button><button type="button" className="copy-button" onClick={() => void copy()} disabled={!result || loading || stale}>{copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}{copyState === "copied" ? "已复制" : "复制"}</button></div></div>
      {stale && <div className="json-stale" role="status">布局已修改，请重新生成 JSON 后再复制。</div>}
      <div className="bbox-json-content">{loading ? <div className="empty-state"><LoaderCircle className="spin" size={20} /><span>正在增强…</span><button type="button" className="clear-button" onClick={() => requestRef.current?.abort()}>停止等待，保留布局</button></div> : result ? <textarea ref={outputRef} className="bbox-json-text" value={result} readOnly spellCheck={false} aria-label="MOSS 布局 JSON 内容" /> : <div className="empty-state"><span>等待生成 JSON</span></div>}</div>
      <div className="bbox-generate-area">
        {error && <div className="error-message" role="alert"><CircleAlert size={14} /><p>{error}</p></div>}
        <button type="button" className="enhance-button" disabled={!ready || editorLocked || saving} onClick={() => void enhance()}>{loading ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{loading ? "正在增强布局…" : "增强并生成 JSON"}</button>
        <button type="button" className="raw-generate-button" disabled={editorLocked} onClick={generate}>直接生成 JSON <span>不调用模型</span></button>
        {!ready && <p className="field-hint">无需密钥也可直接生成；增强需先配置模型。</p>}
      </div>
      {resultNote && <div className="panel-footnote bbox-result-note" aria-live="polite">{resultNote}</div>}
    </section>
  </div>;
}
