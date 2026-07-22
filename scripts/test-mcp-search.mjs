/**
 * Testa o MCP do n8n que empacota POST /search/text.
 *
 * Uso:
 *   node scripts/test-mcp-search.mjs
 *   node scripts/test-mcp-search.mjs "energia solar"
 *   node scripts/test-mcp-search.mjs --url https://.../mcp/mcp-busca "query"
 *
 * Variáveis: MCP_URL (ou --url). Preferir URL de produção (/mcp/...),
 * não a de teste (/mcp-test/...), que exige "Execute workflow" no n8n.
 */
import "dotenv/config";

const args = process.argv.slice(2);
const urlFlagIdx = args.indexOf("--url");
const mcpUrl =
  (urlFlagIdx >= 0 ? args[urlFlagIdx + 1] : null) ||
  process.env.MCP_URL?.trim() ||
  "";
const queryParts = args.filter((_, i) => {
  if (urlFlagIdx >= 0 && (i === urlFlagIdx || i === urlFlagIdx + 1)) return false;
  return true;
});
const query = queryParts.join(" ").trim() || "energia solar fotovoltaica";

if (!mcpUrl) {
  console.error("Defina MCP_URL no .env ou passe --url <url>");
  process.exit(1);
}

function parseRpcBody(text, contentType = "") {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (contentType.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.includes("\ndata:")) {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = dataLines.at(-1);
    if (!last) return { raw: trimmed };
    try {
      return JSON.parse(last);
    } catch {
      return { raw: trimmed, data: dataLines };
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

async function mcpRequest(sessionId, body) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const nextSession =
    res.headers.get("mcp-session-id") ||
    res.headers.get("Mcp-Session-Id") ||
    sessionId;

  return {
    status: res.status,
    ok: res.ok,
    sessionId: nextSession,
    contentType: res.headers.get("content-type") || "",
    body: parseRpcBody(text, res.headers.get("content-type") || ""),
    raw: text,
  };
}

function printStep(title, result) {
  console.log(`\n=== ${title} ===`);
  console.log(`HTTP ${result.status} | session=${result.sessionId || "(none)"}`);
  console.log(JSON.stringify(result.body, null, 2));
}

function suggestProductionUrl(url) {
  if (url.includes("/mcp-test/")) {
    return url.replace("/mcp-test/", "/mcp/");
  }
  return null;
}

async function main() {
  console.log(`MCP_URL: ${mcpUrl}`);
  console.log(`query:   ${query}`);

  if (mcpUrl.includes("/mcp-test/")) {
    console.warn(
      "\nAviso: URL de TESTE do n8n (/mcp-test/). Exige 'Execute workflow' no canvas e costuma servir só uma chamada.\n" +
        `Sugestão produção: ${suggestProductionUrl(mcpUrl)}`,
    );
  }

  // 1) initialize
  let sessionId = null;
  const init = await mcpRequest(sessionId, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "qdrant-busca-mcp-test", version: "1.0.0" },
    },
  });
  sessionId = init.sessionId;
  printStep("initialize", init);

  if (!init.ok) {
    if (init.status === 404 && String(init.raw).includes("not registered")) {
      console.error(
        "\nWebhook de teste não registrado. No n8n: abra o workflow, clique em Execute workflow, e rode de novo.\n" +
          "Ou use a URL de produção (/mcp/...) com o workflow ativo.",
      );
    }
    process.exit(1);
  }

  // 2) notifications/initialized (sem id)
  const notified = await mcpRequest(sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  printStep("notifications/initialized", notified);

  // 3) tools/list
  const listed = await mcpRequest(sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  printStep("tools/list", listed);

  const tools = listed.body?.result?.tools || [];
  if (!tools.length) {
    console.error("\nNenhuma tool exposta pelo MCP. Confira no n8n se há tool nodes ligados ao MCP Server Trigger.");
    process.exit(1);
  }

  console.log("\nTools disponíveis:");
  for (const t of tools) {
    console.log(`- ${t.name}: ${t.description || "(sem descrição)"}`);
  }

  // Escolhe a tool mais provável de busca
  const tool =
    tools.find((t) => /search|busca|text|query/i.test(t.name)) ||
    tools.find((t) => /search|busca|text|query/i.test(t.description || "")) ||
    tools[0];

  const props = tool.inputSchema?.properties || {};
  const propNames = Object.keys(props);
  const args = {};

  // Schema ideal: query / text / etc.
  if ("query" in props) args.query = query;
  else if ("q" in props) args.q = query;
  else if ("text" in props) args.text = query;
  else if ("input" in props) args.input = query;
  else if (propNames.some((p) => /^parameters\d+_Value$/.test(p))) {
    // Schema típico de HTTP Request comum ligado ao MCP (não é Tool node).
    // Preenche o 1º parâmetro com a query; demais com string vazia.
    console.warn(
      "\nSchema com parametersN_Value — indica HTTP Request comum, não uma Tool node.\n" +
        "No n8n, o MCP Server Trigger deve conectar a um nó da categoria Tools\n" +
        '(ex.: "HTTP Request Tool" ou "Call n8n Workflow Tool"), apontando para POST /search/text.',
    );
    for (const name of propNames) {
      args[name] = /^parameters0_Value$/.test(name) ? query : "";
    }
  } else {
    args.query = query;
  }

  if ("final_limit" in props) args.final_limit = 5;
  if ("limit" in props) args.limit = 5;

  console.log(`\nChamando tool: ${tool.name}`);
  console.log("inputSchema.properties:", propNames.join(", ") || "(vazio)");
  console.log("arguments:", JSON.stringify(args));

  // 4) tools/call
  const called = await mcpRequest(sessionId, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: tool.name,
      arguments: args,
    },
  });
  printStep(`tools/call (${tool.name})`, called);

  if (!called.ok || called.body?.error) {
    console.error("\nFalha no tools/call (JSON-RPC / HTTP).");
    process.exit(1);
  }

  const contentText = (called.body?.result?.content || [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  if (/does not have supplyData method/i.test(contentText)) {
    console.error(
      "\nDiagnóstico: o nó ligado ao MCP não é uma Tool node compatível.\n" +
        "Corrija no n8n:\n" +
        "  1. MCP Server Trigger\n" +
        '  2. Conecte um "HTTP Request Tool" (categoria Tools / AI)\n' +
        "  3. Method POST, URL .../search/text\n" +
        '  4. Body JSON com {"query": "{{ $fromAI(\'query\', \'texto da busca\') }}"}\n' +
        "  5. Ative o workflow e use a URL de produção (/mcp/...)\n" +
        "  6. Rode: npm run test:mcp -- \"energia solar\"",
    );
    process.exit(1);
  }

  if (/\"error\"/i.test(contentText) && !/\"results\"/i.test(contentText)) {
    console.error("\nA tool retornou erro no content. Veja o JSON acima.");
    process.exit(1);
  }

  console.log("\nOK — MCP respondeu com sucesso.");
}

main().catch((err) => {
  console.error("Erro:", err.message || err);
  process.exit(1);
});
