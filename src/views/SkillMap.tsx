import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Minus, Plus, RefreshCw, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "../context/AppContext";
import { getGlobalLocalSkills, previewAgentSkillMap, type ProjectSkill } from "../lib/tauri";
import { combineAgentSkills, sortAgentsBySkillCount, type MapAgent, type MapSkill } from "./skillMapData";
import { SkillMapTranslation } from "./SkillMapTranslation";

const BRANCH_COLORS = ["#14b8a6", "#8b5cf6", "#f59e0b", "#3b82f6", "#ec4899", "#22c55e", "#f97316"];
const CURVE = (x1: number, y1: number, x2: number, y2: number) =>
  `M ${x1} ${y1} C ${x1 + (x2 - x1) * 0.5} ${y1}, ${x1 + (x2 - x1) * 0.5} ${y2}, ${x2} ${y2}`;

export function SkillMap() {
  const { t } = useTranslation();
  const { tools, managedSkills } = useApp();
  const installed = useMemo(() => tools.filter((tool) => tool.installed), [tools]);
  const [agents, setAgents] = useState<MapAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanFailed, setScanFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<{ agent: string; skill: MapSkill } | null>(null);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    const [scan, ...locals] = await Promise.allSettled([
      previewAgentSkillMap(), ...installed.map((tool) => getGlobalLocalSkills(tool.key)),
    ]);
    if (id !== request.current) return;
    const groups = scan.status === "fulfilled" ? scan.value.groups : [];
    setScanFailed(scan.status === "rejected");
    setAgents(sortAgentsBySkillCount(installed.map((tool, index) => {
      const result = locals[index];
      const local = result?.status === "fulfilled" ? result.value as ProjectSkill[] : [];
      return { tool, skills: combineAgentSkills(tool, local, groups), failed: result?.status !== "fulfilled" };
    })));
    setLoading(false);
  }, [installed]);
  useEffect(() => {
    const currentRequest = request;
    // Refresh reads the external filesystem and marks the pending request as loading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return () => { currentRequest.current++; };
  }, [refresh, managedSkills]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return agents.flatMap((agent) => {
      if (!needle || agent.tool.display_name.toLocaleLowerCase().includes(needle)) return [agent];
      const skills = agent.skills.filter((skill) => `${skill.name} ${skill.path} ${skill.plugin ?? ""}`.toLocaleLowerCase().includes(needle));
      return skills.length ? [{ ...agent, skills }] : [];
    });
  }, [agents, query]);

  const { layout, canvasHeight } = useMemo(() => {
    const sizes = visible.map((agent) => {
      const open = !collapsed.has(agent.tool.key);
      const height = open && agent.skills.length ? Math.max(72, agent.skills.length * 45) : 72;
      return { ...agent, open, height };
    });
    const layout = sizes.map((agent, index) => {
      const top = 42 + sizes.slice(0, index).reduce((sum, previous) => sum + previous.height + 28, 0);
      const { height, open } = agent;
      return { ...agent, open, top, height, center: top + 25 };
    });
    return { layout, canvasHeight: Math.max(300, 54 + sizes.reduce((sum, agent) => sum + agent.height + 28, 0)) };
  }, [visible, collapsed]);
  const rootY = Math.min(200, canvasHeight / 2);
  const total = agents.reduce((count, agent) => count + agent.skills.length, 0);
  const toggle = (key: string) => setCollapsed((old) => {
    const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });

  return (
    <div className="app-page gap-4">
      <header className="app-page-header flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="app-page-title">{t("mindmap.title")}</h1><p className="app-page-subtitle">{t("mindmap.subtitle")}</p></div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="app-button-secondary"><RefreshCw className="h-4 w-4" />{t("mindmap.refresh")}</button>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[240px] flex-1 items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2"><Search className="h-4 w-4 text-muted" /><input aria-label={t("mindmap.search")} className="w-full bg-transparent text-[13px] outline-none" placeholder={t("mindmap.search")} value={query} onChange={(event) => { setQuery(event.target.value); setCollapsed(new Set()); }} /></label>
        <button type="button" className="app-button-secondary" onClick={() => setCollapsed(new Set())}>{t("mindmap.expandAll")}</button>
        <button type="button" className="app-button-secondary" onClick={() => setCollapsed(new Set(agents.map((a) => a.tool.key)))}>{t("mindmap.collapseAll")}</button>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1"><button aria-label={t("mindmap.zoomOut")} type="button" onClick={() => setZoom((value) => Math.max(.6, Math.round((value - .1) * 10) / 10))} className="rounded-md p-1.5 hover:bg-surface-hover"><Minus className="h-4 w-4" /></button><button type="button" onClick={() => setZoom(1)} className="min-w-[44px] text-[12px] text-muted">{Math.round(zoom * 100)}%</button><button aria-label={t("mindmap.zoomIn")} type="button" onClick={() => setZoom((value) => Math.min(1.5, Math.round((value + .1) * 10) / 10))} className="rounded-md p-1.5 hover:bg-surface-hover"><Plus className="h-4 w-4" /></button></div>
      </div>
      {(scanFailed || agents.some((agent) => agent.failed)) && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px]">{t("mindmap.scanFailed")}</p>}
      <SkillMapTranslation descriptions={agents.flatMap((agent) => agent.skills.flatMap((skill) => skill.description ? [skill.description] : []))} translations={translations} onTranslated={(source, translation) => setTranslations((old) => ({ ...old, [source]: translation }))} />
      {loading ? <div className="app-panel flex items-center justify-center gap-2 py-20 text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t("mindmap.loading")}</div> : agents.length === 0 ? <div className="app-panel p-10 text-center text-muted">{t("mindmap.empty")}</div> : (
        <div className="relative overflow-hidden rounded-xl border border-border bg-bg-secondary">
          <div className="absolute left-4 top-3 z-10 rounded-lg border border-border-subtle bg-surface/90 px-3 py-1.5 text-[12px] text-muted">{t("mindmap.counts", { agents: agents.length, skills: total })}</div>
          <div className="h-[min(68vh,720px)] min-h-[420px] overflow-auto" aria-label={t("mindmap.canvas")}>
            <svg width={1020 * zoom} height={canvasHeight * zoom} viewBox={`0 0 1020 ${canvasHeight}`} role="group" aria-label={t("mindmap.canvas")} style={{ minWidth: 1020 * zoom }}>
              <defs><pattern id="skill-map-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="currentColor" opacity=".09" /></pattern></defs>
              <rect width="1020" height={canvasHeight} fill="url(#skill-map-dots)" />
              {layout.map((agent, index) => {
                const color = BRANCH_COLORS[index % BRANCH_COLORS.length];
                return <g key={agent.tool.key}>
                  <path d={CURVE(236, rootY, 310, agent.center)} fill="none" stroke={color} strokeWidth="3" opacity=".75" />
                  {agent.open && agent.skills.map((skill, i) => <path key={skill.path} d={CURVE(530, agent.center, 615, agent.top + 22 + i * 45)} fill="none" stroke={color} strokeWidth="2" opacity=".5" />)}
                  <foreignObject x="310" y={agent.center - 25} width="220" height="50"><button type="button" aria-expanded={agent.open} onClick={() => toggle(agent.tool.key)} style={{ borderLeftColor: color }} className="flex h-full w-full items-center gap-2 rounded-xl border border-border border-l-4 bg-surface px-3 text-left shadow-sm hover:bg-surface-hover">{agent.open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}<span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{agent.tool.display_name}</span><span className="text-[11px] text-muted">{agent.failed ? "!" : agent.skills.length}</span></button></foreignObject>
                  {agent.open && agent.skills.map((skill, i) => <foreignObject key={skill.path} x="615" y={agent.top + i * 45 + 3} width="365" height="38"><button type="button" title={skill.path} onClick={() => setSelected({ agent: agent.tool.display_name, skill })} className="flex h-full w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 text-left shadow-sm hover:border-accent-border hover:bg-surface-hover"><span style={{ backgroundColor: color }} className="h-2 w-2 shrink-0 rounded-full" /><span className="min-w-0 flex-1 truncate text-[12px] font-medium">{skill.name}</span>{skill.plugin && <span className="shrink-0 rounded-full bg-accent-bg px-2 py-0.5 text-[11px] text-accent-light">{t("mindmap.plugin")}</span>}{skill.enabled === false && <span className="shrink-0 text-[11px] text-muted">{t("mindmap.disabled")}</span>}</button></foreignObject>)}
                </g>;
              })}
              <foreignObject x="36" y={rootY - 30} width="200" height="60"><div className="flex h-full items-center gap-3 rounded-xl border border-accent-border bg-surface px-4 shadow-sm"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-[14px] font-bold text-white">M</span><span><span className="block text-[14px] font-semibold">MySkillHub</span><span className="block text-[11px] text-muted">{t("mindmap.root")}</span></span></div></foreignObject>
            </svg>
          </div>
          {selected && <aside className="absolute bottom-4 right-4 z-20 w-[min(360px,calc(100%-32px))] rounded-xl border border-border bg-surface p-4 shadow-xl"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[11px] text-muted">{selected.agent}</p><h2 className="break-words text-[14px] font-semibold">{selected.skill.name}</h2></div><button aria-label={t("mindmap.close")} type="button" onClick={() => setSelected(null)} className="rounded-md p-1 hover:bg-surface-hover"><X className="h-4 w-4" /></button></div>{selected.skill.description && <><p className="mt-3 text-[12px] text-muted">{translations[selected.skill.description] ?? selected.skill.description}</p>{translations[selected.skill.description] && <details className="mt-2 text-[11px] text-muted"><summary className="cursor-pointer">{t("mindmap.original")}</summary><p>{selected.skill.description}</p></details>}</>}<p className="mt-3 text-[11px] text-muted">{selected.skill.plugin ? t("mindmap.pluginOwner", { name: selected.skill.plugin }) : t("mindmap.ownershipUnknown")}</p><p className="mt-2 break-all font-mono text-[11px] text-muted">{selected.skill.path}</p></aside>}
        </div>
      )}
      <p className="text-[12px] text-muted">{t("mindmap.scope")}</p>
    </div>
  );
}
