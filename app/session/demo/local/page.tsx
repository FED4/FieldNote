"use client";

import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useState } from "react";

type Tag = { facet: string; name: string; confidence: number; reason: string };
type VitaResult = { summary: string; tags: Tag[] };

const defaultPrompt = "你是现场考察媒体整理助手。分析图片中的地点、设备、对象、活动、状态、问题和材料。标签应简短、客观，无法从画面确认时不要猜测。优先输出对工程考察和后续检索有价值的标签。";

export default function LocalRecognitionPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [current, setCurrent] = useState<File | null>(null);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [voiceContext, setVoiceContext] = useState("");
  const [result, setResult] = useState<VitaResult | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  const [assignments, setAssignments] = useState<Record<string, Tag[]>>({});
  const [manualFacet, setManualFacet] = useState("设备");
  const [manualName, setManualName] = useState("");
  const [hashByKey, setHashByKey] = useState<Record<string, string>>({});
  const [hashProgress, setHashProgress] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const preview = useMemo(() => current ? URL.createObjectURL(current) : "", [current]);

  useEffect(() => { const saved = localStorage.getItem("vita-system-prompt"); if (saved) setPrompt(saved); const voice = localStorage.getItem("vita-voice-context"); if (voice) setVoiceContext(voice); }, []);
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
      const restored: Record<string, Tag[]> = {}; for (const file of picked) restored[fileKey(file)] = byHash[mapping[fileKey(file)]] || [];
      setAssignments(restored);
    } catch { setError("云端标签状态读取失败，本次仍可继续整理"); }
    finally { setHydrated(true); }
  };
  const recognize = async () => {
    if (!current) return;
    setLoading(true); setError(""); setResult(null); localStorage.setItem("vita-system-prompt", prompt); localStorage.setItem("vita-voice-context", voiceContext);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(current); });
      const response = await fetch("/api/vita/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageDataUrl: dataUrl, systemPrompt: prompt, voiceContext }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "识别失败");
      setResult(body.result); setSelectedTags(new Set((body.result.tags || []).map((_: Tag, i: number) => i)));
    } catch (e) { setError(e instanceof Error ? e.message : "识别失败"); }
    finally { setLoading(false); }
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
        <h3 style={{ ...heading, marginTop: 14 }}>Voice Context · 会议语音</h3>
        <textarea value={voiceContext} onChange={e => setVoiceContext(e.target.value)} placeholder="粘贴或输入最近的会议语音转写，例如：这是二号流槽改造后的第一次试机，重点看出口物料是否均匀……" style={{ width: "100%", minHeight: 105, resize: "vertical", border: "1px solid #dce2dd", borderRadius: 7, padding: 10, lineHeight: 1.6 }} />
        <div style={{ display: "flex", justifyContent: "space-between", color: "#89938d", fontSize: 9, margin: "5px 0 10px" }}><span>{voiceContext.length} 字 · 随图片一起用于标签推理</span><button onClick={() => setVoiceContext("")} style={{ border: 0, background: "none", color: "#557263", fontSize: 9 }}>清空</button></div>
        <button onClick={recognize} disabled={!current?.type.startsWith("image/") || loading} style={{ ...folderButton, border: 0, width: "100%", opacity: !current?.type.startsWith("image/") || loading ? .5 : 1 }}>{loading ? "VITA 正在识别…" : current?.type.startsWith("video/") ? "视频识别将在下一阶段接入" : "结合图片 + 语音推荐标签"}</button>
        {error && <p style={{ color: "#b34242", fontSize: 12 }}>{error}</p>}
      </section>
      <section style={card}>
        <h3 style={heading}>3. 推荐结果</h3>
        {!result && <p style={hint}>识别完成后，这里会显示画面摘要、Facet、标签、置信度和视觉依据。</p>}
        {result && <><div style={{ background: "#f4f7f4", borderRadius: 7, padding: 12, fontSize: 13, lineHeight: 1.7 }}>{result.summary}</div><div>{(result.tags || []).map((tag, i) => <div key={i} style={{ borderBottom: "1px solid #e8ebe8", padding: "10px 0" }}><div style={{ display: "grid", gridTemplateColumns: "18px 82px 1fr 34px", gap: 5, alignItems: "center" }}><input type="checkbox" checked={selectedTags.has(i)} onChange={() => setSelectedTags(old => toggleSet(old, i))} /><input aria-label="Facet" value={tag.facet} onChange={e => editResultTag(i, "facet", e.target.value, setResult)} style={tagInput} /><input aria-label="标签名称" value={tag.name} onChange={e => editResultTag(i, "name", e.target.value, setResult)} style={tagInput} /><span style={{ fontSize: 9 }}>{Math.round((tag.confidence || 0) * 100)}%</span></div><p style={{ margin: "5px 0 0 23px", color: "#778079", fontSize: 10 }}>{tag.reason}</p></div>)}</div></>}
        <h3 style={{ ...heading, marginTop: 14 }}>手工标签</h3><div style={{ display: "grid", gridTemplateColumns: "90px 1fr 42px", gap: 5 }}><input value={manualFacet} onChange={e => setManualFacet(e.target.value)} placeholder="Facet" style={tagInput} /><input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="标签名称" style={tagInput} /><button style={smallButton} onClick={() => { if (!manualName.trim()) return; setResult(old => ({ summary: old?.summary || "手工标签", tags: [...(old?.tags || []), { facet: manualFacet.trim() || "其他", name: manualName.trim(), confidence: 1, reason: "人工添加" }] })); setSelectedTags(old => new Set(old).add(result?.tags.length || 0)); setManualName(""); }}>新增</button></div>
        <button disabled={!result || !selectedTags.size || !(selectedFiles.size || current)} onClick={() => { const targets = selectedFiles.size ? selectedFiles : new Set(current ? [fileKey(current)] : []); const tags = (result?.tags || []).filter((_, i) => selectedTags.has(i)); setAssignments(old => { const next = { ...old }; targets.forEach(key => { const existing = next[key] || []; next[key] = [...existing, ...tags.filter(t => !existing.some(x => x.facet === t.facet && x.name === t.name))]; }); return next; }); }} style={{ ...folderButton, border: 0, width: "100%", marginTop: 14, opacity: !result || !selectedTags.size ? .5 : 1 }}>将 {selectedTags.size} 个标签应用到 {selectedFiles.size || (current ? 1 : 0)} 张图片</button>
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

function fileKey(file: File) { return file.webkitRelativePath || file.name; }
async function sha256(file: File) { const bytes = await file.arrayBuffer(); const digest = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""); }
function toggleSet<T>(old: Set<T>, value: T) { const next = new Set(old); next.has(value) ? next.delete(value) : next.add(value); return next; }
function editResultTag(index: number, field: "facet" | "name", value: string, setResult: React.Dispatch<React.SetStateAction<VitaResult | null>>) { setResult(old => old ? { ...old, tags: old.tags.map((tag, i) => i === index ? { ...tag, [field]: value } : tag) } : old); }
function removeAssigned(key: string, index: number, setAssignments: React.Dispatch<React.SetStateAction<Record<string, Tag[]>>>) { setAssignments(old => ({ ...old, [key]: (old[key] || []).filter((_, i) => i !== index) })); }

function Thumbnail({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return file.type.startsWith("video/") ? <video src={url} muted preload="metadata" style={{ width: "100%", height: 92, objectFit: "cover", display: "block" }} /> : <img src={url} alt="" loading="lazy" style={{ width: "100%", height: 92, objectFit: "cover", display: "block" }} />;
}
