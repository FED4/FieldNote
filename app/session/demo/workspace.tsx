"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";

type Asset = { id: number; time: string; hue: number; title: string };
type Point = { x: number; y: number };

const assets: Asset[] = Array.from({ length: 200 }, (_, i) => {
  const minutes = 18 + Math.floor(i / 4);
  return {
    id: i + 1,
    time: `10:${String(minutes).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}`,
    hue: (168 + i * 9) % 360,
    title: `IMG_${String(2301 + i).padStart(4, "0")}.JPG`,
  };
});

const facets = [
  { name: "地点", icon: "⌖", children: ["二号车间", "原料堆场"] },
  { name: "项目", icon: "◇", children: ["高纯石英考察"] },
  { name: "设备", icon: "⚙", children: ["电选机", "二号流槽"] },
  { name: "活动", icon: "↗", children: ["试机", "采样"] },
  { name: "状态", icon: "◉", children: ["改造后", "异常"] },
];

function MockPhoto({ asset, large = false }: { asset: Asset; large?: boolean }) {
  return (
    <div className={`mock-photo ${large ? "large" : ""}`} style={{ "--hue": asset.hue } as React.CSSProperties}>
      <div className="machine"><span /><span /><i /></div>
      <div className="photo-grain" />
    </div>
  );
}

export default function Workspace() {
  const [selected, setSelected] = useState<Set<number>>(() => new Set([37, 38, 39, 40, 41, 42]));
  const [activeId, setActiveId] = useState(40);
  const [anchor, setAnchor] = useState(40);
  const [appliedTags, setAppliedTags] = useState<string[]>(["二号车间", "电选机"]);
  const [summary, setSummary] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["设备", "活动"]));
  const parentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ mode: "paint" | "box"; start: Point; value: boolean; base: Set<number> } | null>(null);
  const [marquee, setMarquee] = useState<{ start: Point; end: Point } | null>(null);
  const columns = 3;
  const rows = Math.ceil(assets.length / columns);
  const virtualizer = useVirtualizer({ count: rows, getScrollElement: () => parentRef.current, estimateSize: () => 116, overscan: 4 });
  const active = assets[activeId - 1];

  const selectOne = useCallback((id: number, shift: boolean, toggle: boolean) => {
    setSelected(old => {
      if (shift) {
        const next = toggle ? new Set(old) : new Set<number>();
        const [a, b] = [Math.min(anchor, id), Math.max(anchor, id)];
        for (let n = a; n <= b; n++) next.add(n);
        return next;
      }
      if (toggle) {
        const next = new Set(old);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }
      return new Set([id]);
    });
    if (!shift) setAnchor(id);
    setActiveId(id);
  }, [anchor]);

  const gridPoint = (e: React.PointerEvent): Point => {
    const rect = gridRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-asset-id]");
    const point = gridPoint(e);
    gridRef.current?.setPointerCapture(e.pointerId);
    if (card) {
      const id = Number(card.dataset.assetId);
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        selectOne(id, e.shiftKey, e.metaKey || e.ctrlKey);
        gesture.current = null;
      } else {
        const value = !selected.has(id);
        gesture.current = { mode: "paint", start: point, value, base: new Set(selected) };
        setSelected(old => { const n = new Set(old); value ? n.add(id) : n.delete(id); return n; });
        setActiveId(id); setAnchor(id);
      }
    } else {
      gesture.current = { mode: "box", start: point, value: true, base: (e.metaKey || e.ctrlKey) ? new Set(selected) : new Set() };
      setMarquee({ start: point, end: point });
    }
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const point = gridPoint(e);
    if (g.mode === "paint") {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-asset-id]");
      if (el) {
        const id = Number(el.dataset.assetId);
        setSelected(old => { const n = new Set(old); g.value ? n.add(id) : n.delete(id); return n; });
        setActiveId(id);
      }
    } else {
      setMarquee({ start: g.start, end: point });
      const x1 = Math.min(g.start.x, point.x), x2 = Math.max(g.start.x, point.x);
      const y1 = Math.min(g.start.y, point.y), y2 = Math.max(g.start.y, point.y);
      const root = gridRef.current!.getBoundingClientRect();
      const next = new Set(g.base);
      gridRef.current!.querySelectorAll<HTMLElement>("[data-asset-id]").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right - root.left >= x1 && r.left - root.left <= x2 && r.bottom - root.top >= y1 && r.top - root.top <= y2) next.add(Number(el.dataset.assetId));
      });
      setSelected(next);
    }
  };

  const endGesture = () => { gesture.current = null; setMarquee(null); };
  const applyTag = (tag: string) => {
    if (!selected.size) return;
    setAppliedTags(old => old.includes(tag) ? old : [...old, tag]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(new Set());
      if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) setSummary(true);
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setActiveId(id => Math.max(1, Math.min(assets.length, id + (e.key === "ArrowRight" ? 1 : -1))));
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);

  const boxStyle = marquee ? {
    left: Math.min(marquee.start.x, marquee.end.x), top: Math.min(marquee.start.y, marquee.end.y),
    width: Math.abs(marquee.end.x - marquee.start.x), height: Math.abs(marquee.end.y - marquee.start.y),
  } : undefined;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">F</div><div className="session-heading"><b>XX矿现场考察</b><span>高纯石英 · 2026.08.09</span></div>
        <div className="top-spacer" /><div className="presence"><i /><span>4 人在线</span><div className="avatars"><b>陈</b><b>林</b><b>周</b><b>+1</b></div></div>
        <button className="ghost-btn">主持人：陈工⌄</button><label className="follow"><span className="switch on"><i /></span>跟随主持人</label>
        <button className="ghost-btn audio"><i /> 音频已连接</button><Link className="primary-btn" style={{ textDecoration: "none" }} href="/session/demo/local">关联本地文件夹</Link>
      </header>

      <section className="workspace">
        <aside className="left-panel">
          <div className="panel-title"><b>知识面板</b><button>•••</button></div>
          <div className="tabs"><button className="active">标签</button><button>讨论</button></div>
          <div className="search">⌕ <input placeholder="搜索标签..." /><kbd>⌘K</kbd></div>
          <div className="selection-banner"><span><b>{selected.size}</b> 个素材已选择</span><button onClick={() => setSelected(new Set())}>清除</button></div>
          <div className="tree">
            <div className="tree-label"><span>标签树</span><button>＋</button></div>
            {facets.map(f => <div className="facet" key={f.name}>
              <button className="facet-head" onClick={() => setExpanded(old => { const n = new Set(old); n.has(f.name) ? n.delete(f.name) : n.add(f.name); return n; })}>
                <span className="chev">{expanded.has(f.name) ? "⌄" : "›"}</span><i>{f.icon}</i><b>{f.name}</b><em>{f.children.length}</em>
              </button>
              {expanded.has(f.name) && <div className="children">{f.children.map(tag => <button key={tag} className={appliedTags.includes(tag) ? "tag-applied" : ""} onClick={() => applyTag(tag)}><span>└</span>{tag}{appliedTags.includes(tag) && <i>✓</i>}</button>)}</div>}
            </div>)}
          </div>
          <div className="tip">选择素材后，点击标签即可批量应用</div>
        </aside>

        <section className="viewer-panel">
          <div className="viewer-toolbar"><div><span className="eyebrow">当前讨论对象</span><b>{active.title}</b></div><div className="viewer-actions"><button>↗</button><button>···</button></div></div>
          <div className="stage"><button className="nav prev" onClick={() => setActiveId(Math.max(1, activeId - 1))}>‹</button><MockPhoto asset={active} large /><button className="nav next" onClick={() => setActiveId(Math.min(200, activeId + 1))}>›</button><span className="counter">{activeId} / 200</span></div>
          <div className="asset-info"><div className="info-top"><div><b>{active.title}</b><span>拍摄于今天 {active.time}</span></div><div className="chips">{appliedTags.map(t => <span key={t}>{t} ×</span>)}<button>＋ 添加标签</button></div></div>
            <div className="metadata"><span><i>◷</i><b>拍摄时间</b>{active.time}</span><span><i>♙</i><b>拍摄者</b>陈工</span><span><i>▣</i><b>设备</b>iPhone 15 Pro</span><span><i>⌖</i><b>位置</b>XX矿二号车间</span></div>
          </div>
        </section>

        <aside className="timeline-panel">
          <div className="timeline-head"><div><b>时间轴</b><span>今天 · 200 个素材</span></div><button>☷</button><button>▦</button></div>
          <div className="timeline-tools"><span>{selected.size ? `已选 ${selected.size} 项` : "拖动框选素材"}</span><button onClick={() => setSelected(new Set(assets.map(a => a.id)))}>全选此时间段</button></div>
          <div ref={parentRef} className="grid-scroll">
            <div ref={gridRef} className="virtual-grid" style={{ height: virtualizer.getTotalSize() }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endGesture} onPointerCancel={endGesture}>
              {virtualizer.getVirtualItems().map(row => <div className="grid-row" key={row.key} style={{ transform: `translateY(${row.start}px)` }}>
                {assets.slice(row.index * columns, row.index * columns + columns).map(asset => <div data-asset-id={asset.id} className={`thumb-card ${selected.has(asset.id) ? "selected" : ""} ${activeId === asset.id ? "active" : ""}`} key={asset.id}>
                  <MockPhoto asset={asset} /><span>{asset.time.slice(0, 5)}</span>{selected.has(asset.id) && <b className="check">✓</b>}
                </div>)}
              </div>)}
              {marquee && <div className="marquee" style={boxStyle} />}
            </div>
          </div>
          <div className="selection-help"><span><i>拖动</i> 滑过选择</span><span><i>Shift</i> 连续选择</span><span><i>⌘</i> 增减选择</span></div>
        </aside>
      </section>

      <footer className="transcript">
        <div className="live"><i /> 实时转写</div><div className="speaker"><b>发言人</b><span>刚刚</span></div>
        <p>这个是二号流槽改造以后的第一次试机，大家重点看一下出口物料的分布是不是均匀。</p>
        <button className="record-btn" onClick={() => setSummary(true)}><kbd>R</kbd> 记录最近 90 秒</button><button className="collapse">⌄</button>
      </footer>

      {summary && <div className="summary-drawer">
        <div className="summary-title"><span className="sparkle">✦</span><div><b>多模态讨论摘要</b><small>基于最近 90 秒语音 · {selected.size} 张选中图片</small></div><button onClick={() => setSummary(false)}>×</button></div>
        <div className="evidence" style={{ display: "flex", gap: 6, margin: "10px 0", fontSize: 9, color: "#367458" }}><span>◉ 图片视觉分析</span><span>◖ 腾讯云语音转写</span></div>
        <p>团队确认该组照片记录的是二号流槽改造后的首次试机，重点观察出口物料分布是否均匀。</p>
        <h4>已有标签推荐</h4><div className="recommend"><button onClick={() => applyTag("试机")} title="依据：语音中提到首次试机">活动 / 试机 <b>＋</b></button><button onClick={() => applyTag("改造后")} title="依据：语音提及改造后，图片显示设备结构">状态 / 改造后 <b>＋</b></button></div>
        <h4>新标签建议</h4><div className="new-tag"><span>设备 / 电选机 / 流槽 / <b>二号流槽</b></span><button>审阅并创建</button></div>
        <div className="summary-actions"><button onClick={() => setSummary(false)}>稍后处理</button><button className="primary-btn" onClick={() => { applyTag("试机"); applyTag("改造后"); }}>应用已有标签</button></div>
      </div>}
    </main>
  );
}
