// remote-mcp-server-authless（D-1ゲートウェイ）src/index.ts
// 9ツール版（add / calculate / probe_workers / generate_thumbnail / adopt_thumbnail /
//            start_thumbnail_job / check_thumbnail_job / upload_cover / create_upload_ticket）＋ /upload
// ★2026-06-28 §8: delete_block ツール追加（10ツール化）。UPLOAD_SVC 経由で proceed-upload-test の
//   ?action=delete_block&blockId=... を代理実行し、Notion API DELETE /v1/blocks/{id} でブロック削除。
//   gateway は NOTION_TOKEN 非保持のため、削除は upload-test 側（NOTION_TOKEN保持）で実行する分業。
// 変更点（2026-06-20・★のみ）:
//   ★ check_thumbnail_job の返却を R2短命URL方式へ更新。
//      previewDataUrl（base64）は返さず、proceed-thumbnail が発行する previewUrl / size / contentType を素通し。
//      token値・base64は返さない。
//   ★cover（2026-06-20追加・案Yカバー経路）:
//      create_upload_ticket の mode enum に "cover" を追加。cover は pageId 必須・画像のみ。
//      handleUpload で mode==="cover" を許可。thumb_ref のような早期returnにせず、
//      既存 image/file と同じ通常FormData経路で fd.append("mode","cover") して UPLOAD_SVC(proceed-upload-test) へ転送。
//      ★GatewayでNotion File Upload APIは新設しない。カバー設定は proceed-upload-test 側の既存cover処理が担う。
//   それ以外（既存ツール・既存ルート・Service Binding UPLOAD_SVC・/upload）は現行正本のまま不変。
// 変更点（2026-06-25・★★のみ）:
//   ★★ FILE_TYPES（mode=file の原本添付allowlist）をモジュール定数へ一本化。
//      create_upload_ticket / handleUpload のローカル二重定義を撤去し、同一定数を参照（将来のズレ防止）。
//      許可MIMEに Office系（docx/xlsx/pptx）を追加（従来は application/pdf のみ）。
//      ※ image / thumb_ref / cover の allowlist・MAX_SIZE は不変。
// 必須バインディング: KV UPLOAD_TICKETS / Service UPLOAD_SVC→proceed-upload-test /
//                    Secret THUMBNAIL_TOKEN・UPLOAD_TOKEN / (任意)Var GATEWAY_UPLOAD_URL

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const UPLOAD_BASE = "https://proceed-upload-test.cloud-taku.workers.dev";
const THUMB_BASE = "https://proceed-thumbnail.cloud-taku.workers.dev";
const THUMB_REF_TYPES = ["image/png", "image/jpeg", "image/webp"]; // ★J: thumb_ref専用allowlist（共有IMAGE_TYPESと分離）
// ★★ 原本ファイル添付（mode=file）の許可MIME。pdf＋Office系（docx/xlsx/pptx）。create_upload_ticket と handleUpload が共用。
const FILE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",   // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",         // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
];

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "proceed-gateway",
    version: "1.0.0",
  });

  async init() {
    // Simple addition tool
    this.server.registerTool(
      "add",
      { inputSchema: { a: z.number(), b: z.number() } },
      async ({ a, b }) => ({
        content: [{ type: "text", text: String(a + b) }],
      }),
    );

    // Calculator tool with multiple operations
    this.server.registerTool(
      "calculate",
      {
        inputSchema: {
          operation: z.enum(["add", "subtract", "multiply", "divide"]),
          a: z.number(),
          b: z.number(),
        },
      },
      async ({ operation, a, b }) => {
        let result: number;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot divide by zero",
                  },
                ],
              };
            result = a / b;
            break;
        }
        return { content: [{ type: "text", text: String(result) }] };
      },
    );

    // --- probe_workers（課金ゼロの到達＋認証プローブ・代理実行） ---
    this.server.registerTool(
      "probe_workers",
      { inputSchema: {} },
      async () => {
        const env = this.env as any;
        const out: any = {};

        try {
          const r = await fetch(UPLOAD_BASE + "/", { method: "GET" });
          out.upload_get = { status: r.status };
        } catch (e) {
          out.upload_get = { error: String(e) };
        }

        try {
          const r = await fetch(UPLOAD_BASE + "/", {
            method: "POST",
            headers: { "X-UPLOAD-TOKEN": env.UPLOAD_TOKEN || "" },
            body: new FormData(),
          });
          const b: any = await r.json().catch(() => ({}));
          out.upload_auth = { status: r.status, error: b.error };
        } catch (e) {
          out.upload_auth = { error: String(e) };
        }

        try {
          const r = await fetch(THUMB_BASE + "/", { method: "GET" });
          out.thumb_get = { status: r.status };
        } catch (e) {
          out.thumb_get = { error: String(e) };
        }

        try {
          const r = await fetch(THUMB_BASE + "/", {
            method: "POST",
            headers: {
              "X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          });
          const b: any = await r.json().catch(() => ({}));
          out.thumb_auth = { status: r.status, error: b.error };
        } catch (e) {
          out.thumb_auth = { error: String(e) };
        }

        const summary = {
          upload_reachable: out.upload_get?.status === 200,
          upload_authed:
            out.upload_auth?.status === 400 &&
            /no file field/.test(out.upload_auth?.error || ""),
          thumb_reachable: out.thumb_get?.status === 405,
          thumb_authed:
            out.thumb_auth?.status === 400 &&
            /prompt/.test(out.thumb_auth?.error || ""),
        };

        return {
          content: [
            { type: "text", text: JSON.stringify({ summary, detail: out }, null, 2) },
          ],
        };
      },
    );

    // --- generate_thumbnail（proceed-thumbnail を代理実行・dataUrl返却・token非露出／同期・デバッグ用） ---
    this.server.registerTool(
      "generate_thumbnail",
      {
        inputSchema: {
          prompt: z.string(),
          count: z.number().optional(),
        },
      },
      async ({ prompt, count }) => {
        const env = this.env as any;
        const n = Math.min(Math.max(Math.floor(count ?? 2), 1), 2);

        try {
          const r = await fetch(THUMB_BASE + "/", {
            method: "POST",
            headers: {
              "X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt, count: n }),
          });
          const data: any = await r.json().catch(() => ({}));

          if (!r.ok || data.ok === false) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: false,
                      status: r.status,
                      error: data.error || "thumbnail generation failed",
                      errors: data.details || data.errors,
                      jobId: data.jobId,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          const images = (data.images || []).map((im: any) => ({
            index: im.index,
            dataUrl: im.dataUrl,
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, jobId: data.jobId, count: data.count, images, errors: data.errors },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: false, error: String(e) }, null, 2) },
            ],
          };
        }
      },
    );

    // --- adopt_thumbnail（proceed-thumbnail /adopt を代理実行・token非露出） ---
    this.server.registerTool(
      "adopt_thumbnail",
      {
        inputSchema: {
          jobId: z.string(),
          index: z.number(),
        },
      },
      async ({ jobId, index }) => {
        const env = this.env as any;
        const idx = Math.floor(index);

        try {
          const r = await fetch(THUMB_BASE + "/adopt", {
            method: "POST",
            headers: {
              "X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ jobId, index: idx }),
          });
          const data: any = await r.json().catch(() => ({}));

          if (!r.ok || data.ok !== true || data.error) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: false,
                      status: r.status,
                      error: data.error || "adopt failed",
                      keptKey: data.keptKey,
                      available: data.available,
                      jobId,
                      index: idx,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, jobId: data.jobId, index: data.index, keptKey: data.keptKey, deleted: data.deleted },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: false, error: String(e) }, null, 2) },
            ],
          };
        }
      },
    );

    // --- start_thumbnail_job（proceed-thumbnail /start を代理実行・jobId即返し） ---
    this.server.registerTool(
      "start_thumbnail_job",
      {
        inputSchema: {
          prompt: z.string(),
          count: z.number().optional(),
          imageKey: z.string().optional(),       // ★J: B案=参照画像のrefKey
        },
      },
      async ({ prompt, count, imageKey }) => {
        const env = this.env as any;
        const n = Math.min(Math.max(Math.floor(count ?? 2), 1), 2);

        try {
          const r = await fetch(THUMB_BASE + "/start", {
            method: "POST",
            headers: {
              "X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt, count: n, ...(imageKey ? { imageKey } : {}) }), // ★J
          });
          const data: any = await r.json().catch(() => ({}));

          if (!r.ok || data.ok !== true) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: false, status: r.status, error: data.error || "start failed" },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, jobId: data.jobId, status: data.status, count: data.count },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: false, error: String(e) }, null, 2) },
            ],
          };
        }
      },
    );

    // --- check_thumbnail_job（proceed-thumbnail /check を代理実行） ---
    // ★R2短命URL方式：previewUrl / size / contentType を素通し。previewDataUrl（base64）・token値は返さない。
    this.server.registerTool(
      "check_thumbnail_job",
      {
        inputSchema: {
          jobId: z.string(),
        },
      },
      async ({ jobId }) => {
        const env = this.env as any;

        try {
          const r = await fetch(THUMB_BASE + "/check", {
            method: "POST",
            headers: {
              "X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ jobId }),
          });
          const data: any = await r.json().catch(() => ({}));

          if (!r.ok || data.ok !== true) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: false, status: r.status, error: data.error || "check failed", jobId },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          // ★proceed-thumbnail が返す短命HMAC署名URLをそのまま透過（base64・tokenは透過しない）
          const candidates = (data.candidates || []).map((c: any) => ({
            index: c.index,
            previewUrl: c.previewUrl ?? null,
            size: c.size ?? null,
            contentType: c.contentType ?? "image/jpeg",
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, jobId, status: data.status, candidates, errors: data.errors },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: false, error: String(e) }, null, 2) },
            ],
          };
        }
      },
    );

    // --- upload_cover（thumbnail採用フルを Notion ページのカバーに設定・token非露出） ---
    // ① 内蔵 THUMBNAIL_TOKEN で /img からフルbytes取得 → ② 内蔵 UPLOAD_TOKEN で upload-test へ multipart(mode=cover)
    this.server.registerTool(
      "upload_cover",
      {
        inputSchema: {
          jobId: z.string(),
          index: z.number(),
          pageId: z.string(),
        },
      },
      async ({ jobId, index, pageId }) => {
        const env = this.env as any;
        const idx = Math.floor(index);

        try {
          const imgRes = await fetch(`${THUMB_BASE}/img/${jobId}/${idx}.png`, {
            headers: { "X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "" },
          });
          if (!imgRes.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: false, step: "fetch_full", status: imgRes.status, error: "full image not found (adopt済みか確認)", jobId, index: idx },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          const bytes = new Uint8Array(await imgRes.arrayBuffer());
          const ctype = imgRes.headers.get("content-type") || "image/png";
          const ext = ctype.includes("jpeg") || ctype.includes("jpg") ? "jpg" : "png";

          const fd = new FormData();
          fd.append("file", new Blob([bytes], { type: ctype }), `${jobId}_${idx}.${ext}`);
          fd.append("pageId", pageId);
          fd.append("mode", "cover");

          const upRes = await fetch(UPLOAD_BASE + "/", {
            method: "POST",
            headers: { "X-UPLOAD-TOKEN": env.UPLOAD_TOKEN || "" },
            body: fd,
          });
          const upData: any = await upRes.json().catch(() => ({}));

          if (!upRes.ok || upData.ok !== true) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: false,
                      step: "upload_cover",
                      status: upRes.status,
                      error: upData.error || "cover set failed",
                      detail: upData.step ? { step: upData.step, body: upData.body } : undefined,
                      pageId,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, attached: upData.attached || "page cover", pageId, mode: "cover", size: upData.size },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: false, error: String(e) }, null, 2) },
            ],
          };
        }
      },
    );

    // --- create_upload_ticket（短命チケット発行・KV保管・用途固定／UPLOAD_TOKEN非露出） ---
    this.server.registerTool(
      "create_upload_ticket",
      {
        inputSchema: {
          fileName: z.string(),
          contentType: z.string(),
          pageId: z.string().optional(),                       // ★J: thumb_refでは不要 / ★cover: 必須(下のガードで担保)
          mode: z.enum(["image", "file", "thumb_ref", "cover"]).optional(), // ★cover追加
          placement: z.enum(["top", "bottom"]).optional(),
          anchorText: z.string().optional(),
          deleteAnchor: z.boolean().optional(),
          headingText: z.string().optional(),
          targetBlockId: z.string().optional(), // ★案2-A: 指定でupdate_image_block（同一blockIdの中身差し替え）
          afterBlockId: z.string().optional(),  // ★案2-B: 指定でこのブロック直後にappend
          parentId: z.string().optional(),      // ★案2-B: append先の親（省略時pageId）
          caption: z.string().optional(),       // ★案2-B: caption再付与
        },
      },
      async ({ fileName, contentType, pageId, mode, placement, anchorText, deleteAnchor, headingText, targetBlockId, afterBlockId, parentId, caption }) => {
        const env = this.env as any;
        const j = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
        if (!env.UPLOAD_TICKETS) return j({ ok: false, error: "KV UPLOAD_TICKETS not bound" });
        const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
        // ★★ FILE_TYPES はモジュール定数を使用（pdf＋docx/xlsx/pptx）。ローカル二重定義は撤去。
        const m = mode ?? "image";
        const ct = (contentType || "").toLowerCase();
        if (m !== "image" && m !== "file" && m !== "thumb_ref" && m !== "cover") return j({ ok: false, reason: "mode_not_allowed" }); // ★cover許可
        // ★案2-A: targetBlockId 指定時は既存ブロック更新なので pageId 不要。それ以外は従来通り。
        if ((m === "image" || m === "file" || m === "cover") && !pageId && !targetBlockId) return j({ ok: false, reason: "pageId_required" });
        const allowed = m === "file" ? FILE_TYPES : (m === "thumb_ref" ? THUMB_REF_TYPES : IMAGE_TYPES); // ★cover→else=IMAGE_TYPES(png/jpeg/webp)で画像許可
        if (!allowed.includes(ct)) return j({ ok: false, reason: "mode_content_type_mismatch" });
        const ticketId = crypto.randomUUID();
        const ttl = 120;
        const record = {
          fileName, contentType: ct, pageId, mode: m,
          placement: placement ?? null, anchorText: anchorText ?? null,
          deleteAnchor: deleteAnchor ?? null, headingText: headingText ?? null,
          targetBlockId: targetBlockId ?? null, afterBlockId: afterBlockId ?? null,
          parentId: parentId ?? null, caption: caption ?? null,
          used: false, exp: Date.now() + ttl * 1000,
        };
        await env.UPLOAD_TICKETS.put(ticketId, JSON.stringify(record), { expirationTtl: ttl });
        const uploadUrl = env.GATEWAY_UPLOAD_URL || "https://remote-mcp-server-authless.cloud-taku.workers.dev/upload";
        return j({ ok: true, uploadUrl, ticketId, expiresIn: ttl });
      },
    );

    // --- delete_block（★2026-06-28 §8: 既存Notion画像ブロック等を削除・案Y） ---
    // gateway は NOTION_TOKEN 非保持のため、UPLOAD_SVC(proceed-upload-test) を Service Binding 経由で
    // 代理実行（公開fetchはfallback＝DO内fetchなので可だが1042回避でSB優先）。
    // upload-test 側の ?action=delete_block&blockId=... が Notion API DELETE /v1/blocks/{id} を実行する。
    this.server.registerTool(
      "delete_block",
      { inputSchema: { blockId: z.string() } },
      async ({ blockId }) => {
        const env = this.env as any;
        const j = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
        if (!blockId) return j({ ok: false, error: "blockId required" });
        try {
          const u = UPLOAD_BASE + "/?action=delete_block&blockId=" + encodeURIComponent(blockId);
          const req = new Request(u, { method: "POST", headers: { "X-UPLOAD-TOKEN": env.UPLOAD_TOKEN || "" } });
          const res = env.UPLOAD_SVC ? await env.UPLOAD_SVC.fetch(req) : await fetch(req);
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok || data.ok !== true) {
            return j({ ok: false, step: "delete_block", status: res.status, error: data.error || "delete failed", detail: data.body ?? data.step });
          }
          return j({ ok: true, blockId, archived: data.archived ?? true });
        } catch (e) {
          return j({ ok: false, error: String(e) });
        }
      },
    );

    // --- list_blocks（★案2: ページ内の画像ブロックを再帰収集・差し替え対象の特定用） ---
    this.server.registerTool(
      "list_blocks",
      { inputSchema: { pageId: z.string() } },
      async ({ pageId }) => {
        const env = this.env as any;
        const j = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
        if (!pageId) return j({ ok: false, error: "pageId required" });
        try {
          const u = UPLOAD_BASE + "/?action=list_blocks&pageId=" + encodeURIComponent(pageId);
          const req = new Request(u, { method: "POST", headers: { "X-UPLOAD-TOKEN": env.UPLOAD_TOKEN || "" } });
          const res = env.UPLOAD_SVC ? await env.UPLOAD_SVC.fetch(req) : await fetch(req);
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok || data.ok !== true) {
            return j({ ok: false, step: "list_blocks", status: res.status, error: data.error || "list failed", detail: data.body ?? data.step });
          }
          return j(data);
        } catch (e) {
          return j({ ok: false, error: String(e) });
        }
      },
    );
  }
}

// --- /upload: チケット検証 → Service Binding経由で upload-test 代理 → 軽量JSON返却 ---
async function handleUpload(request: Request, env: any): Promise<Response> {
  const j = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
  // ★★ FILE_TYPES はモジュール定数を使用（pdf＋docx/xlsx/pptx）。ローカル二重定義は撤去。
  const MAX_SIZE = 20 * 1024 * 1024;
  try {
    if (!env.UPLOAD_TICKETS) return j({ ok: false, error: "KV UPLOAD_TICKETS not bound" }, 500);
    const ticketId = request.headers.get("X-TICKET") || new URL(request.url).searchParams.get("ticket") || "";
    if (!ticketId) return j({ ok: false, error: "missing ticket" }, 400);
    const raw = await env.UPLOAD_TICKETS.get(ticketId);
    if (!raw) return j({ ok: false, error: "ticket_invalid_or_expired" }, 401);
    const t = JSON.parse(raw);
    if (t.used) return j({ ok: false, error: "ticket_already_used" }, 401);
    if (Date.now() > t.exp) return j({ ok: false, error: "ticket_expired" }, 401);
    await env.UPLOAD_TICKETS.put(ticketId, JSON.stringify({ ...t, used: true }), { expirationTtl: 120 });
    const mode = t.mode || "image";
    if (mode !== "image" && mode !== "file" && mode !== "thumb_ref" && mode !== "cover") return j({ ok: false, reason: "mode_not_allowed" }, 400); // ★cover許可

    // ★J: thumb_ref＝参照画像を proceed-thumbnail /refupload へ転送し imageKey を返す（upload-test非経由・早期return／formDataは1回だけ）
    if (mode === "thumb_ref") {
      const form0 = await request.formData();
      const f = form0.get("file");
      if (!f || typeof f === "string") return j({ ok: false, error: "no file field" }, 400);
      const ft = ((f as File).type || "").toLowerCase();
      if (!THUMB_REF_TYPES.includes(ft)) return j({ ok: false, reason: "mode_content_type_mismatch" }, 400);
      if (t.contentType && t.contentType !== ft) return j({ ok: false, reason: "content_type_mismatch" }, 400);
      if (((f as File).size ?? 0) > 5 * 1024 * 1024) return j({ ok: false, reason: "file_too_large" }, 400);
      const buf = await (f as File).arrayBuffer();
      const refReq = new Request(THUMB_BASE + "/refupload", {
        method: "POST",
        headers: { "X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "", "Content-Type": ft },
        body: buf,
      });
      // ★既存/uploadと同じ作法：Service Binding優先・公開fetchはfallback（Worker間転送404対策）
      const rr = env.THUMB_SVC ? await env.THUMB_SVC.fetch(refReq) : await fetch(refReq);
      const via = env.THUMB_SVC ? "service_binding" : "public_fetch";
      const rtext = await rr.text();                       // ★診断: 失敗時に上流ボディを見る
      let rd: any = {}; try { rd = JSON.parse(rtext); } catch {}
      if (!rr.ok || rd.ok !== true) return j({ ok: false, step: "refupload", status: rr.status, error: rd.error || "refupload failed", via, upstreamBody: rtext.slice(0, 300) }, 502);
      return j({ ok: true, imageKey: rd.imageKey, size: rd.size, contentType: rd.contentType, via });
    }

    // ★cover は thumb_ref のような早期returnにせず、ここから先の通常 image/file 経路に乗せる（mode==="cover" は allowed=IMAGE_TYPES）
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return j({ ok: false, error: "no file field" }, 400);
    const fileType = ((file as File).type || "").toLowerCase();
    const fileSize = (file as File).size ?? 0;
    if (!fileType) return j({ ok: false, reason: "content_type_missing" }, 400);
    const allowed = mode === "file" ? FILE_TYPES : IMAGE_TYPES; // ★cover も image/thumb_ref と同じく IMAGE_TYPES 側
    if (!allowed.includes(fileType)) return j({ ok: false, reason: "mode_content_type_mismatch" }, 400);
    if (t.contentType && t.contentType !== fileType) return j({ ok: false, reason: "content_type_mismatch" }, 400);
    if (fileSize > MAX_SIZE) return j({ ok: false, reason: "file_too_large" }, 400);
    const fd = new FormData();
    fd.append("file", file, (file as File).name || t.fileName || "upload.bin");
    fd.append("pageId", t.pageId);
    fd.append("mode", mode); // ★cover はここで "cover" が proceed-upload-test へ転送される
    if (t.placement) fd.append("placement", t.placement);
    if (t.anchorText) fd.append("anchorText", t.anchorText);
    if (t.deleteAnchor !== null && t.deleteAnchor !== undefined) fd.append("deleteAnchor", String(t.deleteAnchor));
    if (t.headingText) fd.append("headingText", t.headingText);
    if (t.targetBlockId) fd.append("targetBlockId", t.targetBlockId); // ★案2-A
    if (t.afterBlockId) fd.append("afterBlockId", t.afterBlockId);    // ★案2-B
    if (t.parentId) fd.append("parentId", t.parentId);                // ★案2-B
    if (t.caption) fd.append("caption", t.caption);                   // ★案2-B
    // Service Binding 経由（公開URL非経由・内部直結→1042回避）。無ければURL fetchフォールバック。
    const upReq = new Request(UPLOAD_BASE + "/", { method: "POST", headers: { "X-UPLOAD-TOKEN": env.UPLOAD_TOKEN || "" }, body: fd });
    const upRes = env.UPLOAD_SVC ? await env.UPLOAD_SVC.fetch(upReq) : await fetch(upReq);
    const up: any = await upRes.json().catch(() => ({}));
    if (!upRes.ok || up.ok !== true) {
      return j({ ok: false, step: "upload", status: upRes.status, error: up.error || "upload failed",
        detail: up.step ? { step: up.step } : undefined }, 502);
    }
    return j({ ok: true, pageId: t.pageId, blockId: up.blockId ?? null,
      fileName: up.filename ?? t.fileName, size: up.size, attached: up.attached, placement: up.placement ?? null,
      action: up.action ?? null, targetBlockId: up.targetBlockId ?? null,
      beforeObjectPath: up.beforeObjectPath ?? null, afterObjectPath: up.afterObjectPath ?? null, changed: up.changed ?? null,
      file_upload_id: up.file_upload_id ?? null, parentId: up.parentId ?? null, afterBlockId: up.afterBlockId ?? null });
  } catch (e) {
    return j({ ok: false, error: String((e && (e as any).stack) || e) }, 500);
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return MyMCP.serve("/mcp").fetch(request, env, ctx);
    if (url.pathname === "/upload" && request.method === "POST") return handleUpload(request, env);
    return new Response("Not found", { status: 404 });
  },
};
