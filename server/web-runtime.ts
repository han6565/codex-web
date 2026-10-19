import crypto from "node:crypto";
import type { FileRow } from "./db.js";

type Ticket = { fileId: string; sha256: string; shareRevision: number | null; sessionHash: string | null; expires: number };
export class WebRuntimeTickets {
  private tickets = new Map<string, Ticket>();
  issue(file: FileRow, shareRevision: number | null, sessionHash: string | null): string {
    const now = Date.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
    if (this.tickets.size >= 4096) this.tickets.delete(this.tickets.keys().next().value!);
    const id = crypto.randomBytes(32).toString("base64url");
    this.tickets.set(id, { fileId: file.id, sha256: file.sha256!, shareRevision, sessionHash, expires: now + 30 * 60_000 });
    return id;
  }
  keepAlive(id: string): void { const ticket = this.tickets.get(id); if (ticket) ticket.expires = Date.now() + 30 * 60_000; }
  read(id: string): Ticket | undefined {
    const ticket = this.tickets.get(id);
    return ticket && ticket.expires > Date.now() ? ticket : undefined;
  }
}

/** Installed before author code. Export is an explicit, bounded message to the trusted parent. */
export function webRuntimeDocument(body: Buffer, channel: string): string {
  const bridge = `<script>(()=>{const channel=${JSON.stringify(channel)};Object.defineProperty(window,'ppAgent',{value:Object.freeze({exportFile:(name,text)=>{if(!navigator.userActivation.isActive)throw new Error('请点击导出按钮');parent.postMessage({type:'codex-web:export',channel,name,text},'*')}}),writable:false});})();</script>`;
  return `<!doctype html><meta charset="utf-8">${bridge}${body.toString("utf8").replace(/^\uFEFF/, "")}`;
}
