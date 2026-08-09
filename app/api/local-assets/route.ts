import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

type Tag = { facet: string; path?: string[]; relatedSegments?: string[]; name: string; confidence: number; reason: string; status?: "suggested" | "confirmed"; source?: string };
type AssetState = { hash: string; filename: string; relativePath?: string; sourceContext?: string[]; size: number; mimeType: string; lastModified: number; tags: Tag[]; updatedAt: string };
type Store = { version: 1; assets: Record<string, AssetState>; tagCatalog?: Tag[] };
const dataDir = process.env.FIELDNOTE_DATA_DIR || "/data/fieldnote-prototype";
const storePath = path.join(dataDir, "local-asset-state.json");
const csvBackupPath = path.join(dataDir, "FieldNote-live-backup.csv");
let writeQueue = Promise.resolve();

async function loadStore(): Promise<Store> {
  try { return JSON.parse(await readFile(storePath, "utf8")) as Store; }
  catch { return { version: 1, assets: {} }; }
}

export async function GET() {
  try { return new NextResponse(await readFile(csvBackupPath), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=FieldNote-live-backup.csv" } }); }
  catch { return NextResponse.json({ error: "云端 CSV 备份尚未生成" }, { status: 404 }); }
}

export async function POST(request: NextRequest) {
  const body = await request.json() as { action?: string; hashes?: string[]; assets?: AssetState[] };
  if (body.action === "resolve") {
    const store = await loadStore();
    const states = (body.hashes || []).filter(validHash).flatMap(hash => store.assets[hash] ? [store.assets[hash]] : []);
    return NextResponse.json({ assets: states });
  }
  if (body.action === "get_catalog") {
    const store = await loadStore();
    return NextResponse.json({ tags: store.tagCatalog || [] });
  }
  if (body.action === "save_catalog") {
    const tags = sanitizeTags((body as { tags?: Tag[] }).tags);
    writeQueue = writeQueue.then(async () => {
      const store = await loadStore(); store.tagCatalog = tags;
      await mkdir(dataDir, { recursive: true }); const temp = `${storePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 }); await rename(temp, storePath);
    });
    await writeQueue; return NextResponse.json({ saved: tags.length });
  }
  if (body.action === "upsert") {
    const incoming = (body.assets || []).filter(asset => validHash(asset.hash)).slice(0, 5000);
    writeQueue = writeQueue.then(async () => {
      const store = await loadStore();
      for (const asset of incoming) store.assets[asset.hash] = { ...asset, tags: sanitizeTags(asset.tags), updatedAt: new Date().toISOString() };
      await mkdir(dataDir, { recursive: true });
      const temp = `${storePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
      await rename(temp, storePath);
      await writeCsvBackup(store);
    });
    await writeQueue;
    return NextResponse.json({ saved: incoming.length });
  }
  return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
}

function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function sanitizeTags(tags: unknown): Tag[] {
  if (!Array.isArray(tags)) return [];
  return tags.slice(0, 300).map(tag => ({ facet: String(tag?.facet || "其他").slice(0, 80), path: Array.isArray(tag?.path) ? tag.path.slice(0, 8).map((item: unknown) => String(item).slice(0, 120)) : [], relatedSegments: Array.isArray(tag?.relatedSegments) ? tag.relatedSegments.slice(0, 20).map((item: unknown) => String(item).slice(0, 160)) : [], name: String(tag?.name || "").slice(0, 160), confidence: Number(tag?.confidence || 0), reason: String(tag?.reason || "").slice(0, 500), status: tag?.status === "suggested" ? "suggested" as const : "confirmed" as const, source: String(tag?.source || "manual").slice(0, 40) })).filter(tag => tag.name && tag.facet !== "原始目录");
}
async function writeCsvBackup(store: Store) {
  const rows = [["文件名", "相对路径", "SHA256", "已确认标签", "原始目录线索", "更新时间"]];
  for (const asset of Object.values(store.assets)) rows.push([asset.filename, asset.relativePath || asset.filename, asset.hash, asset.tags.filter(tag => tag.status === "confirmed" || !tag.status).map(tag => `${tag.facet}/${[...(tag.path || []), tag.name].join(" > ")}`).join("; "), (asset.sourceContext || []).join(" > "), asset.updatedAt]);
  const csv = "\uFEFF" + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const temp = `${csvBackupPath}.${process.pid}.tmp`; await writeFile(temp, csv, { mode: 0o600 }); await rename(temp, csvBackupPath);
}
