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

		// --- 追加: probe_workers（課金ゼロの到達＋認証プローブ・代理実行） ---
		// ゲートウェイのSecret(UPLOAD_TOKEN / THUMBNAIL_TOKEN)を使い、両Workerへ
		// 「到達」と「認証通過(必須フィールド不足で即400)」だけ確認。生成もアップも走らない＝課金ゼロ。
		this.server.registerTool(
			"probe_workers",
			{ inputSchema: {} },
			async () => {
				const env = this.env as any;
				const out: any = {};

				// 1) upload-test 到達 (GET → 200 期待)
				try {
					const r = await fetch(UPLOAD_BASE + "/", { method: "GET" });
					out.upload_get = { status: r.status };
				} catch (e) {
					out.upload_get = { error: String(e) };
				}

				// 2) upload-test 認証通過 (POST + 正規トークン + fileなし → 400 no file field 期待)
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

				// 3) thumbnail 到達 (GET → 405 POST only 期待)
				try {
					const r = await fetch(THUMB_BASE + "/", { method: "GET" });
					out.thumb_get = { status: r.status };
				} catch (e) {
					out.thumb_get = { error: String(e) };
				}

				// 4) thumbnail 認証通過 (POST + 正規トークン + {} → 400 prompt required 期待)
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
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
