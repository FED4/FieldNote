import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

type Tag = { facet: string; name: string; confidence: number; reason: string };
type AssetState = { hash: string; filename: string; size: number; mimeType: string; lastModified: number; tags: Tag[]; updatedAt: string };
type Store = { version: 1; assets: Record<string, AssetState> };
const dataDir = process.env.FIELDNOTE_DATA_DIR || "/data/fieldnote-prototype";
const storePath = path.join(dataDir, "local-asset-state.json");
let writeQueue = Promise.resolve();

async function loadStore(): Promise<Store> {
  try { return JSON.parse(await readFile(storePath, "utf8")) as Store; }
  catch { return { version: 1, assets: {} }; }
}

export async function POST(request: NextRequest) {
  const body = await request.json() as { action?: string; hashes?: string[]; assets?: AssetState[] };
  if (body.action === "resolve") {
    const store = await loadStore();
    const states = (body.hashes || []).filter(validHash).flatMap(hash => store.assets[hash] ? [store.assets[hash]] : []);
    return NextResponse.json({ assets: states });
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
    });
    await writeQueue;
    return NextResponse.json({ saved: incoming.length });
  }
  return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
}

function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function sanitizeTags(tags: unknown): Tag[] {
  if (!Array.isArray(tags)) return [];
  return tags.slice(0, 200).map(tag => ({ facet: String(tag?.facet || "其他").slice(0, 80), name: String(tag?.name || "").slice(0, 160), confidence: Number(tag?.confidence || 0), reason: String(tag?.reason || "").slice(0, 500) })).filter(tag => tag.name);
}
