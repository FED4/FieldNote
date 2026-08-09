import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const endpoint = "https://api.vita.cloud.tencent.com/v1/video2text/chat/completions";

export async function POST(request: NextRequest) {
  const key = process.env.TENCENT_VITA_API_KEY;
  if (!key) return NextResponse.json({ error: "服务器未读取到 TENCENT_VITA_API_KEY" }, { status: 503 });

  const { mediaDataUrl, imageDataUrl, systemPrompt, voiceContext, sourceContext } = await request.json() as { mediaDataUrl?: string; imageDataUrl?: string; systemPrompt?: string; voiceContext?: string; sourceContext?: string[] };
  const media = mediaDataUrl || imageDataUrl;
  const mediaKind = media?.startsWith("data:image/") ? "image" : media?.startsWith("data:video/") ? "video" : null;
  if (!mediaKind && !voiceContext?.trim()) return NextResponse.json({ error: "请选择图片/视频，或先输入当前素材语音" }, { status: 400 });
  if (media && media.length > 60_000_000) return NextResponse.json({ error: "媒体请求过大，请改用“仅根据语音推荐”或选择较短视频" }, { status: 413 });

  const transcriptContext = voiceContext?.trim() ? `\n\n最近的会议语音转写如下：\n---\n${voiceContext.trim().slice(0, 12000)}\n---\n请结合图片与语音；语音中无法被图片证实的信息可以保留，但要在 reason 中明确来源。` : "\n\n当前没有语音转写，只根据图片判断。";
  const importedContext = sourceContext?.length ? `\n\n该素材来自以下历史目录层级：${sourceContext.map(value => `[${String(value).slice(0, 300)}]`).join(" → ")}。这些名称是 Codex 的初步分类，可能不准确，只能作为弱提示。请结合图片与语音独立判断；不要仅因目录名出现就照抄或给出高置信度，并在 reason 中说明是否参考了目录。` : "";
  const mediaContext = mediaKind ? `\n\n本次提供了${mediaKind === "video" ? "视频" : "图片"}，可以引用其中实际可见的视觉证据。` : "\n\n本次没有提供任何图片或视频。禁止声称看到了画面、设备、压力表或其他视觉信息；所有 reason 只能引用语音和原始目录，并应对无法验证的信息降低置信度。";
  const formatInstruction = `\n\n请只返回合法 JSON，不要使用 Markdown、工具标记或注释：{"summary":"结合媒体与讨论的简述","tags":[{"facet":"厂房|工段|地点|设备|部件|活动|工艺|状态|对象|问题|材料|文档类型|人员|其他","path":["可选父级","可选子级"],"name":"叶子标签名称","confidence":0.0,"reason":"说明依据来自图片、视频、语音、原始目录或组合"}]}`;
  const content: Array<Record<string, unknown>> = [{ type: "text", text: `${systemPrompt || "识别现场考察媒体并推荐结构化标签。"}${importedContext}${mediaContext}${transcriptContext}${formatInstruction}` }];
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
    return NextResponse.json({ result: JSON.parse(cleaned), raw: answer });
  } catch {
    const repair = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "vita-video-3.0", messages: [{ role: "user", content: [{ type: "text", text: `下面是一个损坏的 JSON。只修复语法并返回合法 JSON，不要改变语义，不要输出 Markdown：\n${answer.slice(0, 20000)}` }] }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const repairedBody = await repair.json().catch(() => null); const repaired = repairedBody?.choices?.[0]?.message?.content;
    if (repair.ok && typeof repaired === "string") {
      try { return NextResponse.json({ result: JSON.parse(repaired.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")), repaired: true }); } catch { /* handled below */ }
    }
    return NextResponse.json({ error: "VITA 返回的标签 JSON 格式损坏，请重试识别" }, { status: 502 });
  }
}
