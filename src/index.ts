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
										status: data.status,
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

				if (m !== "image" && m !== "file") {
					return j({ ok: false, reason: "mode_not_allowed" });
				}
				const allowed = m === "file" ? FILE_TYPES : IMAGE_TYPES;
				if (!allowed.includes(ct)) {
					return j({ ok: false, reason: "mode_content_type_mismatch" });
				}

				const ticketId = crypto.randomUUID();
				const ttl = 120;
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

				const uploadUrl =
					env.GATEWAY_UPLOAD_URL || "https://remote-mcp-server-authless.cloud-taku.workers.dev/upload";

				return j({ ok: true, uploadUrl, ticketId, expiresIn: ttl });
			},
		);
	}
}

// --- /upload: チケット検証 → Service Binding経由で upload-test 代理 → 軽量JSON返却 ---
// Service Binding(UPLOAD_SVC)で内部直結し error code:1042 を回避。env.UPLOAD_SVC が無い時はURL fetchにフォールバック。
async function handleUpload(request: Request, env: any): Promise<Response> {
	const j = (obj: any, status = 200) =>
		new Response(JSON.stringify(obj, null, 2), {
			status,
			headers: { "content-type": "application/json; charset=utf-8" },
		});

	const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
	const FILE_TYPES = ["application/pdf"];
	const MAX_SIZE = 20 * 1024 * 1024;

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

		await env.UPLOAD_TICKETS.put(ticketId, JSON.stringify({ ...t, used: true }), { expirationTtl: 120 });

		const mode = t.mode || "image";
		if (mode !== "image" && mode !== "file") return j({ ok: false, reason: "mode_not_allowed" }, 400);

		const form = await request.formData();
		const file = form.get("file");
		if (!file || typeof file === "string") return j({ ok: false, error: "no file field" }, 400);

		const fileType = ((file as File).type || "").toLowerCase();
		const fileSize = (file as File).size ?? 0;

		if (!fileType) return j({ ok: false, reason: "content_type_missing" }, 400);
		const allowed = mode === "file" ? FILE_TYPES : IMAGE_TYPES;
		if (!allowed.includes(fileType)) return j({ ok: false, reason: "mode_content_type_mismatch" }, 400);
		if (t.contentType && t.contentType !== fileType) return j({ ok: false, reason: "content_type_mismatch" }, 400);
		if (fileSize > MAX_SIZE) return j({ ok: false, reason: "file_too_large" }, 400);

		const fd = new FormData();
		fd.append("file", file, (file as File).name || t.fileName || "upload.bin");
		fd.append("pageId", t.pageId);
		fd.append("mode", mode);
		if (t.placement) fd.append("placement", t.placement);
		if (t.anchorText) fd.append("anchorText", t.anchorText);
		if (t.deleteAnchor !== null && t.deleteAnchor !== undefined) fd.append("deleteAnchor", String(t.deleteAnchor));
		if (t.headingText) fd.append("headingText", t.headingText);

		// Service Binding 経由（公開URLを経由せず内部直結 → 1042回避）。無ければURL fetchにフォールバック。
		const upReq = new Request(UPLOAD_BASE + "/", {
			method: "POST",
			headers: { "X-UPLOAD-TOKEN": env.UPLOAD_TOKEN || "" },
			body: fd,
		});
		const upRes = env.UPLOAD_SVC ? await env.UPLOAD_SVC.fetch(upReq) : await fetch(upReq);

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
