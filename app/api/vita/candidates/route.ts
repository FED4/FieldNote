import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
const endpoint = "https://api.vita.cloud.tencent.com/v1/video2text/chat/completions";

export async function POST(request: NextRequest) {
  const key = process.env.TENCENT_VITA_API_KEY;
  if (!key) return NextResponse.json({ error: "服务器未读取到 VITA API Key" }, { status: 503 });
  const { systemPrompt } = await request.json() as { systemPrompt?: string };
  const response = await fetch(endpoint, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "vita-video-3.0", messages: [{ role: "user", content: [{ type: "text", text: `根据下面的现场考察标签规则生成候选标签库。只有“工段”和“设备”两个 Facet，其他 Context 绝不能成为候选标签。标签必须是独立概念，不能用路径合并。只返回合法 JSON：{"candidates":[{"facet":"工段|设备","name":"标签名称"}]}。每个 Facet 最多 30 项。\n\n规则：\n${String(systemPrompt || "").slice(0, 15000)}` }] }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null); const answer = body?.choices?.[0]?.message?.content;
  if (!response.ok || typeof answer !== "string") return NextResponse.json({ error: "候选标签生成失败" }, { status: 502 });
  try {
    const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 150).map((tag: { facet?: unknown; name?: unknown }) => ({ facet: String(tag.facet || "其他").slice(0, 80), name: String(tag.name || "").slice(0, 160), confidence: 1, reason: "候选标签库" })).filter((tag: { name: string }) => tag.name) : [];
    return NextResponse.json({ candidates });
  } catch { return NextResponse.json({ error: "VITA 返回的候选标签格式损坏，请重试" }, { status: 502 }); }
}
