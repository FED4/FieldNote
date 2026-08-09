import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const endpoint = "https://api.vita.cloud.tencent.com/v1/video2text/chat/completions";

export async function POST(request: NextRequest) {
  const key = process.env.TENCENT_VITA_API_KEY;
  if (!key) return NextResponse.json({ error: "服务器未读取到 TENCENT_VITA_API_KEY" }, { status: 503 });

  const { mediaDataUrl, imageDataUrl, systemPrompt, voiceContext, sourceContext, candidateTags } = await request.json() as { mediaDataUrl?: string; imageDataUrl?: string; systemPrompt?: string; voiceContext?: string; sourceContext?: string[]; candidateTags?: Array<{ facet?: string; name?: string; relatedSegments?: string[] }> };
  const media = mediaDataUrl || imageDataUrl;
  const mediaKind = media?.startsWith("data:image/") ? "image" : media?.startsWith("data:video/") ? "video" : null;
  if (!mediaKind && !voiceContext?.trim()) return NextResponse.json({ error: "请选择图片/视频，或先输入当前素材语音" }, { status: 400 });
  if (media && media.length > 60_000_000) return NextResponse.json({ error: "媒体请求过大，请改用“仅根据语音推荐”或选择较短视频" }, { status: 413 });

  const transcriptContext = voiceContext?.trim() ? `\n\n最近的会议语音转写如下：\n---\n${voiceContext.trim().slice(0, 12000)}\n---\n请结合图片与语音；语音中无法被图片证实的信息可以保留，但要在 reason 中明确来源。` : "\n\n当前没有语音转写，只根据图片判断。";
  const importedContext = sourceContext?.length ? `\n\n该素材来自以下历史目录层级：${sourceContext.map(value => `[${String(value).slice(0, 300)}]`).join(" → ")}。这些名称是 Codex 的初步分类，可能不准确，只能作为弱提示。请结合图片与语音独立判断；不要仅因目录名出现就照抄或给出高置信度，并在 reason 中说明是否参考了目录。` : "";
  const mediaContext = mediaKind ? `\n\n本次提供了${mediaKind === "video" ? "视频" : "图片"}，可以引用其中实际可见的视觉证据。` : "\n\n本次没有提供任何图片或视频。禁止声称看到了画面、设备、压力表或其他视觉信息；所有 reason 只能引用语音和原始目录，并应对无法验证的信息降低置信度。";
  const promptIsMeta = systemPrompt?.includes("标签策略设计助手") || systemPrompt?.includes("帮助我编写一份高质量的 System Prompt");
  const effectivePrompt = promptIsMeta ? "你是现场考察媒体标签助手。直接分析输入并推荐可检索的独立标签，不要编写或讨论 Prompt。" : systemPrompt || "识别现场考察媒体并推荐结构化标签。";
  const catalog = Array.isArray(candidateTags) ? candidateTags.slice(0, 300).map(tag => ({ facet: String(tag.facet || ""), name: String(tag.name || ""), relatedSegments: Array.isArray(tag.relatedSegments) ? tag.relatedSegments : [] })).filter(tag => tag.name && tag.name !== "不确定") : [];
  const catalogInstruction = catalog.length ? `\n\n当前候选标签库如下：\n${JSON.stringify(catalog)}\n优先从候选库中按准确名称匹配。先判断工段，再利用 relatedSegments 缩小设备候选；关系只是推理线索，必须结合视觉、语音等证据。如果没有合适候选，可以按 System Prompt 输出新标签建议。` : "";
  const formatInstruction = `\n\n严格遵守 System Prompt 中的 JSON Schema。只有“工段”和“设备”是正式 Facet；其他信息只能进入 context，禁止创建其他 Facet。每个 tag 只能表达一个概念，禁止输出跨 Facet 路径。只返回合法 JSON。`;
  const content: Array<Record<string, unknown>> = [{ type: "text", text: `${effectivePrompt}${catalogInstruction}${importedContext}${mediaContext}${transcriptContext}${formatInstruction}` }];
  if (mediaKind === "image") content.push({ type: "image_url", image_url: { url: media } });
  if (mediaKind === "video") content.push({ type: "video_url", video_url: { url: media } });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "vita-video-3.0",
      messages: [{
        role: "user",
        content,
      }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) return NextResponse.json({ error: body?.message || body?.error?.message || `VITA 请求失败 (${response.status})` }, { status: 502 });
  const answer = body?.choices?.[0]?.message?.content;
  if (typeof answer !== "string") return NextResponse.json({ error: "VITA 返回内容为空" }, { status: 502 });
  try {
    const cleaned = answer.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return NextResponse.json({ result: normalizeResult(JSON.parse(cleaned)), raw: answer });
  } catch {
    const repair = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "vita-video-3.0", messages: [{ role: "user", content: [{ type: "text", text: `下面是一个损坏的 JSON。只修复语法并返回合法 JSON，不要改变语义，不要输出 Markdown：\n${answer.slice(0, 20000)}` }] }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const repairedBody = await repair.json().catch(() => null); const repaired = repairedBody?.choices?.[0]?.message?.content;
    if (repair.ok && typeof repaired === "string") {
      try { return NextResponse.json({ result: normalizeResult(JSON.parse(repaired.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))), repaired: true }); } catch { /* handled below */ }
    }
    return NextResponse.json({ error: "VITA 返回的标签 JSON 格式损坏，请重试识别" }, { status: 502 });
  }
}

function normalizeResult(value: any) {
  if (Array.isArray(value?.tags) && value.tags.every((tag: any) => tag?.facet && tag?.name)) return value;
  const tags: Array<{ facet: string; name: string; confidence: number; reason: string; evidence?: string[] }> = [];
  for (const facet of ["工段", "设备"]) for (const item of Array.isArray(value?.facets?.[facet]) ? value.facets[facet] : []) if (item?.tag) tags.push({ facet, name: String(item.tag), confidence: Number(item.confidence || 0), reason: String(item.reason || ""), evidence: Array.isArray(item.evidence) ? item.evidence : [] });
  for (const group of Array.isArray(value?.tags) ? value.tags : []) for (const item of Array.isArray(group?.facets) ? group.facets : []) if (["工段", "设备"].includes(item?.id) && item?.name) tags.push({ facet: item.id, name: String(item.name), confidence: Number(item.confidence || .5), reason: "模型未按指定 Schema 返回，已兼容转换" });
  const context = value?.context && typeof value.context === "object" ? value.context : {};
  const summary = [context.observation, context.process_context, context.activity_context, context.state_context, context.problem_context, context.discussion_context, value?.evidence_summary].filter(Boolean).join("\n") || "未提取到有证据支持的 Context。";
  return { summary, tags, context, evidence_summary: value?.evidence_summary || "", conflicts: Array.isArray(value?.conflicts) ? value.conflicts : [], new_tag_suggestions: value?.new_tag_suggestions || { 工段: [], 设备: [] } };
}
