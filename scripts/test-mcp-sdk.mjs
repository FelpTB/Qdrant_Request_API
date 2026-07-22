/**
 * Testa o MCP nativo da API (POST /mcp) — Streamable HTTP via SDK oficial.
 *
 * Uso:
 *   node scripts/test-mcp-sdk.mjs
 *   node scripts/test-mcp-sdk.mjs "energia solar"
 *   MCP_URL=https://sua-api.up.railway.app/mcp node scripts/test-mcp-sdk.mjs
 *
 * Default: MCP_URL do .env, senão http://127.0.0.1:PORT/mcp
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = Number(process.env.PORT) || 3000;
const mcpUrl = process.env.MCP_URL?.trim() || `http://127.0.0.1:${port}/mcp`;
const query = process.argv.slice(2).join(" ").trim() || "energia solar";

async function main() {
  console.log("MCP_URL:", mcpUrl);
  console.log("query:", query);

  const client = new Client({ name: "qdrant-busca-mcp-sdk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  try {
    await client.connect(transport);
    console.log("connect: OK");
    console.log("server:", client.getServerVersion());

    const listed = await client.listTools();
    const tools = listed.tools || [];
    console.log(
      "tools:",
      tools.map((t) => ({
        name: t.name,
        props: Object.keys(t.inputSchema?.properties || {}),
      })),
    );

    if (tools.some((t) => t.name === "get_config")) {
      const cfg = await client.callTool({ name: "get_config", arguments: {} });
      const cfgText = (cfg.content || []).find((c) => c.type === "text")?.text || "";
      console.log("\n=== get_config ===");
      console.log(cfgText.slice(0, 900));
    }

    const searchTool = tools.find((t) => t.name === "search_text");
    if (!searchTool) {
      console.error("Tool search_text não encontrada");
      process.exit(1);
    }

    const args = { query, final_limit: 5 };
    console.log(`\n=== callTool search_text ===`);
    console.log("arguments:", args);

    const result = await client.callTool({ name: "search_text", arguments: args });
    const text = (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    console.log(text.slice(0, 3000));
    if (result.isError) {
      console.error("\nTool retornou isError");
      process.exit(1);
    }
    if (!/"results"\s*:/.test(text)) {
      console.error("\nResposta inesperada (sem results)");
      process.exit(1);
    }
    console.log("\nOK — MCP nativo respondeu com sucesso.");
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Erro:", err.message || err);
  process.exit(1);
});
