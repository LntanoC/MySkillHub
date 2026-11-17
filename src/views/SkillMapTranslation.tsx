import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { translateSkillDescription } from "../lib/tauri";

type Props = { descriptions: string[]; translations: Record<string, string>; onTranslated: (source: string, translation: string) => void };

export function SkillMapTranslation({ descriptions, translations, onTranslated }: Props) {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = useState("https://api.deepseek.com/chat/completions");
  const [model, setModel] = useState("deepseek-flash");
  const [apiKey, setApiKey] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const pending = [...new Set(descriptions)].filter((value) => {
    const latin = (value.match(/[a-zA-Z]/g) ?? []).length;
    const han = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
    return latin > han && !translations[value];
  });

  async function translate() {
    setError("");
    setProgress({ done: 0, total: pending.length });
    try {
      for (let i = 0; i < pending.length; i++) {
        const translated = await translateSkillDescription(endpoint, model, apiKey, pending[i]);
        if (!active.current) return;
        onTranslated(pending[i], translated);
        setProgress({ done: i + 1, total: pending.length });
      }
    } catch (err) {
      if (active.current) setError(String(err));
    } finally {
      if (active.current) setProgress(null);
    }
  }
  return <details className="rounded-xl border border-border bg-surface p-3">
    <summary className="cursor-pointer text-[13px] font-medium">{t("mindmap.translationTitle")}</summary>
    <p className="mt-2 text-[12px] text-muted">{t("mindmap.translationNotice")}</p>
    <div className="mt-3 grid gap-2 md:grid-cols-2">
      <label className="text-[12px] text-muted">{t("mindmap.apiEndpoint")}<input className="mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-primary" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
      <label className="text-[12px] text-muted">{t("mindmap.apiModel")}<input className="mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-primary" value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <label className="text-[12px] text-muted md:col-span-2">{t("mindmap.apiKey")}<input type="password" autoComplete="off" className="mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-primary" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
    </div>
    <button type="button" className="app-button-secondary mt-3" disabled={!!progress || !pending.length || !endpoint.trim() || !model.trim()} onClick={() => void translate()}>{progress ? t("mindmap.translating", progress) : t("mindmap.translateAll", { count: pending.length })}</button>
    {error && <p role="alert" className="mt-2 text-[12px] text-red-500">{t("mindmap.translationFailed")} {error}</p>}
  </details>;
}
