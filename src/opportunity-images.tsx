import { useEffect, useState } from 'react';
import { CloudDownload, ImageOff, LoaderCircle } from 'lucide-react';
import { BASE_PATH, request } from './api';
import type { OpportunityIdea, OpportunityImage } from './opportunity-types';
function CardImage({ image, eager }: { image: OpportunityImage; eager: boolean }) {
  const [state, setState] = useState(image.state), [error, setError] = useState(''), [retry, setRetry] = useState(0), [waiting, setWaiting] = useState(false);
  useEffect(() => { setState(image.state); }, [image.state]);
  const endpoint = image.url.replace(/^\/api/, '');
  const imageUrl = image.url.startsWith('/api/') ? BASE_PATH + image.url : image.url;
  useEffect(() => {
    if (!waiting) return;
    let active = true, timer: number; const until = Date.now() + 60000;
    const poll = async () => {
      try {
        const result = await request<{ state: OpportunityImage['state'] }>(endpoint + '/status');
        if (!active) return;
        setState(result.state);
        if (result.state === 'local') { setError(''); setRetry(v => v + 1); setWaiting(false); return; }
        if (result.state !== 'restoring') { setError('配图暂未恢复，请稍后重试。'); setWaiting(false); return; }
        if (Date.now() >= until) { setError('恢复仍在进行，可稍后再查看。'); setWaiting(false); return; }
        timer = window.setTimeout(() => void poll(), 2000);
      } catch { if (active) { setError('读取恢复进度失败，请重试。'); setWaiting(false); } }
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [endpoint, waiting]);
  const activate = async () => {
    setError(''); setWaiting(true);
    try { const result = await request<{state: OpportunityImage['state']}>(endpoint + '/activate', { method: 'POST', body: '{}' }); setState(result.state); if (result.state === 'local') { setRetry(v => v + 1); setWaiting(false); } }
    catch { setError('配图暂不可用，请重试。'); setWaiting(false); }
  };
  return <figure className="opportunity-image">
    {state === 'local' && !error ? <a href={imageUrl} target="_blank" rel="noreferrer" title="查看原图"><img src={imageUrl + (retry ? '?retry=' + retry : '')} alt={image.alt} width={image.width} height={image.height} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={() => setError('配图暂不可用，可能需要从冷存储恢复。')}/></a>
      : <div className="opportunity-image-placeholder">{waiting ? <LoaderCircle className="spin" size={24}/> : state === 'unavailable' ? <ImageOff size={24}/> : <CloudDownload size={24}/>}<p>{state === 'unavailable' ? '配图来源会话已删除' : error || (waiting ? '正在恢复配图…' : '配图已冷存储') }</p><p className="opportunity-image-alt">{image.alt}</p>{state !== 'unavailable' && <button type="button" disabled={waiting} onClick={() => void activate()}>{waiting ? '恢复中…' : '查看配图'}</button>}</div>}
    {image.caption && <figcaption>{image.caption}</figcaption>}
  </figure>;
}
export function OpportunityImages({ idea, eager = false }: { idea: OpportunityIdea; eager?: boolean }) {
  if (!idea.images?.length) return null;
  return <div className="opportunity-images" aria-label="思路图解">{idea.images.map(image => <CardImage key={image.id} image={image} eager={eager}/>)}</div>;
}
