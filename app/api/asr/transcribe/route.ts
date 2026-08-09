import { NextRequest, NextResponse } from "next/server";
import { asr } from "tencentcloud-sdk-nodejs-asr";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";
const run = promisify(execFile);

export async function POST(request: NextRequest) {
  const secretId = process.env.TENCENT_CLOUD_SECRET_ID;
  const secretKey = process.env.TENCENT_CLOUD_SECRET_KEY;
  if (!secretId || !secretKey) return NextResponse.json({ error: "服务器未读取到腾讯云 ASR 凭证" }, { status: 503 });
  const form = await request.formData();
  const audio = form.get("audio");
  if (!audio || typeof audio === "string" || typeof audio.arrayBuffer !== "function") return NextResponse.json({ error: "请选择音频文件" }, { status: 400 });
  if (audio.size > 12_000_000) return NextResponse.json({ error: "原始音频请控制在 12MB 内、时长 60 秒内" }, { status: 413 });

  const dir = await mkdtemp(path.join(tmpdir(), "fieldnote-asr-"));
  try {
    const input = path.join(dir, "input-audio");
    const output = path.join(dir, "audio.pcm");
    await writeFile(input, Buffer.from(await audio.arrayBuffer()));
    await run("/usr/bin/ffmpeg", ["-v", "error", "-y", "-i", input, "-t", "60", "-ac", "1", "-ar", "16000", "-f", "s16le", output], { timeout: 70_000 });
    const pcm = await readFile(output);
    if (pcm.length > 2_200_000) return NextResponse.json({ error: "转换后的音频超过一句话识别限制，请缩短录音" }, { status: 413 });
    const Client = asr.v20190614.Client;
    const client = new Client({ credential: { secretId, secretKey }, region: process.env.TENCENT_ASR_REGION || "ap-guangzhou", profile: { httpProfile: { reqTimeout: 90 } } });
    const response = await client.SentenceRecognition({ EngSerViceType: process.env.TENCENT_ASR_ENGINE_MODEL_TYPE || "16k_zh", SourceType: 1, VoiceFormat: "pcm", Data: pcm.toString("base64"), DataLen: pcm.length, WordInfo: 0, FilterPunc: 0, ConvertNumMode: 1 });
    return NextResponse.json({ transcript: response.Result || "", durationMs: response.AudioDuration, requestId: response.RequestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "语音识别失败";
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
