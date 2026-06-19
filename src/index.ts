import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const UPLOAD_BASE = "https://proceed-upload-test.cloud-taku.workers.dev";
const THUMB_BASE = "https://proceed-thumbnail.cloud-taku.workers.dev";

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

		// --- generate_thumbnail（proceed-thumbnail を代理実行・dataUrl返却・token非露出） ---
		// D-1方針: スタッフ/Claude側にTHUMBNAIL_TOKENを出さない。
		//   - gateway内蔵Secretで proceed-thumbnail に POST / 代理実行
		//   - 候補確認のため dataUrl(base64) を返す
		//   - token付きURL(?token=...)は絶対に返さない。url/keyは初期は返さない
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

					// token付きURL/keyを除去し、dataUrlのみ候補として返す
					const images = (data.images || []).map((im: any) => ({
						index: im.index,
						dataUrl: im.dataUrl,
					}));

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: true,
										jobId: data.jobId,
										count: data.count,
										images,
										errors: data.errors,
									},
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
		// D-1方針: スタッフ/Claude側にTHUMBNAIL_TOKENを出さない。
		//   - gateway内蔵Secretで proceed-thumbnail に POST /adopt 代理実行
		//   - 採用index以外をR2から削除し、採用のみ残す
		//   - 返却は ok/keptKey/deleted のみ。adopt応答の url(?token=付き) は絶対に返さない
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
				const idx = Math.floor(index); // 本体が 1-based int を400で検証。ここは整数化のみ。

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

					// 本体: 成功 {ok:true,jobId,index,keptKey,url,deleted} / 失敗 {error,...}
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
											keptKey: data.keptKey,     // 404時に本体が返す
											available: data.available, // 404時に本体が返す
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

					// token付きurl(data.url)は除去。ok/keptKey/deleted のみ返す。
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: true,
										jobId: data.jobId,
										index: data.index,
										keptKey: data.keptKey,
										deleted: data.deleted,
									},
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
		// 非同期版。生成完了まで待たず jobId を即返す＝Remote MCP timeout回避。
		//   - gateway内蔵 THUMBNAIL_TOKEN で proceed-thumbnail に POST /start 代理実行
		//   - 返却は ok/jobId/status/count のみ（dataUrl等は返さない）
		this.server.registerTool(
			"start_thumbnail_job",
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
					const r = await fetch(THUMB_BASE + "/start", {
						method: "POST",
						headers: {
							"X-THUMBNAIL-TOKEN": env.THUMBNAIL_TOKEN || "",
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ prompt, count: n }),
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

		// --- check_thumbnail_job（proceed-thumbnail /check を代理実行・軽量プレビュー透過） ---
		// 生成状態を確認。done時のみ candidates[{index, previewDataUrl}] を返す。
		//   - previewDataUrl は本体が縮小済み（~24KB・token非露出）なのでそのまま透過
		//   - フルdataUrl・?token=付きURLは本体が返さない設計＝gatewayも透過で安全
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

					// candidates は {index, previewDataUrl} のみ透過（本体で軽量化・token非露出済み）
					const candidates = (data.candidates || []).map((c: any) => ({
						index: c.index,
						previewDataUrl: c.previewDataUrl,
					}));

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: true,
										jobId,
										status: data.status, // pending | done | failed
										candidates,
										errors: data.errors,
									},
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
		// 生成→採用後のフル（thumb/{jobId}/{index}.png）を Notion ページカバーに。
		//   ① gateway内蔵 THUMBNAIL_TOKEN で proceed-thumbnail の /img からフルbytes取得
		//   ② gateway内蔵 UPLOAD_TOKEN で proceed-upload-test へ multipart(mode=cover) 代理POST
		//   - 画像ソースはR2内なので base64 を Claude/スタッフに通さない（難所回避）
		//   - token（THUMBNAIL/UPLOAD）は一切返さない
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
					// ① thumbnail から採用フルを bytes 取得（内蔵 THUMBNAIL_TOKEN・ヘッダ認証）
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
					// 実体のContent-Typeに合わせる（thumbnailはJPEGを返すため image/png 固定は不整合）
					const ctype = imgRes.headers.get("content-type") || "image/png";
					const ext = ctype.includes("jpeg") || ctype.includes("jpg") ? "jpg" : "png";

					// ② proceed-upload-test へ multipart 中継（内蔵 UPLOAD_TOKEN・mode=cover）
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

					// token非露出。ok/attached/pageId/size のみ返す。
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
		// bash が uploadUrl へ multipart で file 直POST。pageId/mode/anchor はチケットに束縛（用途固定）。
		// ファイル本体は会話に載せない。
		//   - 許可contentType: image/png|jpeg|webp（mode=image）/ application/pdf（mode=file）
		//   - mode は image/file のみ（cover は upload_cover 専用・本ツールでは扱わない）
		//   - 発行時は申告contentTypeとmodeの整合を検証（サイズは実ファイルで /upload 側が判定）
		//   - TTL=120秒・used=false で発行。uploadUrl は env.GATEWAY_UPLOAD_URL 優先・無ければ現行URL。
		this.server.registerTool(
			"create_upload_ticket",
			{
				inputSchema: {
					fileName: z.string(),
					contentType: z.string(),
					pageId: z.string(),
					mode: z.enum(["image", "file"]).optional(),
					placement: z.enum(["top", "bottom"]).optional(),
					anchorText: z.string().optional(),
					deleteAnchor: z.boolean().optional(),
					headingText: z.string().optional(),
				},
			},
			async ({ fileName, contentType, pageId, mode, placement, anchorText, deleteAnchor, headingText }) => {
				const env = this.env as any;
				const j = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

				if (!env.UPLOAD_TICKETS) return j({ ok: false, error: "KV UPLOAD_TICKETS not bound" });

				const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
				const FILE_TYPES = ["application/pdf"];

				const m = mode ?? "image";
				const ct = (contentType || "").toLowerCase();

				// mode 制限（image/file のみ）
				if (m !== "image" && m !== "file") {
					return j({ ok: false, reason: "mode_not_allowed" });
				}
				// mode×contentType 整合
				const allowed = m === "file" ? FILE_TYPES : IMAGE_TYPES;
				if (!allowed.includes(ct)) {
					return j({ ok: false, reason: "mode_content_type_mismatch" });
				}

				const ticketId = crypto.randomUUID();
				const ttl = 120; // 秒（KV最小TTL=60）
				const record = {
					fileName,
					contentType: ct,
					pageId,
					mode: m,
					placement: placement ?? null,
					anchorText: anchorText ?? null,
					deleteAnchor: deleteAnchor ?? null,
					headingText: headingText ?? null,
					used: false,
					exp: Date.now() + ttl * 1000,
				};
				await env.UPLOAD_TICKETS.put(ticketId, JSON.stringify(record), { expirationTtl: ttl });

				// uploadUrl: env.GATEWAY_UPLOAD_URL 優先 → 無ければ現行URLにフォールバック
				// TODO: Cloudflare側に環境変数 GATEWAY_UPLOAD_URL を追加（フルURL・末尾 /upload）。
				const uploadUrl =
					env.GATEWAY_UPLOAD_URL || "https://remote-mcp-server-authless.cloud-taku.workers.dev/upload";

				return j({ ok: true, uploadUrl, ticketId, expiresIn: ttl });
			},
		);
	}
}

// --- /upload: チケット検証 → 実ファイル再検証 → 内蔵UPLOAD_TOKENで upload-test 代理 → 軽量JSON返却 ---
// bash から multipart(file) を直POST。pageId/mode/anchor はチケットから復元（用途固定）。
//   - 受付時点で used=true（1回限り）。失敗時も再利用不可＝再試行は新チケット発行。
//   - 再検証: mode（image/file）/ ticket.contentType / file.type / file.size / mode整合 を実ファイルで確認。
//   - 許可: image/png|jpeg|webp（mode=image）, application/pdf（mode=file）。上限20MB。
//   - file.type が空なら弾く（curl は -F "file=@x.png;type=image/png" のように type 付与前提）。
//   - 返却は {ok,pageId,blockId,fileName,size,attached,placement} のみ（base64/dataUrl/token非返却）。
async function handleUpload(request: Request, env: any): Promise<Response> {
	const j = (obj: any, status = 200) =>
		new Response(JSON.stringify(obj, null, 2), {
			status,
			headers: { "content-type": "application/json; charset=utf-8" },
		});

	const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
	const FILE_TYPES = ["application/pdf"];
	const MAX_SIZE = 20 * 1024 * 1024; // 20MB（画像・PDF共通）

	try {
		if (!env.UPLOAD_TICKETS) return j({ ok: false, error: "KV UPLOAD_TICKETS not bound" }, 500);

		const ticketId =
			request.headers.get("X-TICKET") || new URL(request.url).searchParams.get("ticket") || "";
		if (!ticketId) return j({ ok: false, error: "missing ticket" }, 400);

		const raw = await env.UPLOAD_TICKETS.get(ticketId);
		if (!raw) return j({ ok: false, error: "ticket_invalid_or_expired" }, 401);

		const t = JSON.parse(raw);
		if (t.used) return j({ ok: false, error: "ticket_already_used" }, 401);
		if (Date.now() > t.exp) return j({ ok: false, error: "ticket_expired" }, 401);

		// 1回限り：受付時点で used 化（失敗時も再利用不可＝再試行は新チケット）
		await env.UPLOAD_TICKETS.put(ticketId, JSON.stringify({ ...t, used: true }), { expirationTtl: 120 });

		const mode = t.mode || "image";
		// mode チェック（image/file 以外を弾く）
		if (mode !== "image" && mode !== "file") {
			return j({ ok: false, reason: "mode_not_allowed" }, 400);
		}

		const form = await request.formData();
		const file = form.get("file");
		if (!file || typeof file === "string") return j({ ok: false, error: "no file field" }, 400);

		const fileType = ((file as File).type || "").toLowerCase();
		const fileSize = (file as File).size ?? 0;

		// file.type 空は弾く（curl の ;type= 付与前提）
		if (!fileType) {
			return j({ ok: false, reason: "content_type_missing" }, 400);
		}
		// 実ファイル再検証① mode×contentType 整合（許可リスト）
		const allowed = mode === "file" ? FILE_TYPES : IMAGE_TYPES;
		if (!allowed.includes(fileType)) {
			return j({ ok: false, reason: "mode_content_type_mismatch" }, 400);
		}
		// 実ファイル再検証② チケット申告との一致（自己申告とのズレを弾く）
		if (t.contentType && t.contentType !== fileType) {
			return j({ ok: false, reason: "content_type_mismatch" }, 400);
		}
		// 実ファイル再検証③ サイズ上限
		if (fileSize > MAX_SIZE) {
			return j({ ok: false, reason: "file_too_large" }, 400);
		}

		// 用途固定値はチケットから。bash 側からは pageId/mode/anchor を受けない。
		const fd = new FormData();
		fd.append("file", file, (file as File).name || t.fileName || "upload.bin");
		fd.append("pageId", t.pageId);
		fd.append("mode", mode);
		if (t.placement) fd.append("placement", t.placement);
		if (t.anchorText) fd.append("anchorText", t.anchorText);
		if (t.deleteAnchor !== null && t.deleteAnchor !== undefined) fd.append("deleteAnchor", String(t.deleteAnchor));
		if (t.headingText) fd.append("headingText", t.headingText);

		const upRes = await fetch(UPLOAD_BASE + "/", {
			method: "POST",
			headers: { "X-UPLOAD-TOKEN": env.UPLOAD_TOKEN || "" },
			body: fd,
		});
		const up: any = await upRes.json().catch(() => ({}));

		if (!upRes.ok || up.ok !== true) {
			return j(
				{
					ok: false,
					step: "upload",
					status: upRes.status,
					error: up.error || "upload failed",
					detail: up.step ? { step: up.step } : undefined,
				},
				502,
			);
		}

		// 軽量JSONのみ返却（base64/dataUrl/UPLOAD_TOKENは返さない）
		return j({
			ok: true,
			pageId: t.pageId,
			blockId: up.blockId ?? null,
			fileName: up.filename ?? t.fileName,
			size: up.size,
			attached: up.attached,
			placement: up.placement ?? null,
		});
	} catch (e) {
		return j({ ok: false, error: String((e && (e as any).stack) || e) }, 500);
	}
}

export default {
	async fetch(request: Request, env: any, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		if (url.pathname === "/upload" && request.method === "POST") {
			return handleUpload(request, env);
		}

		return new Response("Not found", { status: 404 });
	},
};
