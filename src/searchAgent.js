import OpenAI from "openai";

const MODEL = process.env.LLM_SEARCH_AGENT_MODEL || process.env.LLM_RERANK_MODEL || "gpt-4o-mini";

let _client = null;
function getClient() {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
      const err = new Error("OPENAI_API_KEY não configurado; necessário para o agente de busca");
      err.status = 503;
      throw err;
    }
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normalizeWeights(raw, dimensionKeys, includeBm25) {
  const keys = includeBm25 ? [...dimensionKeys, "bm25"] : [...dimensionKeys];
  const out = {};
  let sum = 0;
  for (const k of keys) {
    const v = clamp01(raw?.[k]);
    out[k] = v;
    sum += v;
  }
  if (sum <= 0) {
    const eq = 1 / keys.length;
    for (const k of keys) out[k] = eq;
    return out;
  }
  for (const k of keys) out[k] = out[k] / sum;
  // arredonda e corrige residual no primeiro
  let s = 0;
  for (const k of keys) {
    out[k] = Number(out[k].toFixed(6));
    s += out[k];
  }
  out[keys[0]] = Number((out[keys[0]] + (1 - s)).toFixed(6));
  return out;
}

function buildAgentPrompt(userQuery, config, options = {}) {
  const dims = config.dimension_keys || [];
  const keyword = config.payload_keys || [];
  const fullText = config.payload_keys_full_text || [];
  const hasBm25 = Boolean(config.bm25?.vector_name);
  const finalLimit = options.final_limit ?? 10;

  return `Você é um agente de busca B2B de fornecedores. Sua única ação é montar os argumentos da tool MCP "search_text".

PEDIDO DO USUÁRIO:
"""${userQuery}"""

CONFIGURAÇÃO DA COLEÇÃO:
- Dimensões densas (vetores): ${JSON.stringify(dims)}
- Filtros keyword: ${JSON.stringify(keyword)}
- Filtros full-text: ${JSON.stringify(fullText)}
- BM25 disponível: ${hasBm25 ? `sim (vetor ${config.bm25.vector_name})` : "não"}

REGRAS:
1. Analise a intenção (produto vs serviço vs descrição/público) e distribua pesos nas dimensões densas${hasBm25 ? " + bm25" : ""}.
2. A soma de weights DEVE ser 1.0.
3. Em "queries", escreva texto otimizado POR dimensão (não copie a frase inteira cegamente). Dimensões irrelevantes podem repetir um texto curto genérico ou omitir (aí a API usa "query").
4. "query" = reformulação curta e clara do pedido para embedding geral.
5. "bm25_query" = termos lexicais/keywords (sem stopwords desnecessárias)${hasBm25 ? "" : " — se BM25 não existir, omita ou bm25:false"}.
6. Extraia filtros só quando explícitos (ex.: UF, cidade, modelo_negocio). Não invente filtros.
7. Use filter_not só para desambiguação clara.
8. final_limit padrão ${finalLimit}; limit_per_vector padrão 50.
9. rerank=true só se a query for ambígua ou pedir "melhores/mais relevantes".

Responda APENAS JSON válido:
{
  "reasoning": "explicação curta (2-4 frases) do plano de busca",
  "tool": "search_text",
  "arguments": {
    "query": "...",
    "queries": { ${dims.map((d) => `"${d}": "..."`).join(", ")} },
    "weights": { ${[...dims, ...(hasBm25 ? ["bm25"] : [])].map((d) => `"${d}": 0.0`).join(", ")} },
    "bm25_query": "...",
    "bm25": ${hasBm25 ? "true" : "false"},
    "filter": {},
    "filter_not": {},
    "limit_per_vector": 50,
    "final_limit": ${finalLimit},
    "rerank": false
  }
}`;
}

/**
 * Agente que planeja os argumentos da tool MCP search_text a partir da query do usuário.
 * @param {string} userQuery
 * @param {object} config - getPublicConfig()
 * @param {{ final_limit?: number }} [options]
 */
export async function planSearchToolCall(userQuery, config, options = {}) {
  const query = typeof userQuery === "string" ? userQuery.trim() : "";
  if (!query) {
    const err = new Error("Campo 'query' é obrigatório");
    err.status = 400;
    throw err;
  }

  const dimensionKeys = config.dimension_keys || [];
  const hasBm25 = Boolean(config.bm25?.vector_name);
  const allowedFilterKeys = [
    ...(config.payload_keys || []),
    ...(config.payload_keys_full_text || []),
  ];

  const client = getClient();
  const prompt = buildAgentPrompt(query, config, options);
  const started = Date.now();

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "Você planeja parâmetros para a tool MCP search_text. Responda somente JSON válido, sem markdown.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const raw = response.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error("Agente retornou JSON inválido");
    err.status = 502;
    throw err;
  }

  const argsIn = parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {};
  const toolQuery =
    typeof argsIn.query === "string" && argsIn.query.trim() ? argsIn.query.trim() : query;

  const queries = {};
  if (argsIn.queries && typeof argsIn.queries === "object") {
    for (const dim of dimensionKeys) {
      const v = argsIn.queries[dim];
      if (typeof v === "string" && v.trim()) queries[dim] = v.trim();
    }
  }

  const useBm25 = hasBm25 && argsIn.bm25 !== false;
  const weights = normalizeWeights(argsIn.weights, dimensionKeys, useBm25);

  const filter = {};
  if (argsIn.filter && typeof argsIn.filter === "object" && !Array.isArray(argsIn.filter)) {
    for (const [k, v] of Object.entries(argsIn.filter)) {
      if (!allowedFilterKeys.includes(k)) continue;
      if (v == null || v === "") continue;
      filter[k] = v;
    }
  }

  const filter_not = {};
  if (argsIn.filter_not && typeof argsIn.filter_not === "object" && !Array.isArray(argsIn.filter_not)) {
    for (const [k, v] of Object.entries(argsIn.filter_not)) {
      if (!allowedFilterKeys.includes(k)) continue;
      if (v == null || v === "") continue;
      filter_not[k] = v;
    }
  }

  const toolArguments = {
    query: toolQuery,
    weights,
    limit_per_vector:
      Number.isInteger(Number(argsIn.limit_per_vector)) && Number(argsIn.limit_per_vector) >= 1
        ? Number(argsIn.limit_per_vector)
        : 50,
    final_limit:
      Number.isInteger(Number(argsIn.final_limit)) && Number(argsIn.final_limit) >= 1
        ? Number(argsIn.final_limit)
        : options.final_limit ?? 10,
    rerank: Boolean(argsIn.rerank),
  };

  if (Object.keys(queries).length) toolArguments.queries = queries;
  if (Object.keys(filter).length) toolArguments.filter = filter;
  if (Object.keys(filter_not).length) toolArguments.filter_not = filter_not;

  if (useBm25) {
    toolArguments.bm25_query =
      typeof argsIn.bm25_query === "string" && argsIn.bm25_query.trim()
        ? argsIn.bm25_query.trim()
        : toolQuery;
  } else {
    toolArguments.bm25 = false;
  }

  return {
    model: MODEL,
    duration_ms: Date.now() - started,
    tokens_used: response.usage
      ? {
          prompt: response.usage.prompt_tokens,
          completion: response.usage.completion_tokens,
          total: response.usage.total_tokens,
        }
      : null,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    user_query: query,
    mcp_tool_call: {
      name: "search_text",
      arguments: toolArguments,
    },
  };
}

/**
 * Planeja via agente e executa a busca (mesma lógica da tool MCP search_text).
 */
export async function runAgentSearch({ userQuery, config, executeSearchByText, final_limit }) {
  const plan = await planSearchToolCall(userQuery, config, { final_limit });
  const searchStarted = Date.now();
  const search = await executeSearchByText(plan.mcp_tool_call.arguments);
  return {
    ...plan,
    search_duration_ms: Date.now() - searchStarted,
    search,
  };
}
