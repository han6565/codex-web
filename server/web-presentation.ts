import crypto from "node:crypto";
import fs from "node:fs";
import { Parser } from "htmlparser2";
import type { FileRow } from "./db.js";

export const WEB_MAX_BYTES = 5 * 1024 * 1024;
export const PRESENTATION_SUFFIX = ".pp-agent.json";
/** Invalid author-supplied presentation metadata/content, never a transport or disk error. */
export class PresentationValidationError extends Error {}
export type PresentationDeclaration = { presentation_mode: "reader" | "web"; sha256: string };
export type WebManifest = {
  policy: 1; title: string; selfContained: true;
  members: Array<{ name: string; sha256: string; size: number }>;
  inline: { scripts: number; styles: number; images: number; fonts: number; data: number };
};

export function parsePresentationDeclaration(text: string): PresentationDeclaration {
  if (Buffer.byteLength(text) > 4096) throw new PresentationValidationError("展示声明超过限制。");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new PresentationValidationError("展示声明不是有效 JSON。"); }
  const keys = [...text.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map(match => JSON.parse(match[1]));
  if (keys.length !== 2 || new Set(keys).size !== 2 || keys.some(key => !["presentation_mode", "sha256"].includes(key))) throw new PresentationValidationError("展示声明包含重复、未知或嵌套字段。");
  if (!value || typeof value !== "object" || !("presentation_mode" in value) || !("sha256" in value)
    || (value.presentation_mode !== "reader" && value.presentation_mode !== "web") || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new PresentationValidationError("展示声明必须包含 presentation_mode=reader|web 和成品 SHA-256。");
  }
  return { presentation_mode: value.presentation_mode as "reader" | "web", sha256: value.sha256 };
}

export function assertPresentationHint(text: string, mode: "reader" | "web"): void {
  const hints: string[] = [];
  const parser = new Parser({ onopentag(tag, attrs) {
    if (tag === "meta" && attrs.name?.toLowerCase() === "pp-agent-view") hints.push(attrs.content ?? "");
  } });
  parser.end(text);
  if (hints.length > 1 || hints.some(hint => hint !== mode)) throw new PresentationValidationError("HTML 展示意图与交付声明冲突，请重新交付。");
}

/** The declaration is accepted only on managed, hash-verified delivery. HTML hints never grant execution. */
export function validateWebDocument(body: Buffer, name: string, checkHint = true): WebManifest {
  if (body.length > WEB_MAX_BYTES) throw new PresentationValidationError("交互网页首版仅支持 5 MiB 以内的自包含 HTML。");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { throw new PresentationValidationError("交互网页必须使用 UTF-8 编码。"); }
  const manifest: WebManifest = { policy: 1, title: name, selfContained: true,
    members: [{ name, sha256: crypto.createHash("sha256").update(body).digest("hex"), size: body.length }],
    inline: { scripts: 0, styles: 0, images: 0, fonts: 0, data: 0 } };
  const hints: string[] = [];
  let inTitle = false, title = "", inStyle = false;
  function css(value: string) {
    // Decode CSS escapes before checking URLs. CSP remains the enforcement boundary.
    const decoded = value.replace(/\\([a-f0-9]{1,6})\s?|\\([^\r\n])/gi, (_, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16) > 0x10ffff ? 0xfffd : parseInt(hex, 16) || 0xfffd) : char);
    if (/@import\b/i.test(decoded)) throw new PresentationValidationError("交互网页不支持外部 CSS，请内嵌全部资源。");
    for (const match of decoded.matchAll(/url\(\s*["']?([^)'"\s]+)/gi)) {
      if (!/^(?:#|data:(?:image\/[\w.+-]+|font\/[\w.+-]+|application\/(?:font-woff2?|x-font-(?:ttf|otf|woff)|vnd\.ms-fontobject|octet-stream))(?:;|,))/i.test(match[1])) throw new PresentationValidationError("交互网页的 CSS 图片和字体必须内嵌。");
      if (/^data:(?:font|application)/i.test(match[1])) manifest.inline.fonts++;
    }
  }
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (["iframe", "frame", "frameset", "object", "embed", "base"].includes(tag)) throw new PresentationValidationError(`首版交互网页不支持 ${tag}，请交付自包含 HTML。`);
      if (tag === "meta" && /refresh/i.test(attrs["http-equiv"] ?? "")) throw new PresentationValidationError("交互网页不支持自动跳转。");
      if (tag === "meta" && attrs.name?.toLowerCase() === "pp-agent-view") hints.push(attrs.content ?? "");
      if (tag === "script") { if (attrs.src) throw new PresentationValidationError("脚本必须内嵌。"); manifest.inline.scripts++; if (attrs.type && !/^(?:module|(?:text|application)\/javascript)$/.test(attrs.type)) manifest.inline.data++; }
      if (tag === "style") { inStyle = true; manifest.inline.styles++; }
      if (tag === "title") inTitle = true;
      if (attrs.style) css(attrs.style);
      for (const [key, value] of Object.entries(attrs)) {
        if (["action", "formaction", "ping", "srcdoc", "srcset"].includes(key) && value) throw new PresentationValidationError(`首版交互网页不支持 ${key}；请使用内置数据及受限导出协议。`);
        if (["src", "poster", "background", "xlink:href"].includes(key) || (key === "href" && !["a", "area"].includes(tag))) {
          if (value && !/^(?:data:(?:image|font|audio|video)\/|#)/i.test(value)) throw new PresentationValidationError("交互网页资源必须全部内嵌，不支持相对路径或外部依赖。");
        }
        if (key === "href" && ["a", "area"].includes(tag) && value && !value.startsWith("#")) throw new PresentationValidationError("首版交互网页仅支持页内导航；文件导出请使用受限协议。");
      }
      if (tag === "img" || tag === "image") manifest.inline.images++;
    },
    ontext(value) { if (inTitle) title += value; if (inStyle) css(value); },
    onclosetag(tag) { if (tag === "title") inTitle = false; if (tag === "style") inStyle = false; },
  }, { decodeEntities: true });
  parser.end(text);
  if (checkHint && (hints.length > 1 || hints.some(hint => hint !== "web"))) throw new PresentationValidationError("HTML 展示意图与交付声明冲突，请重新交付。");
  manifest.title = title.trim().slice(0, 200) || name;
  return manifest;
}

export function verifiedWebBody(file: Pick<FileRow, "kind" | "presentation_mode" | "presentation_manifest" | "sha256" | "size">, absolute: string): Buffer {
  if (file.kind !== "output" || file.presentation_mode !== "web" || !file.presentation_manifest || !file.sha256) throw new Error("不是已登记的交互网页。");
  const manifest = JSON.parse(file.presentation_manifest) as WebManifest;
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || stat.size > WEB_MAX_BYTES) throw new Error("网页版本不完整。");
  const body = fs.readFileSync(absolute);
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  if (sha256 !== file.sha256 || manifest.policy !== 1 || manifest.members.length !== 1
    || manifest.members[0].sha256 !== sha256 || manifest.members[0].size !== body.length) throw new Error("网页版本校验失败。");
  return body;
}

// No same-origin, forms, popups, top navigation, downloads, workers, network APIs or storage.
// The response sandbox also applies on direct navigation; the frame alone is not trusted.
export const WEB_RUNTIME_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
