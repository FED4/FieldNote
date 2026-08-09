"use client";

import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type Tag = { facet: string; path?: string[]; name: string; confidence: number; reason: string; status?: "suggested" | "confirmed"; source?: string };
type VitaResult = { summary: string; tags: Tag[] };

const defaultPrompt = `你是“工业现场多模态媒体整理助手”。

你的任务是分析现场照片、视频帧、对应语音说明、会议转写、工艺流程资料、原始目录和已有标签，为每个媒体文件推荐结构化信息。

核心原则：只有两个正式 Facet：1. 工段 2. 设备。其他信息全部作为 Context，不创建额外 Facet。

【工段】表示该媒体最可能属于哪个正式生产工段。优先使用项目工艺资料中的正式名称：原矿工段、选矿A工段、选矿B工段、脱水工段、环保废水处理工段。允许多个候选并按置信度排序；无法确认时不要猜测。

【设备】表示画面、语音或其他证据中能够确认的主要设备。优先使用标准名称：滚筒筛、贮矿斗、脱水筛、擦洗机、受阻沉降机、水力分级机、螺旋溜槽、永磁筒式磁选机、立环强磁磁选机、浮选机、调浆桶、真空过滤机、砂浆泵。一张媒体可以包含多个设备。只有证据充分时才输出具体名称，不要凭模糊外观猜测型号或编号。

【Context】除工段和设备外，尽量提取：process_context（流程位置和作用）、location_context（空间信息）、material_context（物料）、activity_context（正在发生什么）、state_context（可观察或明确听到的状态）、problem_context（有语音、会议或明显视觉证据的问题）、observation（1~3句画面描述）、discussion_context（讨论内容）。Context 不是标签，不要求固定词表。需要检测才能确认的问题写“待检测结果确认”，不要直接下结论。

【证据规则】来源包括 image、voice、transcript、process、folder、existing_tag。权重：明确视觉证据≈明确现场语音>正式工艺流程关系>会议上下文>原始目录。原始目录只是 Codex 初步结果，是弱证据；已有标签只规范命名，不能作为事实证据。尽量交叉验证，冲突时降低置信度并写入 conflicts。无法确认时宁可未知。

Facet 强调准确，Context 强调保留现场信息。不要为了 Facet 完整而猜测。

只返回合法 JSON，不输出 Markdown 或额外文字：
{
  "facets": {
    "工段": [{"tag":"选矿A工段","confidence":0.93,"reason":"现场语音与工艺流程一致","evidence":["voice","process"]}],
    "设备": [{"tag":"螺旋溜槽","confidence":0.96,"reason":"画面结构明显且语音明确提到","evidence":["image","voice","process"]}]
  },
  "context": {
    "observation":"", "process_context":"", "location_context":"", "material_context":"", "activity_context":"", "state_context":"", "problem_context":"", "discussion_context":""
  },
  "evidence_summary":"", "conflicts":[], "new_tag_suggestions":{"工段":[],"设备":[]}
}
如果某项 Context 没有证据，填写空字符串；某个 Facet 无法判断，填写空数组。`;

export default function LocalRecognitionPage() {
  const [workflowStep, setWorkflowStep] = useState<"setup" | "tagging">("setup");
  const [files, setFiles] = useState<File[]>([]);
  const [current, setCurrent] = useState<File | null>(null);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [voiceByAsset, setVoiceByAsset] = useState<Record<string, string>>({});
  const [result, setResult] = useState<VitaResult | null>(null);
  const [recommendationCache, setRecommendationCache] = useState<Record<string, VitaResult>>({});
  const [prefetchProgress, setPrefetchProgress] = useState({ done: 0, total: 0 });
  const prefetchingRef = useRef(new Set<string>());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  const [assignments, setAssignments] = useState<Record<string, Tag[]>>({});
  const [manualFacet, setManualFacet] = useState("设备");
  const [manualName, setManualName] = useState("");
  const [tagFilters, setTagFilters] = useState<Set<string>>(new Set());
  const [candidateTags, setCandidateTags] = useState<Tag[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const candidateGenerationStartedRef = useRef(false);
  const [activeFacetIndex, setActiveFacetIndex] = useState(0);
  const [facetChoice, setFacetChoice] = useState<Record<string, number>>({});
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
  const isMetaPrompt = prompt.includes("标签策略设计助手") || prompt.includes("帮助我编写一份高质量的 System Prompt");
  const filterGroups = useMemo(() => {
    const unique = new Map<string, Tag>(); Object.values(assignments).flat().forEach(tag => unique.set(tagToken(tag), tag));
    return groupTagValues(Array.from(unique.values()));
  }, [assignments]);
  const visibleFiles = tagFilters.size ? files.filter(file => { const tokens = new Set((assignments[fileKey(file)] || []).map(tagToken)); return Array.from(tagFilters).every(token => tokens.has(token)); }) : files;
  const keyboardGroups = useMemo(() => groupTagValues(mergeTags(candidateTags, result?.tags || [])), [candidateTags, result]);
  const activeKeyboardFacet = keyboardGroups[activeFacetIndex % Math.max(1, keyboardGroups.length)]?.facet;

  useEffect(() => { const version = localStorage.getItem("vita-system-prompt-version"); const saved = localStorage.getItem("vita-system-prompt"); if (version === "2" && saved) setPrompt(saved); else { setPrompt(defaultPrompt); localStorage.setItem("vita-system-prompt", defaultPrompt); localStorage.setItem("vita-system-prompt-version", "2"); } }, []);
  useEffect(() => { fetch("/api/local-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "get_catalog" }) }).then(response => response.json()).then(body => { if (!candidateGenerationStartedRef.current) setCandidateTags(ensureUncertain(cleanCandidateTags(body.tags || []))); }).finally(() => setCatalogLoaded(true)); }, []);
  useEffect(() => { if (!catalogLoaded) return; const timer = window.setTimeout(() => { fetch("/api/local-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_catalog", tags: candidateTags }) }).catch(() => undefined); }, 400); return () => window.clearTimeout(timer); }, [candidateTags, catalogLoaded]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null; if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && visibleFiles.length) {
        event.preventDefault(); const index = Math.max(0, current ? visibleFiles.indexOf(current) : 0); const next = Math.max(0, Math.min(visibleFiles.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))); setCurrent(visibleFiles[next]); setResult(null); return;
      }
      if (event.key === "Enter" && keyboardGroups.length) { event.preventDefault(); setActiveFacetIndex(index => (index + 1) % keyboardGroups.length); return; }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && keyboardGroups.length) {
        event.preventDefault(); const group = keyboardGroups[activeFacetIndex % keyboardGroups.length]; if (!group?.tags.length) return;
        const previous = facetChoice[group.facet] ?? -1; const direction = event.key === "ArrowRight" ? 1 : -1; const next = (previous + direction + group.tags.length) % group.tags.length;
        setFacetChoice(old => ({ ...old, [group.facet]: next })); chooseFacetTag(group.tags[next]);
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (!hydrated || !files.length) return;
    const timer = window.setTimeout(() => {
      const assets = files.flatMap(file => { const hash = hashByKey[fileKey(file)]; return hash ? [{ hash, filename: file.name, relativePath: fileKey(file), sourceContext: sourceFolders(file), size: file.size, mimeType: file.type, lastModified: file.lastModified, tags: (assignments[fileKey(file)] || []).filter(tag => tag.facet !== "原始目录") }] : []; });
      fetch("/api/local-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "upsert", assets }) }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [assignments, files, hashByKey, hydrated]);
  useEffect(() => {
    if (workflowStep !== "tagging" || !current) return;
    const cached = recommendationCache[fileKey(current)]; if (cached) { setResult(cached); setSelectedTags(defaultTagIndexes(cached.tags || [])); }
    const start = Math.max(0, files.indexOf(current)); const windowFiles = files.slice(start, start + 21).filter(file => file.type.startsWith("image/") && !recommendationCache[fileKey(file)] && !prefetchingRef.current.has(fileKey(file)));
    if (!windowFiles.length) return; setPrefetchProgress(progress => ({ done: progress.done, total: progress.total + windowFiles.length }));
    windowFiles.forEach(file => prefetchingRef.current.add(fileKey(file)));
    let cursor = 0; const worker = async () => { while (cursor < windowFiles.length) { const file = windowFiles[cursor++]; try { const dataUrl = await optimizedImageDataUrl(file); const response = await fetch("/api/vita/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaDataUrl: dataUrl, systemPrompt: prompt, voiceContext: voiceByAsset[fileKey(file)] || "", sourceContext: sourceFolders(file) }) }); const body = await response.json(); if (response.ok && body.result) { setRecommendationCache(old => ({ ...old, [fileKey(file)]: body.result })); if (file === current) { setResult(body.result); setSelectedTags(defaultTagIndexes(body.result.tags || [])); } } } catch { /* a failed item can be recognized on demand */ } finally { prefetchingRef.current.delete(fileKey(file)); setPrefetchProgress(progress => ({ ...progress, done: progress.done + 1 })); } } };
    void Promise.all([worker(), worker()]);
  }, [workflowStep, current, files, prompt, recommendationCache, voiceByAsset]);

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
      const restored: Record<string, Tag[]> = {}; for (const file of picked) restored[fileKey(file)] = (byHash[mapping[fileKey(file)]] || []).filter((tag: Tag) => tag.facet !== "原始目录").map((tag: Tag) => ({ ...tag, status: "confirmed" }));
      setAssignments(restored);
    } catch { setError("云端标签状态读取失败，本次仍可继续整理"); }
    finally { setHydrated(true); }
  };
  const recognize = async (includeMedia = true) => {
    if (includeMedia && !current) return;
    if (!includeMedia && !voiceContext.trim()) { setError("请先输入、录制或导入当前素材语音"); return; }
    setLoading(true); setError(""); setResult(null); localStorage.setItem("vita-system-prompt", prompt);
    try {
      const dataUrl = includeMedia && current ? current.type.startsWith("image/") ? await optimizedImageDataUrl(current) : await fileDataUrl(current) : undefined;
      const requestBody = JSON.stringify({ mediaDataUrl: dataUrl, systemPrompt: prompt, voiceContext, sourceContext: current ? sourceFolders(current) : [] });
      let response = await fetch("/api/vita/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody });
      let responseText = await response.text();
      if (response.status === 502 && responseText.trimStart().startsWith("<!DOCTYPE")) {
        await new Promise(resolve => window.setTimeout(resolve, 900));
        response = await fetch("/api/vita/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody }); responseText = await response.text();
      }
      let body: { error?: string; result?: VitaResult };
      try { body = JSON.parse(responseText); }
      catch { throw new Error(response.status === 413 ? "媒体文件过大，请使用压缩图片或“仅根据语音推荐”" : response.status === 502 ? "HTTPS 临时隧道连接失败，请稍后重试" : `识别服务返回异常响应（HTTP ${response.status}）`); }
      if (!response.ok) throw new Error(body.error || "识别失败");
      if (!body.result) throw new Error("识别结果为空");
      setResult(body.result); if (current) setRecommendationCache(old => ({ ...old, [fileKey(current)]: body.result! })); setSelectedTags(defaultTagIndexes(body.result.tags || []));
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
  const exportTagCsv = () => {
    if (!files.length) return;
    const rows = [["文件名", "相对路径", "SHA256", "已确认标签", "原始目录线索"]];
    for (const file of files) rows.push([file.name, fileKey(file), hashByKey[fileKey(file)] || "", (assignments[fileKey(file)] || []).filter(tag => tag.status === "confirmed" || !tag.status).map(tag => `${tag.facet}/${tagLabel(tag)}`).join("; "), sourceFolders(file).join(" > ")]);
    const csv = "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `FieldNote_文件名-标签_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const generateCandidates = async () => {
    setCandidateLoading(true); setError("");
    try { const response = await fetch("/api/vita/candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemPrompt: prompt }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "生成失败"); const generated = cleanCandidateTags(body.candidates || []); if (!generated.length) throw new Error("System Prompt 没有生成任何候选标签，请补充候选名称或规则"); setCandidateTags(old => { const manual = old.filter(tag => tag.reason === "人工候选"); return ensureUncertain(cleanCandidateTags([...generated, ...manual])); }); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "候选标签生成失败"); return false; } finally { setCandidateLoading(false); }
  };
  const useCandidate = (tag: Tag) => {
    setResult(old => { const tags = old?.tags || []; const existing = tags.findIndex(item => item.facet === tag.facet && item.name === tag.name); if (existing >= 0) { setSelectedTags(selected => new Set(selected).add(existing)); return old; } const index = tags.length; setSelectedTags(selected => new Set(selected).add(index)); return { summary: old?.summary || "人工选择候选标签", tags: [...tags, { ...tag, confidence: 1, reason: "从候选标签库人工选择" }] }; });
  };
  const chooseFacetTag = (tag: Tag) => {
    setResult(old => {
      const tags = old?.tags || []; let index = tags.findIndex(item => item.facet === tag.facet && item.name === tag.name); const nextTags = index >= 0 ? tags : [...tags, { ...tag, confidence: 1, reason: "快捷键从候选标签库选择" }]; if (index < 0) index = nextTags.length - 1;
      setSelectedTags(selected => { const next = new Set(Array.from(selected).filter(item => tags[item]?.facet !== tag.facet)); next.add(index); return next; });
      return { summary: old?.summary || "快捷键选择候选标签", tags: nextTags };
    });
  };
  const removeRecommended = (index: number) => { setResult(old => old ? { ...old, tags: old.tags.filter((_, i) => i !== index) } : old); setSelectedTags(old => new Set(Array.from(old).filter(i => i !== index).map(i => i > index ? i - 1 : i))); };

  const beginTagging = async () => {
    if (!files.length) { setError("请先选择包含图片或视频的文件夹"); return; }
    candidateGenerationStartedRef.current = true; localStorage.setItem("vita-system-prompt", prompt); setRecommendationCache({}); setPrefetchProgress({ done: 0, total: 0 }); if (await generateCandidates()) setWorkflowStep("tagging");
  };

  if (workflowStep === "setup") return <main style={{ minHeight: "100vh", overflow: "auto", background: "#f3f5f2", padding: 24 }}>
    <header style={{ maxWidth: 900, margin: "0 auto 18px", display: "flex", alignItems: "center", gap: 14 }}><Link href="/session/demo" style={{ color: "#287b57", textDecoration: "none" }}>← 返回工作台</Link><h2 style={{ margin: 0 }}>开始一次素材整理</h2></header>
    <section style={{ ...card, maxWidth: 900, margin: "auto", padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 18 }}><b style={{ ...stepBadge, background: "#287b57", color: "white" }}>1</b><strong>导入与标签规则</strong><span style={{ color: "#9aa29d", fontSize: 11 }}>下一步进入逐张标记</span></div>
      <h3 style={heading}>选择本地文件夹</h3><label style={{ ...folderButton, maxWidth: 280 }}>选择图片 / 视频文件夹<input type="file" accept="image/*,video/*" multiple {...({ webkitdirectory: "" } as object)} onChange={chooseFolder} style={{ display: "none" }} /></label>
      <p style={hint}>{files.length ? `已读取 ${files.length} 个素材 · SHA-256 ${hashProgress}/${files.length}${hydrated ? " · 历史标签已恢复" : ""}` : "支持包含多层子目录的图片和视频文件夹，原始文件不会上传。"}</p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 22 }}><h3 style={heading}>System Prompt</h3><button onClick={() => { setPrompt(defaultPrompt); localStorage.setItem("vita-system-prompt", defaultPrompt); }} style={{ ...smallButton, marginBottom: 8 }}>恢复默认标签规则</button></div>
      <textarea value={prompt} onChange={event => setPrompt(event.target.value)} style={{ width: "100%", minHeight: 230, resize: "vertical", border: "1px solid #dce2dd", borderRadius: 7, padding: 12, lineHeight: 1.7 }} />
      {isMetaPrompt && <div style={{ marginTop: 7, padding: 9, borderRadius: 6, background: "#fff4dd", color: "#8a641d", fontSize: 11 }}>当前是 Meta Prompt，不适合直接分类。建议点击“恢复默认标签规则”。</div>}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}><button onClick={() => void toggleMicrophone("overwrite", "system")} style={smallButton}>{microphoneRef.current?.target === "system" && recordingMode === "overwrite" ? "停止并覆写系统指令" : "语音覆写系统指令"}</button><button onClick={() => void toggleMicrophone("append", "system")} style={smallButton}>{microphoneRef.current?.target === "system" && recordingMode === "append" ? "停止并追加系统指令" : "语音追加系统指令"}</button></div>
      {error && <p style={{ color: "#b34242", fontSize: 12 }}>{error}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 22 }}><button disabled={!files.length || candidateLoading} onClick={() => void beginTagging()} style={{ ...folderButton, border: 0, minWidth: 220, opacity: !files.length || candidateLoading ? .5 : 1 }}>{candidateLoading ? "正在生成候选标签…" : "下一步：生成候选并开始标记"}</button></div>
    </section>
  </main>;

  return <main style={{ minHeight: "100vh", overflow: "auto", background: "#f3f5f2", padding: 24 }}>
    <header style={{ maxWidth: 1180, margin: "0 auto 18px", display: "flex", alignItems: "center", gap: 14 }}>
      <button onClick={() => setWorkflowStep("setup")} style={{ border: 0, background: "none", color: "#287b57" }}>← 修改导入设置</button><h2 style={{ margin: 0 }}>素材标记</h2><span style={{ color: "#849089", fontSize: 12, flex: 1 }}>标签自动同步 · 后台预识别 {prefetchProgress.done}/{prefetchProgress.total} · 云端 CSV 实时备份</span><a href="/api/local-assets" style={{ ...smallButton, textDecoration: "none" }}>下载云端备份</a><button disabled={!files.length} onClick={exportTagCsv} style={{ ...folderButton, border: 0, opacity: files.length ? 1 : .45 }}>导出当前 CSV</button>
    </header>
    <div style={{ maxWidth: 1180, margin: "0 auto 14px", background: "#fff", border: "1px solid #e0e5e1", borderRadius: 9, padding: "11px 16px", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, color: "#67726b", fontSize: 11 }}><b style={stepBadge}>1</b><span>选择文件夹</span><i>→</i><b style={stepBadge}>2</b><span>选择素材</span><i>→</i><b style={stepBadge}>3</b><span>推荐并确认标签</span><i>→</i><b style={stepBadge}>4</b><span>导出 CSV</span><span style={{ marginLeft: 14, color: "#88938c", fontSize: 9 }}>快捷键：↑↓ 素材 · ←→ 标签 · Enter 下一类型</span></div>
    <div style={{ maxWidth: 1180, margin: "auto", display: "grid", gridTemplateColumns: "270px minmax(360px,1fr) 350px", gap: 14 }}>
      <section style={card}>
        <h3 style={heading}>素材与标签筛选</h3>
        <p style={hint}>共 {files.length} 项，已选择 {selectedFiles.size} 项 · 哈希 {hashProgress}/{files.length}{hydrated ? " · 标签已同步" : ""}</p>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}><button style={smallButton} onClick={() => setSelectedFiles(new Set(files.map(fileKey)))}>全选</button><button style={smallButton} onClick={() => setSelectedFiles(new Set())}>清除选择</button></div>
        {filterGroups.length > 0 && <div style={{ borderTop: "1px solid #e7ebe8", borderBottom: "1px solid #e7ebe8", padding: "8px 0", marginBottom: 8 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 6 }}><b>按标签筛选</b>{tagFilters.size > 0 && <button style={{ border: 0, background: "none", color: "#287b57", fontSize: 9 }} onClick={() => setTagFilters(new Set())}>清除筛选</button>}</div>{filterGroups.map(group => <div key={group.facet} style={{ marginBottom: 6 }}><span style={{ display: "block", color: "#8a938d", fontSize: 8, marginBottom: 3 }}>{group.facet}</span><div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>{group.tags.map(tag => <button key={tagToken(tag)} title={`${tag.facet} / ${tagLabel(tag)}`} onClick={() => setTagFilters(old => toggleSet(old, tagToken(tag)))} style={{ ...tagChip, padding: "3px 5px", background: tagFilters.has(tagToken(tag)) ? "#2e805b" : "#edf7f1", color: tagFilters.has(tagToken(tag)) ? "white" : "#287653" }}>{tagLabel(tag)}</button>)}</div></div>)}</div>}
        <p style={{ ...hint, margin: "4px 0" }}>显示 {visibleFiles.length}/{files.length} 项</p><div style={{ maxHeight: 560, overflow: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>{visibleFiles.map((f, i) => { const key = fileKey(f); return <div key={`${key}-${i}`} onClick={() => { setCurrent(f); setResult(null); }} style={{ position: "relative", border: current === f ? "2px solid #2c855d" : "2px solid transparent", borderRadius: 7, overflow: "hidden", background: "#edf0ed", cursor: "pointer" }}><Thumbnail file={f} /><input aria-label="选择素材" type="checkbox" checked={selectedFiles.has(key)} onClick={e => e.stopPropagation()} onChange={() => setSelectedFiles(old => toggleSet(old, key))} style={{ position: "absolute", top: 6, left: 6 }} /><div style={{ minHeight: 28, display: "flex", gap: 3, flexWrap: "wrap", padding: 4 }}>{(assignments[key] || []).slice(0, 3).map((tag, n) => <span title={tag.facet} key={n} style={{ ...tagChip, padding: "2px 4px" }}>{tagLabel(tag)}</span>)}{(assignments[key] || []).length > 3 && <span style={{ fontSize: 8 }}>+{assignments[key].length - 3}</span>}</div></div> })}</div>
      </section>
      <section style={card}>
        <h3 style={heading}>第二步：查看当前素材</h3>
        <div style={{ height: 420, background: "#202421", display: "grid", placeItems: "center", borderRadius: 8, overflow: "hidden" }}>{preview && current?.type.startsWith("video/") ? <video key={preview} src={preview} controls autoPlay muted playsInline style={{ maxWidth: "100%", maxHeight: "100%" }} /> : preview ? <img src={preview} alt="本地预览" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : <span style={{ color: "#9ba39e" }}>请先选择文件夹</span>}</div>
        <p style={{ fontSize: 10, color: "#87918b" }}>{current ? `${current.type || "媒体"} · ${(current.size / 1024 / 1024).toFixed(1)} MB · ${hashByKey[fileKey(current)]?.slice(0, 12) || "计算哈希中"}` : "未选择媒体"}</p>
        {current && sourceFolders(current).length > 0 && <div style={{ marginBottom: 9, padding: 8, borderRadius: 6, background: "#f2f3f2", color: "#747d77", fontSize: 9 }}><b>原始目录线索（只读，可能不准确）</b><div style={{ marginTop: 4 }}>{sourceFolders(current).join(" › ")}</div></div>}
        {current && <div style={{ color: "#738078", fontSize: 9, marginBottom: 5 }}>已确认标签</div>}
        {current && <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>{(assignments[fileKey(current)] || []).map((tag, i) => <button title={`类型：${tag.facet}；点击移除`} key={`${tag.facet}-${tag.name}-${i}`} onClick={() => removeAssigned(fileKey(current), i, setAssignments)} style={tagChip}>{tag.facet} / {tagLabel(tag)} ×</button>)}</div>}
        <h3 style={{ ...heading, marginTop: 14 }}>Voice Context · 会议语音</h3>
        <textarea value={voiceContext} onChange={e => { if (current) setVoiceByAsset(old => ({ ...old, [fileKey(current)]: e.target.value })); }} placeholder="仅对当前图片有效，例如：这是二号流槽改造后的第一次试机……" style={{ width: "100%", minHeight: 105, resize: "vertical", border: "1px solid #dce2dd", borderRadius: 7, padding: 10, lineHeight: 1.6 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#89938d", fontSize: 9, margin: "5px 0 10px", flexWrap: "wrap" }}><span style={{ flex: "1 0 100%" }}>{voiceContext.length} 字 · 仅用于当前素材 · {asrLoading ? "腾讯云识别中…" : recordingMode || systemCapture ? "录音中，再次点击停止" : "等待输入"}</span><button onClick={() => void toggleMicrophone("overwrite", "voice")} style={{ ...smallButton, color: microphoneRef.current?.target === "voice" && recordingMode === "overwrite" ? "#b23838" : "#356b52" }}>{microphoneRef.current?.target === "voice" && recordingMode === "overwrite" ? "停止并覆写当前语音" : "语音覆写当前素材"}</button><button onClick={() => void toggleMicrophone("append", "voice")} style={{ ...smallButton, color: microphoneRef.current?.target === "voice" && recordingMode === "append" ? "#b23838" : "#356b52" }}>{microphoneRef.current?.target === "voice" && recordingMode === "append" ? "停止并追加当前语音" : "语音追加当前素材"}</button><button onClick={() => void toggleSystemAudio()} style={{ ...smallButton, color: systemCapture ? "#b23838" : "#356b52" }}>{systemCapture ? "停止捕获系统声音" : "捕获系统声音"}</button><label style={{ ...smallButton, cursor: asrLoading ? "wait" : "pointer", opacity: asrLoading ? .55 : 1 }}>导入语音文件<input disabled={asrLoading} type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm" style={{ display: "none" }} onChange={e => { const file = e.target.files?.[0]; if (file) void transcribeAudio(file, "append", "voice", current ? fileKey(current) : ""); e.target.value = ""; }} /></label><button onClick={() => { if (current) setVoiceByAsset(old => ({ ...old, [fileKey(current)]: "" })); }} style={{ border: 0, background: "none", color: "#557263", fontSize: 9 }}>清空</button></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}><button onClick={() => void recognize(true)} disabled={!current || loading} style={{ ...folderButton, border: 0, width: "100%", opacity: !current || loading ? .5 : 1 }}>{loading ? "VITA 识别中…" : current?.type.startsWith("video/") ? "识别视频 + 语音" : "识别图片 + 语音"}</button><button onClick={() => void recognize(false)} disabled={!voiceContext.trim() || loading} style={{ ...folderButton, background: "#fff", color: "#287b57", border: "1px solid #78ad91", width: "100%", opacity: !voiceContext.trim() || loading ? .5 : 1 }}>仅根据语音推荐</button></div>
        {error && <p style={{ color: "#b34242", fontSize: 12 }}>{error}</p>}
      </section>
      <section style={card}>
        <h3 style={heading}>第三步：点击确认推荐标签</h3>
        {!result && <p style={hint}>识别完成后，这里会显示画面摘要、Facet、标签、置信度和视觉依据。</p>}
        {result && <><div style={{ background: "#f4f7f4", borderRadius: 7, padding: 12, fontSize: 12, lineHeight: 1.7 }}>{result.summary}</div><div style={{ marginTop: 12 }}>{groupTags(result.tags).map(group => <div key={group.facet} style={{ marginBottom: 12 }}><div style={{ color: "#7d8881", fontSize: 10, marginBottom: 6 }}>{group.facet} <span style={{ color: "#adb4af" }}>· AI 推荐</span></div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{group.items.map(({ tag, index }) => <button key={index} title={`${Math.round((tag.confidence || 0) * 100)}% · ${tag.reason || "暂无解释"}\n双击可修改标签`} onClick={() => setSelectedTags(old => toggleSet(old, index))} onDoubleClick={() => editTagWithPrompt(index, tag, setResult)} style={{ ...capsule, ...(selectedTags.has(index) ? selectedCapsule : {}) }}>{selectedTags.has(index) && <span>✓ </span>}{tag.name}<span title="删除这项推荐" onClick={event => { event.stopPropagation(); removeRecommended(index); }} style={{ marginLeft: 7, color: "#a16c6c", fontWeight: 400 }}>×</span></button>)}</div></div>)}</div></>}
        <h3 style={{ ...heading, marginTop: 14 }}>候选标签库</h3>
        {candidateTags.length === 0 ? <p style={hint}>System Prompt 没有生成候选，可在下方手工新增。</p> : groupTagValues(candidateTags).map(group => <div key={group.facet} style={{ marginBottom: 9, padding: activeKeyboardFacet === group.facet ? 7 : 0, border: activeKeyboardFacet === group.facet ? "1px solid #8fbea3" : "1px solid transparent", borderRadius: 7, background: activeKeyboardFacet === group.facet ? "#f3faf5" : "transparent" }}><div style={{ color: activeKeyboardFacet === group.facet ? "#287b57" : "#7d8881", fontSize: 9, marginBottom: 4 }}>{group.facet}{activeKeyboardFacet === group.facet && " · 当前快捷键类型"}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{group.tags.map((tag, tagIndex) => <button key={tagToken(tag)} title={tag.name === "不确定" ? "证据不足时使用的保留候选" : "点击加入本次标签；右侧 × 从候选库删除"} onClick={() => { useCandidate(tag); setFacetChoice(old => ({ ...old, [group.facet]: tagIndex })); }} style={{ ...capsule, ...(facetChoice[group.facet] === tagIndex ? selectedCapsule : {}) }}>{tag.name}{tag.name !== "不确定" && <span onClick={event => { event.stopPropagation(); setCandidateTags(old => old.filter(item => tagToken(item) !== tagToken(tag))); }} style={{ marginLeft: 7, color: "#a16c6c" }}>×</span>}</button>)}</div></div>)}
        <h3 style={{ ...heading, marginTop: 14 }}>新增候选标签</h3><div style={{ display: "grid", gridTemplateColumns: "90px 1fr 58px", gap: 5 }}><input value={manualFacet} onChange={e => setManualFacet(e.target.value)} placeholder="类型" style={tagInput} /><input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="标签名称" style={tagInput} /><button style={smallButton} onClick={() => { if (!manualName.trim()) return; setCandidateTags(old => ensureUncertain(cleanCandidateTags([...old, { facet: manualFacet.trim() || "其他", name: manualName.trim(), confidence: 1, reason: "人工候选" }]))); setManualName(""); }}>加入候选</button></div>
        <button disabled={!result || !selectedTags.size || !(selectedFiles.size || current)} onClick={() => { const targets = selectedFiles.size ? selectedFiles : new Set(current ? [fileKey(current)] : []); const tags = (result?.tags || []).filter((_, i) => selectedTags.has(i)).map(tag => ({ ...tag, status: "confirmed" as const, source: tag.reason.includes("候选") ? "candidate" : "ai_confirmed" })); setAssignments(old => { const next = { ...old }; targets.forEach(key => { const existing = next[key] || []; next[key] = [...existing, ...tags.filter(t => !existing.some(x => x.facet === t.facet && x.name === t.name))]; }); return next; }); }} style={{ ...folderButton, border: 0, width: "100%", marginTop: 14, opacity: !result || !selectedTags.size ? .5 : 1 }}>确认并添加 {selectedTags.size} 个标签到 {selectedFiles.size || (current ? 1 : 0)} 个素材</button>
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
const stepBadge: React.CSSProperties = { width: 20, height: 20, borderRadius: "50%", background: "#e8f4ec", color: "#287b57", display: "inline-grid", placeItems: "center", fontSize: 10 };

function fileKey(file: File) { return file.webkitRelativePath || file.name; }
function csvCell(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function sourceFolders(file: File) { const parts = fileKey(file).split("/"); return parts.length > 1 ? parts.slice(1, -1) : []; }
function importedFolderTags(file: File): Tag[] { const folders = sourceFolders(file); return folders.map((name, index) => ({ facet: "原始目录", path: folders.slice(0, index), name, confidence: 0.5, reason: "来自导入文件夹层级；仅作为初步分类参考，尚未确认" })); }
function tagLabel(tag: Tag) { return [...(tag.path || []), tag.name].filter(Boolean).join(" › "); }
function tagToken(tag: Tag) { return `${tag.facet}\u0000${tagLabel(tag)}`; }
function mergeTags(current: Tag[], incoming: Tag[]) { const merged = new Map(current.map(tag => [tagToken(tag), tag])); incoming.forEach(tag => merged.set(tagToken(tag), tag)); return Array.from(merged.values()); }
function groupTagValues(tags: Tag[]) { const groups = new Map<string, Tag[]>(); tags.forEach(tag => groups.set(tag.facet || "其他", [...(groups.get(tag.facet || "其他") || []), tag])); return Array.from(groups, ([facet, values]) => ({ facet, tags: values.sort((a, b) => a.name === "不确定" ? -1 : b.name === "不确定" ? 1 : tagLabel(a).localeCompare(tagLabel(b), "zh-CN")) })); }
function ensureUncertain(tags: Tag[]) { const facets = Array.from(new Set(tags.map(tag => tag.facet || "其他"))); return mergeTags(facets.map(facet => ({ facet, name: "不确定", confidence: 1, reason: "证据不足时人工选择的保留候选" })), tags); }
function cleanCandidateTags(tags: Tag[]) {
  const cleaned = tags.map(tag => ({ ...tag, facet: String(tag.facet || "其他").trim(), name: String(tag.name || "").trim() })).filter(tag => tag.name);
  const unique = new Map<string, Tag>(); cleaned.forEach(tag => unique.set(tagToken(tag), tag)); return Array.from(unique.values());
}
async function sha256(file: File) { const bytes = await file.arrayBuffer(); const digest = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""); }
function fileDataUrl(file: Blob) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }); }
async function optimizedImageDataUrl(file: File) {
  try {
    const bitmap = await createImageBitmap(file); const max = 1600; const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片压缩失败")), "image/jpeg", .82));
    return fileDataUrl(blob);
  } catch { return fileDataUrl(file); }
}
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
