import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
const endpoint = "https://api.vita.cloud.tencent.com/v1/video2text/chat/completions";

export async function POST(request: NextRequest) {
  const { systemPrompt } = await request.json() as { systemPrompt?: string };
  const promptText = String(systemPrompt || "").slice(0, 15000);
  const promptCandidates = extractPromptCandidates(promptText);
  if (promptCandidates.length) return NextResponse.json({ candidates: promptCandidates });
  const key = process.env.TENCENT_VITA_API_KEY;
  if (!key) return NextResponse.json({ error: "服务器未读取到 VITA API Key" }, { status: 503 });
  const response = await fetch(endpoint, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "vita-video-3.0", messages: [{ role: "user", content: [{ type: "text", text: `根据下面的现场考察标签规则生成候选标签库。只有“工段”和“设备”两个 Facet，其他 Context 绝不能成为候选标签。标签必须是独立概念，不能用路径合并。设备若在规则中隶属于一个或多个工段，必须在 relatedSegments 中列出这些工段的准确名称；工段候选的 relatedSegments 为空。只返回合法 JSON：{"candidates":[{"facet":"工段|设备","name":"标签名称","relatedSegments":["关联工段"]}]}。不要遗漏规则中明确列出的候选。\n\n规则：\n${promptText}` }] }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null); const answer = body?.choices?.[0]?.message?.content;
  if (!response.ok || typeof answer !== "string") return NextResponse.json({ error: "候选标签生成失败" }, { status: 502 });
  try {
    const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 250).map((tag: { facet?: unknown; name?: unknown; relatedSegments?: unknown }) => ({ facet: String(tag.facet || "其他").slice(0, 80), name: String(tag.name || "").slice(0, 160), relatedSegments: Array.isArray(tag.relatedSegments) ? tag.relatedSegments.slice(0, 20).map(item => String(item).slice(0, 160)) : [], confidence: 1, reason: "候选标签库" })).filter((tag: { name: string }) => tag.name) : [];
    return NextResponse.json({ candidates });
  } catch { return NextResponse.json({ error: "VITA 返回的候选标签格式损坏，请重试" }, { status: 502 }); }
}

function extractPromptCandidates(prompt: string) {
  const relationSection = prompt.match(/【工段与设备候选关系】([\s\S]*?)(?=\n【|$)/)?.[1] || "";
  const rows = relationSection.split(/\r?\n/).map(line => line.match(/^\s*[-*]\s*([^：:\n]+)[：:]\s*(.+?)\s*$/)).filter((match): match is RegExpMatchArray => Boolean(match));
  if (!rows.length) return [];
  const segments = new Map<string, { facet: string; name: string; relatedSegments: string[]; confidence: number; reason: string }>();
  const equipment = new Map<string, { facet: string; name: string; relatedSegments: string[]; confidence: number; reason: string }>();
  for (const row of rows) {
    const segment = row[1].trim(); if (!segment) continue;
    segments.set(segment, { facet: "工段", name: segment, relatedSegments: [], confidence: 1, reason: "System Prompt 候选关系" });
    for (const rawName of row[2].split(/[、，,；;]/)) {
      const name = rawName.trim(); if (!name) continue; const previous = equipment.get(name);
      equipment.set(name, { facet: "设备", name, relatedSegments: Array.from(new Set([...(previous?.relatedSegments || []), segment])), confidence: 1, reason: "System Prompt 候选关系" });
    }
  }
  return [...Array.from(segments.values()), ...Array.from(equipment.values())];
}
