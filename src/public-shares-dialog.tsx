import { useCallback, useEffect, useState } from "react";
import { FileText, LoaderCircle, RefreshCw, Share2, X } from "lucide-react";
import { api, type ManagedPublicShare } from "./api";
import { FileShareDialog } from "./file-share-dialog";
import { handleReaderLinkClick } from "./reader/navigation";
import { filePreviewUrl } from "./file-links";
import { isPublicShareActive, publicShareRemaining } from "./public-share";
import { useShareClock } from "./use-share-clock";

export function PublicSharesDialog({ onClose, onSelect }: { onClose: () => void; onSelect: (conversationId: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [shares, setShares] = useState<ManagedPublicShare[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const now = useShareClock();
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setShares((await api.publicShares()).shares); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "分享列表加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !selected) onClose(); };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [selected, onClose]);
  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !selected) onClose(); }}>
    <section className="project-dialog public-shares-dialog ui-dialog" role="dialog" aria-modal="true" aria-labelledby="public-shares-dialog-title">
      <header><div><h2 id="public-shares-dialog-title">公开分享管理</h2><p>找回阅读文档与交互网页，管理有效、已关闭、已到期和冷存储的分享。</p></div><button onClick={onClose} aria-label="关闭公开分享管理"><X size={18} /></button></header>
      <div className="project-dialog-body public-shares-body" aria-busy={loading}>
        <div className="public-shares-toolbar"><span><Share2 size={15} />正在公开 {shares.filter(share => isPublicShareActive(share.enabled, share.expiresAt, now)).length} 项</span><button onClick={() => void load()} disabled={loading}><RefreshCw size={16} />刷新</button></div>
        {loading && !shares.length && <p><LoaderCircle className="spin" size={20} />正在加载分享记录…</p>}
        {!loading && !shares.length && <p>还没有分享记录。在消息附件卡片上开启分享后，会显示在这里。</p>}
        <div className="public-shares-list">{shares.map(share => <article className="public-share-row" key={share.id}>
          <div className="public-share-icon"><FileText size={18} /></div>
          <div className="public-share-copy">
            <a href={filePreviewUrl({ id: share.fileId })} target={share.presentationMode === "web" ? "_blank" : undefined} rel={share.presentationMode === "web" ? "noreferrer" : undefined} onClick={share.presentationMode === "web" ? undefined : handleReaderLinkClick} className="public-share-title">{share.fileName}</a>
            <span>{share.presentationMode === "web" ? "交互网页" : "阅读文档"} · {share.conversationTitle || "未命名任务"}</span>
            <span>{isPublicShareActive(share.enabled, share.expiresAt, now) ? publicShareRemaining(share.expiresAt, now) : share.enabled ? "已到期" : "已关闭"}{share.storageState !== "local" ? " · 已冷存储或正在恢复" : ""}</span>
            <button className="public-share-source" onClick={() => onSelect(share.conversationId)}>返回来源会话</button>
          </div><div className="public-share-actions"><button onClick={() => setSelected(share.fileId)}>管理分享</button></div>
        </article>)}</div>
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
      </div>
    </section>
    {selected && <FileShareDialog fileId={selected} onClose={() => setSelected(null)} onChange={() => void load()} />}
  </div>;
}
