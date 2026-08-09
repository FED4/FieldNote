"use client";

import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type Tag = { facet: string; name: string; confidence: number; reason: string };
type VitaResult = { summary: string; tags: Tag[] };

const defaultPrompt = "你是现场考察媒体整理助手。分析图片中的地点、设备、对象、活动、状态、问题和材料。标签应简短、客观，无法从画面确认时不要猜测。优先输出对工程考察和后续检索有价值的标签。";

export default function LocalRecognitionPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [current, setCurrent] = useState<File | null>(null);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [voiceByAsset, setVoiceByAsset] = useState<Record<string, string>>({});
  const [result, setResult] = useState<VitaResult | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  const [assignments, setAssignments] = useState<Record<string, Tag[]>>({});
  const [manualFacet, setManualFacet] = useState("设备");
  const [manualName, setManualName] = useState("");
  const [hashByKey, setHashByKey] = useState<Record<string, string>>({});
  const [hashProgress, setHashProgress] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [asrLoading, setAsrLoading] = useState(false);
  const [recordingMode, setRecordingMode] = useState<"overwrite" | "append" | null>(null);
  const microphoneRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; mode: "overwrite" | "append"; targetKey: string; target: "voice" | "system" } | null>(null);
  const [systemCapture, setSystemCapture] = useState(false);
  const systemRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; targetKey: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const preview = useMemo(() => current ? URL.createObjectURL(current) : "", [current]);
  const voiceContext = current ? voiceByAsset[fileKey(current)] || "" : "";

  useEffect(() => { const saved = localStorage.getItem("vita-system-prompt"); if (saved) setPrompt(saved); }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (!hydrated || !files.length) return;
    const timer = window.setTimeout(() => {
      const assets = files.flatMap(file => { const hash = hashByKey[fileKey(file)]; return hash ? [{ hash, filename: file.name, size: file.size, mimeType: file.type, lastModified: file.lastModified, tags: assignments[fileKey(file)] || [] }] : []; });
      fetch("/api/local-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "upsert", assets }) }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [assignments, files, hashByKey, hydrated]);

  const chooseFolder = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []).filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"));
    setFiles(picked); setCurrent(picked[0] || null); setSelectedFiles(new Set(picked[0] ? [fileKey(picked[0])] : [])); setAssignments({}); setHashByKey({}); setHydrated(false); setHashProgress(0); setResult(null); setError("");
    void hashAndRestore(picked);
  };
  const hashAndRestore = async (picked: File[]) => {
    const mapping: Record<string, string> = {};
    for (let i = 0; i < picked.length; i++) { mapping[fileKey(picked[i])] = await sha256(picked[i]); setHashProgress(i + 1); }
    setHashByKey(mapping);
    try {
      const response = await fetch("/api/local-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve", hashes: Object.values(mapping) }) });
      const body = await response.json(); const byHash = Object.fromEntries((body.assets || []).map((state: { hash: string; tags: Tag[] }) => [state.hash, state.tags]));
      const restored: Record<string, Tag[]> = {}; for (const file of picked) { const saved = byHash[mapping[fileKey(file)]] || []; const imported = importedFolderTags(file); restored[fileKey(file)] = [...saved, ...imported.filter(tag => !saved.some((item: Tag) => item.facet === tag.facet && item.name === tag.name))]; }
      setAssignments(restored);
    } catch { setError("云端标签状态读取失败，本次仍可继续整理"); }
    finally { setHydrated(true); }
  };
  const recognize = async () => {
    if (!current) return;
    setLoading(true); setError(""); setResult(null); localStorage.setItem("vita-system-prompt", prompt);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(current); });
      const response = await fetch("/api/vita/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageDataUrl: dataUrl, systemPrompt: prompt, voiceContext, sourceContext: sourceFolders(current) }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "识别失败");
      setResult(body.result); setSelectedTags(defaultTagIndexes(body.result.tags || []));
    } catch (e) { setError(e instanceof Error ? e.message : "识别失败"); }
    finally { setLoading(false); }
  };
  const transcribeAudio = async (audio: Blob, mode: "overwrite" | "append" = "append", target: "voice" | "system" = "voice", targetKey = current ? fileKey(current) : "") => {
    setAsrLoading(true); setError("");
    try {
      const form = new FormData(); form.append("audio", audio, audio instanceof File ? audio.name : "recording.webm");
      const response = await fetch("/api/asr/transcribe", { method: "POST", body: form }); const body = await response.json();
      if (!response.ok) throw new Error(body.error || "语音识别失败");
      if (target === "system") setPrompt(old => mode === "overwrite" ? body.transcript : [old.trim(), body.transcript].filter(Boolean).join("\n"));
      else if (targetKey) setVoiceByAsset(old => ({ ...old, [targetKey]: mode === "overwrite" ? body.transcript : [old[targetKey]?.trim(), body.transcript].filter(Boolean).join("\n") }));
    } catch (e) { setError(e instanceof Error ? e.message : "语音识别失败"); }
    finally { setAsrLoading(false); }
  };
  const toggleMicrophone = async (mode: "overwrite" | "append", target: "voice" | "system" = "voice") => {
    const active = microphoneRef.current;
    if (active) { active.recorder.stop(); return; }
    setError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError("麦克风录音需要 HTTPS；配置域名证书后即可使用。当前仍可导入语音文件。"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const chunks: Blob[] = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const targetKey = current ? fileKey(current) : "";
      recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); microphoneRef.current = null; setRecordingMode(null); if (chunks.length) void transcribeAudio(new Blob(chunks, { type: mimeType }), mode, target, targetKey); };
      microphoneRef.current = { recorder, stream, chunks, mode, targetKey, target }; recorder.start(); setRecordingMode(mode);
    } catch (e) { setError(e instanceof Error ? e.message : "无法打开麦克风"); }
  };
  const toggleSystemAudio = async () => {
    const active = systemRef.current;
    if (active) { active.recorder.stop(); return; }
    setError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) { setError("系统声音捕获需要 HTTPS。配置域名证书后，在 Chrome/Edge 共享窗口时勾选“共享系统音频”；共享画面不会被保存或上传。"); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach(track => track.stop()); throw new Error("没有音轨，请重新共享并勾选“共享系统音频”"); }
      const chunks: Blob[] = []; const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const targetKey = current ? fileKey(current) : "";
      recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); systemRef.current = null; setSystemCapture(false); if (chunks.length) void transcribeAudio(new Blob(chunks, { type: mimeType }), "append", "voice", targetKey); };
      stream.getVideoTracks()[0]?.addEventListener("ended", () => recorder.state !== "inactive" && recorder.stop());
      systemRef.current = { recorder, stream, chunks, targetKey }; recorder.start(); setSystemCapture(true);
    } catch (e) { setError(e instanceof Error ? e.message : "无法捕获系统声音"); }
  };

  return <main style={{ minHeight: "100vh", overflow: "auto", background: "#f3f5f2", padding: 24 }}>
    <header style={{ maxWidth: 1180, margin: "0 auto 18px", display: "flex", alignItems: "center", gap: 14 }}>
      <Link href="/session/demo" style={{ color: "#287b57", textDecoration: "none" }}>← 返回工作台</Link><h2 style={{ margin: 0 }}>本地图片识别实验</h2><span style={{ color: "#849089", fontSize: 12 }}>本地文件不保存到服务器；识别图片会发送给腾讯云 VITA</span>
    </header>
    <div style={{ maxWidth: 1180, margin: "auto", display: "grid", gridTemplateColumns: "270px minmax(360px,1fr) 350px", gap: 14 }}>
      <section style={card}>
        <h3 style={heading}>1. 关联本地文件夹</h3>
        <label style={folderButton}>选择图片 / 视频文件夹<input type="file" accept="image/*,video/*" multiple {...({ webkitdirectory: "" } as object)} onChange={chooseFolder} style={{ display: "none" }} /></label>
        <p style={hint}>共 {files.length} 项，已选择 {selectedFiles.size} 项 · 哈希 {hashProgress}/{files.length}{hydrated ? " · 标签已同步" : ""}</p>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}><button style={smallButton} onClick={() => setSelectedFiles(new Set(files.map(fileKey)))}>全选</button><button style={smallButton} onClick={() => setSelectedFiles(new Set())}>清除选择</button></div>
        <div style={{ maxHeight: 560, overflow: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>{files.map((f, i) => { const key = fileKey(f); return <div key={`${key}-${i}`} onClick={() => { setCurrent(f); setResult(null); }} style={{ position: "relative", border: current === f ? "2px solid #2c855d" : "2px solid transparent", borderRadius: 7, overflow: "hidden", background: "#edf0ed", cursor: "pointer" }}><Thumbnail file={f} /><input aria-label="选择素材" type="checkbox" checked={selectedFiles.has(key)} onClick={e => e.stopPropagation()} onChange={() => setSelectedFiles(old => toggleSet(old, key))} style={{ position: "absolute", top: 6, left: 6 }} /><div style={{ minHeight: 28, display: "flex", gap: 3, flexWrap: "wrap", padding: 4 }}>{(assignments[key] || []).slice(0, 3).map((tag, n) => <span key={n} style={{ ...tagChip, padding: "2px 4px" }}>{tag.name}</span>)}{(assignments[key] || []).length > 3 && <span style={{ fontSize: 8 }}>+{assignments[key].length - 3}</span>}</div></div> })}</div>
      </section>
      <section style={card}>
        <h3 style={heading}>2. 当前图片</h3>
        <div style={{ height: 420, background: "#202421", display: "grid", placeItems: "center", borderRadius: 8, overflow: "hidden" }}>{preview && current?.type.startsWith("video/") ? <video src={preview} controls style={{ maxWidth: "100%", maxHeight: "100%" }} /> : preview ? <img src={preview} alt="本地预览" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : <span style={{ color: "#9ba39e" }}>请先选择文件夹</span>}</div>
        <p style={{ fontSize: 10, color: "#87918b" }}>{current ? `${current.type || "媒体"} · ${(current.size / 1024 / 1024).toFixed(1)} MB · ${hashByKey[fileKey(current)]?.slice(0, 12) || "计算哈希中"}` : "未选择媒体"}</p>
        {current && <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>{(assignments[fileKey(current)] || []).map((tag, i) => <button title="点击移除" key={`${tag.facet}-${tag.name}-${i}`} onClick={() => removeAssigned(fileKey(current), i, setAssignments)} style={tagChip}>{tag.facet} / {tag.name} ×</button>)}</div>}
        <h3 style={heading}>System Prompt</h3>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} style={{ width: "100%", minHeight: 120, resize: "vertical", border: "1px solid #dce2dd", borderRadius: 7, padding: 10, lineHeight: 1.6 }} />
        <div style={{ display: "flex", gap: 6, marginTop: 5 }}><button onClick={() => void toggleMicrophone("overwrite", "system")} style={{ ...smallButton, color: microphoneRef.current?.target === "system" && recordingMode === "overwrite" ? "#b23838" : "#356b52" }}>{microphoneRef.current?.target === "system" && recordingMode === "overwrite" ? "■ 停止并覆写" : "🎙 覆写系统指令"}</button><button onClick={() => void toggleMicrophone("append", "system")} style={{ ...smallButton, color: microphoneRef.current?.target === "system" && recordingMode === "append" ? "#b23838" : "#356b52" }}>{microphoneRef.current?.target === "system" && recordingMode === "append" ? "■ 停止并追加" : "🎙＋追加系统指令"}</button></div>
        <h3 style={{ ...heading, marginTop: 14 }}>Voice Context · 会议语音</h3>
        <textarea value={voiceContext} onChange={e => { if (current) setVoiceByAsset(old => ({ ...old, [fileKey(current)]: e.target.value })); }} placeholder="仅对当前图片有效，例如：这是二号流槽改造后的第一次试机……" style={{ width: "100%", minHeight: 105, resize: "vertical", border: "1px solid #dce2dd", borderRadius: 7, padding: 10, lineHeight: 1.6 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#89938d", fontSize: 9, margin: "5px 0 10px", flexWrap: "wrap" }}><span style={{ flex: "1 0 100%" }}>{voiceContext.length} 字 · 仅用于当前素材 · {asrLoading ? "腾讯云识别中…" : recordingMode || systemCapture ? "录音中，再次点击停止" : "等待输入"}</span><button onClick={() => void toggleMicrophone("overwrite", "voice")} style={{ ...smallButton, color: microphoneRef.current?.target === "voice" && recordingMode === "overwrite" ? "#b23838" : "#356b52" }}>{microphoneRef.current?.target === "voice" && recordingMode === "overwrite" ? "■ 停止并覆写" : "🎙 覆写"}</button><button onClick={() => void toggleMicrophone("append", "voice")} style={{ ...smallButton, color: microphoneRef.current?.target === "voice" && recordingMode === "append" ? "#b23838" : "#356b52" }}>{microphoneRef.current?.target === "voice" && recordingMode === "append" ? "■ 停止并追加" : "🎙＋追加"}</button><button onClick={() => void toggleSystemAudio()} style={{ ...smallButton, color: systemCapture ? "#b23838" : "#356b52" }}>{systemCapture ? "■ 停止系统声音" : "▣ 系统声音"}</button><label style={{ ...smallButton, cursor: asrLoading ? "wait" : "pointer", opacity: asrLoading ? .55 : 1 }}>＋ 导入语音<input disabled={asrLoading} type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm" style={{ display: "none" }} onChange={e => { const file = e.target.files?.[0]; if (file) void transcribeAudio(file, "append", "voice", current ? fileKey(current) : ""); e.target.value = ""; }} /></label><button onClick={() => { if (current) setVoiceByAsset(old => ({ ...old, [fileKey(current)]: "" })); }} style={{ border: 0, background: "none", color: "#557263", fontSize: 9 }}>清空</button></div>
        <button onClick={recognize} disabled={!current?.type.startsWith("image/") || loading} style={{ ...folderButton, border: 0, width: "100%", opacity: !current?.type.startsWith("image/") || loading ? .5 : 1 }}>{loading ? "VITA 正在识别…" : current?.type.startsWith("video/") ? "视频识别将在下一阶段接入" : "结合图片 + 语音推荐标签"}</button>
        {error && <p style={{ color: "#b34242", fontSize: 12 }}>{error}</p>}
      </section>
      <section style={card}>
        <h3 style={heading}>3. 推荐结果</h3>
        {!result && <p style={hint}>识别完成后，这里会显示画面摘要、Facet、标签、置信度和视觉依据。</p>}
        {result && <><div style={{ background: "#f4f7f4", borderRadius: 7, padding: 12, fontSize: 12, lineHeight: 1.7 }}>{result.summary}</div><div style={{ marginTop: 12 }}>{groupTags(result.tags).map(group => <div key={group.facet} style={{ marginBottom: 12 }}><div style={{ color: "#7d8881", fontSize: 10, marginBottom: 6 }}>{group.facet}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{group.items.map(({ tag, index }) => <button key={index} title={`${Math.round((tag.confidence || 0) * 100)}% · ${tag.reason || "暂无解释"}\n双击可修改标签`} onClick={() => setSelectedTags(old => toggleSet(old, index))} onDoubleClick={() => editTagWithPrompt(index, tag, setResult)} style={{ ...capsule, ...(selectedTags.has(index) ? selectedCapsule : {}) }}>{selectedTags.has(index) && <span>✓ </span>}{tag.name}</button>)}</div></div>)}</div></>}
        <h3 style={{ ...heading, marginTop: 14 }}>手工标签</h3><div style={{ display: "grid", gridTemplateColumns: "90px 1fr 42px", gap: 5 }}><input value={manualFacet} onChange={e => setManualFacet(e.target.value)} placeholder="Facet" style={tagInput} /><input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="标签名称" style={tagInput} /><button style={smallButton} onClick={() => { if (!manualName.trim()) return; setResult(old => ({ summary: old?.summary || "手工标签", tags: [...(old?.tags || []), { facet: manualFacet.trim() || "其他", name: manualName.trim(), confidence: 1, reason: "人工添加" }] })); setSelectedTags(old => new Set(old).add(result?.tags.length || 0)); setManualName(""); }}>新增</button></div>
        <button disabled={!result || !selectedTags.size || !(selectedFiles.size || current)} onClick={() => { const targets = selectedFiles.size ? selectedFiles : new Set(current ? [fileKey(current)] : []); const tags = (result?.tags || []).filter((_, i) => selectedTags.has(i)); setAssignments(old => { const next = { ...old }; targets.forEach(key => { const existing = next[key] || []; next[key] = [...existing, ...tags.filter(t => !existing.some(x => x.facet === t.facet && x.name === t.name))]; }); return next; }); }} style={{ ...folderButton, border: 0, width: "100%", marginTop: 14, opacity: !result || !selectedTags.size ? .5 : 1 }}>＋ 添加 {selectedTags.size} 个标签到 {selectedFiles.size || (current ? 1 : 0)} 个素材</button>
      </section>
    </div>
  </main>;
}

const card: React.CSSProperties = { background: "white", border: "1px solid #e0e5e1", borderRadius: 10, padding: 16, boxShadow: "0 5px 20px #1e35250a" };
const heading: React.CSSProperties = { fontSize: 13, margin: "0 0 12px" };
const hint: React.CSSProperties = { color: "#8a948e", fontSize: 11, lineHeight: 1.6 };
const folderButton: React.CSSProperties = { display: "block", textAlign: "center", background: "#287b57", color: "white", borderRadius: 7, padding: "10px 12px", cursor: "pointer", fontSize: 12 };
const fileButton: React.CSSProperties = { width: "100%", border: 0, borderRadius: 5, padding: "8px", textAlign: "left", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const smallButton: React.CSSProperties = { border: "1px solid #d9e0db", background: "white", color: "#3f6954", borderRadius: 5, padding: "5px 8px", fontSize: 10 };
const tagInput: React.CSSProperties = { minWidth: 0, width: "100%", border: "1px solid #dce2dd", borderRadius: 5, padding: "6px", fontSize: 10 };
const tagChip: React.CSSProperties = { border: "1px solid #cce4d5", background: "#edf7f1", color: "#287653", borderRadius: 5, padding: "5px 7px", fontSize: 9 };
const capsule: React.CSSProperties = { border: "1px solid #d9e0dc", background: "#fff", color: "#536059", borderRadius: 16, padding: "6px 10px", fontSize: 10 };
const selectedCapsule: React.CSSProperties = { borderColor: "#75b392", background: "#e9f5ed", color: "#24734e", fontWeight: 600 };

function fileKey(file: File) { return file.webkitRelativePath || file.name; }
function sourceFolders(file: File) { const parts = fileKey(file).split("/"); return parts.length > 1 ? parts.slice(1, -1) : []; }
function importedFolderTags(file: File): Tag[] { return sourceFolders(file).map(name => ({ facet: "原始目录", name, confidence: 0.5, reason: "来自导入文件夹层级；仅作为初步分类参考，尚未确认" })); }
async function sha256(file: File) { const bytes = await file.arrayBuffer(); const digest = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""); }
function toggleSet<T>(old: Set<T>, value: T) { const next = new Set(old); next.has(value) ? next.delete(value) : next.add(value); return next; }
function editResultTag(index: number, field: "facet" | "name", value: string, setResult: React.Dispatch<React.SetStateAction<VitaResult | null>>) { setResult(old => old ? { ...old, tags: old.tags.map((tag, i) => i === index ? { ...tag, [field]: value } : tag) } : old); }
function removeAssigned(key: string, index: number, setAssignments: React.Dispatch<React.SetStateAction<Record<string, Tag[]>>>) { setAssignments(old => ({ ...old, [key]: (old[key] || []).filter((_, i) => i !== index) })); }

function Thumbnail({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return file.type.startsWith("video/") ? <video src={url} muted preload="metadata" style={{ width: "100%", height: 92, objectFit: "cover", display: "block" }} /> : <img src={url} alt="" loading="lazy" style={{ width: "100%", height: 92, objectFit: "cover", display: "block" }} />;
}

function groupTags(tags: Tag[]) {
  const groups = new Map<string, { tag: Tag; index: number }[]>();
  tags.forEach((tag, index) => groups.set(tag.facet || "其他", [...(groups.get(tag.facet || "其他") || []), { tag, index }]));
  return Array.from(groups, ([facet, items]) => ({ facet, items: items.sort((a, b) => (b.tag.confidence || 0) - (a.tag.confidence || 0)) }));
}
function defaultTagIndexes(tags: Tag[]) {
  const best = new Map<string, { index: number; confidence: number }>();
  tags.forEach((tag, index) => { const current = best.get(tag.facet); if (!current || (tag.confidence || 0) > current.confidence) best.set(tag.facet, { index, confidence: tag.confidence || 0 }); });
  return new Set(Array.from(best.values(), value => value.index));
}
function editTagWithPrompt(index: number, tag: Tag, setResult: React.Dispatch<React.SetStateAction<VitaResult | null>>) {
  const name = window.prompt(`修改「${tag.facet}」标签`, tag.name)?.trim();
  if (name) editResultTag(index, "name", name, setResult);
}
