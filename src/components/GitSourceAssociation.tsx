import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { associateGitSource, type GitSourcePreview } from "../lib/tauri";
import { getErrorMessage } from "../lib/error";

/** Explicit two-step association; differing content is never overwritten. */
export function GitSourceAssociation({ skillId, onChanged }: { skillId: string; onChanged?: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<GitSourcePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const requestId = useRef(0);
  const invalidate = () => { requestId.current++; setPreview(null); setError(""); };
  const submit = async (confirm: boolean) => {
    const id = ++requestId.current;
    const reviewed = confirm ? preview?.revision ?? null : null;
    if (confirm && !reviewed) return;
    setBusy(true); setError("");
    try {
      const result = await associateGitSource(skillId, url.trim(), path.trim(), branch.trim() || null, reviewed);
      if (requestId.current !== id) return;
      if (confirm) { setPreview(null); setDone(true); onChanged?.(); }
      else setPreview(result);
    } catch (err) {
      if (requestId.current === id) { setPreview(null); setError(getErrorMessage(err, t("common.error"))); }
    } finally { setBusy(false); }
  };
  if (done) return <p className="text-[13px] text-secondary">{t("mySkills.associate.success")}</p>;
  return (
    <section className="mt-4 space-y-3 rounded-xl border border-border-subtle bg-surface/70 p-4">
      <h3 className="text-[13px] font-semibold text-secondary">{t("mySkills.associate.title")}</h3>
      <p className="text-[12px] text-muted">{t("mySkills.associate.help")}</p>
      <label className="block text-[12px] text-secondary">{t("mySkills.associate.url")}
        <input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5" value={url} disabled={busy} onChange={(e) => { invalidate(); setUrl(e.target.value); }} placeholder="https://github.com/owner/repository.git" />
      </label>
      <label className="block text-[12px] text-secondary">{t("mySkills.associate.branch")}
        <input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5" value={branch} disabled={busy} onChange={(e) => { invalidate(); setBranch(e.target.value); }} />
      </label>
      <label className="block text-[12px] text-secondary">{t("mySkills.associate.path")}
        <input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5" value={path} disabled={busy} onChange={(e) => { invalidate(); setPath(e.target.value); }} />
      </label>
      <button type="button" disabled={busy || !url.trim()} onClick={() => void submit(false)} className="rounded-md border border-border bg-surface-hover px-3 py-1.5 text-[13px] text-secondary disabled:opacity-50">{t("mySkills.associate.preview")}</button>
      {preview && <div className="space-y-2 text-[12px] text-secondary" role="status">
        <p className="break-all">{t("mySkills.associate.revision", { revision: preview.revision })}</p>
        <p>{t(preview.content_changed ? "mySkills.associate.different" : "mySkills.associate.identical")}</p>
        {!preview.content_changed && <button type="button" disabled={busy} onClick={() => void submit(true)} className="rounded-md bg-accent px-3 py-1.5 text-white disabled:opacity-50">{t("mySkills.associate.confirm")}</button>}
      </div>}
      {error && <p role="alert" className="break-words text-[12px] text-red-600">{error}</p>}
    </section>
  );
}
