import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { AppDatabase } from './db.js';
import { OpportunityStore, OpportunityError } from './opportunity-store.js';

const maxBytes = 32 * 1024 * 1024;
const relativePath = z.string().max(500).refine(v => v.startsWith('outputs/') && !v.includes('\\') && !/[\x00-\x1f]/.test(v) && v.split('/').every(p => p && p !== '.' && p !== '..'), '图片必须是本会话 outputs/ 下的普通文件');
export type OpportunityImageRow = { id: string; idea_id: string; user_id: string; conversation_id: string; relative_path: string; mime_type: string; size: number; sha256: string; width: number; height: number; alt: string; caption: string; position: number; created_at: string };

// No media copy or special retention directory: the normal conversation archive
// owns these output bytes, while these rows are durable provenance and labels.
export class OpportunityImages {
  readonly store: OpportunityStore;
  constructor(readonly db: AppDatabase, readonly tenantRoot: string) { this.store = new OpportunityStore(db); }
  async read(user: string, conversation: string, relative: string) {
    relativePath.parse(relative);
    const owner = this.db.getConversationForUser(conversation, user);
    if (!owner) throw new OpportunityError(404, '配图来源会话已删除。');
    const state = this.db.getConversationStorage(conversation)?.state ?? 'local';
    if (state !== 'local') throw new OpportunityError(409, '配图已冷存储或正在恢复，请点击查看配图。');
    let current = path.resolve(this.tenantRoot);
    const parts = [user, 'conversations', conversation, ...relative.split('/')];
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OpportunityError(400, '配图路径不能经过符号链接。');
    }
    const handle = await fs.open(path.join(current, parts.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw new OpportunityError(400, '配图必须是 32 MB 以内的普通图片文件。');
      const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
      let used = 0;
      while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
      if (used !== stat.size) throw new OpportunityError(409, '配图文件正在变化，请生成完成后重试。');
      return buffer.subarray(0, used);
    } finally { await handle.close(); }
  }
  async attach(user: string, conversation: string, jobId: string | undefined, raw: unknown) {
    const v = z.object({ ideaId: z.string().uuid(), requestKey: z.string().uuid(), revision: z.number().int().positive(), images: z.array(z.object({ path: relativePath, alt: z.string().trim().min(1).max(1200), caption: z.string().trim().max(2000).default('') })).min(1).max(12) }).parse(raw);
    const idea = this.store.idea(user, v.ideaId);
    this.store.assertJob(user, idea.topic_id, conversation, jobId);
    const operation = 'images:' + JSON.stringify({ conversation, ...v });
    const old = this.db.sqlite.prepare('SELECT operation,result_json FROM opportunity_requests WHERE user_id=? AND request_key=?').get(user, v.requestKey) as {operation:string;result_json:string}|undefined;
    if (old) { if (old.operation !== operation) throw new OpportunityError(409, '请求内容已变化，请重新操作。'); return JSON.parse(old.result_json); }
    if (idea.revision !== v.revision) throw new OpportunityError(409, '卡片已变化，请重新读取后添加配图。');
    if (new Set(v.images.map(i => i.path)).size !== v.images.length) throw new OpportunityError(400, '请勿重复添加同一图片。');
    const prepared: { path: string; alt: string; caption: string; size: number; sha256: string; width: number; height: number; mime: string }[] = [];
    for (const image of v.images) {
      const bytes = await this.read(user, conversation, image.path);
      const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height || (meta.pages ?? 1) !== 1) throw new OpportunityError(400, '配图仅支持静态 PNG、JPEG 或 WebP。');
      prepared.push({ ...image, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), width: meta.width, height: meta.height, mime: 'image/' + meta.format });
    }
    return this.store.receipt(user, v.requestKey, operation, () => {
      this.store.assertJob(user, idea.topic_id, conversation, jobId);
      if (this.store.idea(user, v.ideaId).revision !== v.revision) throw new OpportunityError(409, '卡片已变化，请重新读取后添加配图。');
      this.db.sqlite.prepare('DELETE FROM opportunity_images WHERE idea_id=? AND user_id=?').run(v.ideaId, user);
      const now = new Date().toISOString();
      prepared.forEach((image, index) => this.db.sqlite.prepare('INSERT INTO opportunity_images VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), v.ideaId, user, conversation, image.path, image.mime, image.size, image.sha256, image.width, image.height, image.alt, image.caption, index, now));
      this.db.sqlite.prepare('UPDATE opportunity_ideas SET revision=revision+1,updated_at=? WHERE id=?').run(now, v.ideaId);
      this.db.touchConversationActivity(conversation);
      return { idea: this.store.idea(user, v.ideaId) };
    });
  }
  row(user: string, idea: string, image: string) {
    this.store.idea(user, idea);
    const row = this.db.sqlite.prepare('SELECT * FROM opportunity_images WHERE user_id=? AND idea_id=? AND id=?').get(user, idea, image) as OpportunityImageRow | undefined;
    if (!row || !this.db.getConversationForUser(row.conversation_id, user)) throw new OpportunityError(404, '配图或来源会话不可用。');
    return row;
  }
  async bytes(user: string, idea: string, image: string) {
    const row = this.row(user, idea, image), bytes = await this.read(user, row.conversation_id, row.relative_path);
    if (bytes.length !== row.size || crypto.createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new OpportunityError(409, '配图文件已变化，请在来源会话重新关联。');
    this.db.touchConversationActivity(row.conversation_id);
    return { row, bytes };
  }
}
