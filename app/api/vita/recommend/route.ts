import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const endpoint = "https://api.vita.cloud.tencent.com/v1/video2text/chat/completions";

export async function POST(request: NextRequest) {
  const key = process.env.TENCENT_VITA_API_KEY;
  if (!key) return NextResponse.json({ error: "服务器未读取到 TENCENT_VITA_API_KEY" }, { status: 503 });

  const { imageDataUrl, systemPrompt, voiceContext, sourceContext } = await request.json() as { imageDataUrl?: string; systemPrompt?: string; voiceContext?: string; sourceContext?: string[] };
  if (!imageDataUrl?.startsWith("data:image/")) return NextResponse.json({ error: "请选择有效图片" }, { status: 400 });
  if (imageDataUrl.length > 20_000_000) return NextResponse.json({ error: "图片过大，请选择小于约 14MB 的图片" }, { status: 413 });

  const transcriptContext = voiceContext?.trim() ? `\n\n最近的会议语音转写如下：\n---\n${voiceContext.trim().slice(0, 12000)}\n---\n请结合图片与语音；语音中无法被图片证实的信息可以保留，但要在 reason 中明确来源。` : "\n\n当前没有语音转写，只根据图片判断。";
  const importedContext = sourceContext?.length ? `\n\n该素材来自以下历史目录层级：${sourceContext.map(value => `[${String(value).slice(0, 300)}]`).join(" → ")}。这些名称是 Codex 的初步分类，可能不准确，只能作为弱提示。请结合图片与语音独立判断；不要仅因目录名出现就照抄或给出高置信度，并在 reason 中说明是否参考了目录。` : "";
  const formatInstruction = `\n\n请只返回 JSON，不要使用 Markdown：{"summary":"结合画面与讨论的简述","tags":[{"facet":"设备|地点|活动|状态|对象|问题|材料|其他","name":"标签名称","confidence":0.0,"reason":"说明依据来自图片、语音或两者"}]}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "vita-video-3.0",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `${systemPrompt || "识别现场考察图片并推荐结构化标签。"}${importedContext}${transcriptContext}${formatInstruction}` },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) return NextResponse.json({ error: body?.message || body?.error?.message || `VITA 请求失败 (${response.status})` }, { status: 502 });
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return NextResponse.json({ error: "VITA 返回内容为空" }, { status: 502 });
  try {
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return NextResponse.json({ result: JSON.parse(cleaned), raw: content });
  } catch {
    return NextResponse.json({ result: { summary: content, tags: [] }, raw: content });
  }
}
