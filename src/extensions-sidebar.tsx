import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, GripVertical, MoreHorizontal, Settings2, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import './extensions-sidebar.css';

type Group = 'opportunities' | 'boards' | 'judgments';
type Layout = { order: Group[]; open: Partial<Record<Group, boolean>> };
const initial: Layout = { order: ['opportunities', 'boards', 'judgments'], open: {} };
const LayoutContext = createContext({ layout: initial, searching: false, toggle: (_id: Group) => {}, move: (_id: Group, _target: Group) => {} });
function read(key: string): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (Array.isArray(value?.order) && value.order.length >= 2 && value.order.length <= 3 && new Set(value.order).size === value.order.length && value.order.every((id: string) => initial.order.includes(id as Group))) {
      return { order: [...value.order, ...initial.order.filter(id => !value.order.includes(id))], open: { opportunities: value.open?.opportunities === true, boards: value.open?.boards === true, judgments: value.open?.judgments === true } };
    }
  } catch { /* Use the compact default when storage is unavailable. */ }
  return initial;
}
export function ExtensionsSidebar({ accountId, query, opportunities, boards, judgments, onSettings }: { accountId: string; query: string; opportunities: ReactNode; boards: ReactNode; judgments?: ReactNode; onSettings: () => void }) {
  const key = `extensions-sidebar:${accountId}`;
  const [layout, setLayout] = useState(() => read(key));
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* Session layout still works. */ } }, [key, layout]);
  useEffect(() => {
    if (!menu) return;
    panel.current?.querySelector('button')?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setMenu(null); };
    const close = () => setMenu(null);
    const keyboard = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); trigger.current?.focus(); } if (e.key === 'Tab') close(); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', keyboard); window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keyboard); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  if (!opportunities && !boards && !judgments) return null;
  return <LayoutContext.Provider value={{ layout, searching: Boolean(query.trim()), toggle: id => setLayout(v => ({ ...v, open: { ...v.open, [id]: !v.open[id] } })), move: (id, target) => { if (id !== target) setLayout(v => ({ ...v, order: (() => { const next = [...v.order]; const from=next.indexOf(id), to=next.indexOf(target); next.splice(from,1); next.splice(to,0,id); return next; })() })); } }}>
    <section className="extensions-sidebar" aria-label="扩展功能">
      <div className="section-label project-label"><span>扩展功能</span><button ref={trigger} type="button" aria-label="扩展功能操作" aria-haspopup="menu" aria-expanded={!!menu} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { top: Math.min(r.bottom + 5, window.innerHeight - 160), left: Math.max(8, Math.min(r.right - 176, window.innerWidth - 184)) }); }}><MoreHorizontal size={15}/></button></div>
      {layout.order.map(id => <div key={id}>{id === 'opportunities' ? opportunities : id === 'boards' ? boards : judgments}</div>)}
    </section>
    {menu && createPortal(<div ref={panel} className="project-menu-panel" role="menu" aria-label="扩展功能操作" style={menu} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const items = Array.from(panel.current?.querySelectorAll('button') ?? []); const i = items.indexOf(document.activeElement as HTMLButtonElement); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); } }}>
      <button role="menuitem" onClick={() => { setMenu(null); onSettings(); }}><Settings2 size={16}/><span>功能选择</span></button>
      <button role="menuitem" onClick={() => { setLayout(v => ({ ...v, open: {} })); setMenu(null); }}><ChevronsDownUp size={16}/><span>全部收起</span></button>
      <button role="menuitem" onClick={() => { setLayout(v => ({ ...v, open: { boards: true, opportunities: true, judgments: true } })); setMenu(null); }}><ChevronsUpDown size={16}/><span>全部展开</span></button>
    </div>, document.body)}
  </LayoutContext.Provider>;
}
export function ExtensionGroup({ id, label, icon, onMenu, menuOpen, children }: { id: Group; label: string; icon: ReactNode; onMenu?: (target: HTMLButtonElement) => void; menuOpen?: boolean; children: ReactNode }) {
  const { layout, searching, toggle, move } = useContext(LayoutContext);
  const open = searching || layout.open[id] === true;
  const drag = useRef<{ x: number; y: number; target?: Group } | null>(null);
  const [target, setTarget] = useState<Group | null>(null);
  return <section className="extension-group" data-extension-group={id} aria-label={label}>
    <div className={`project-row extension-heading ${target ? 'dragging' : ''}`}>
      <button type="button" className="touch-drag-handle" aria-label={`拖动分类 ${label}`} title="拖动排序，也可用上下方向键调整" disabled={searching}
        onPointerDown={e => { if (e.button !== 0 || !e.isPrimary) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerMove={e => { if (!drag.current || Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y) < 5) return; const other = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-extension-group]')?.dataset.extensionGroup as Group | undefined; drag.current.target = other; setTarget(other ?? null); }}
        onPointerUp={e => { if (drag.current?.target) move(id, drag.current.target); drag.current = null; setTarget(null); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { drag.current = null; setTarget(null); }} onLostPointerCapture={() => { drag.current = null; setTarget(null); }}
        onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const next = layout.order[layout.order.indexOf(id) + (e.key === 'ArrowUp' ? -1 : 1)]; if (next) move(id, next); } }}><GripVertical size={12}/></button>
      <button type="button" className="project-select extension-toggle" aria-expanded={open} aria-controls={`extension-body-${id}`} onClick={() => toggle(id)}>{icon}<span>{label}</span><ChevronDown size={15}/></button>
      {onMenu && <div className="project-actions"><button type="button" aria-label={`${label}操作`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={e => onMenu(e.currentTarget)}><MoreHorizontal size={15}/></button></div>}
    </div>
    <div id={`extension-body-${id}`} className="extension-body" hidden={!open}><div className={id === 'opportunities' ? 'para-sidebar opportunity-sidebar' : 'para-sidebar'}>{children}</div></div>
  </section>;
}
