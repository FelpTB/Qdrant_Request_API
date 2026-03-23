import OpenAI from "openai";

const MODEL = process.env.LLM_RERANK_MODEL || "gpt-4o-mini";
const MAX_TOKENS = 500;

let _client = null;
function getClient() {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY não configurado para LLM re-ranking");
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

function buildCompanyLine(item, index) {
  const p = item.payload ?? {};
  const nome = p.nome_empresa ?? "N/A";
  const ind = p.industria ?? "N/A";
  const prod = p.produtos ?? p.produto ?? "";
  const serv = p.servicos ?? p.servico ?? "";
  const desc = (p.descricao ?? "").slice(0, 120);
  return `[${index + 1}] "${nome}" | Industria: ${ind} | Produtos: ${prod} | Servicos: ${serv} | Desc: ${desc}`;
}

function buildPrompt(query, bm25Query, items) {
  const lines = items.map((item, i) => buildCompanyLine(item, i));

  return `Você é um especialista em classificação de fornecedores B2B.

TAREFA: Dado o pedido de busca abaixo, reordene as ${items.length} empresas candidatas da MAIS relevante para a MENOS relevante.

BUSCA DO COMPRADOR: "${query}"
${bm25Query ? `TERMOS-CHAVE BM25: "${bm25Query}"` : ""}

EMPRESAS CANDIDATAS:
${lines.join("\n")}

REGRAS DE AVALIAÇÃO:
1. A empresa IDEAL fornece exatamente o que o comprador busca (produto ou serviço).
2. Priorize empresas cujos PRODUTOS ou SERVIÇOS correspondem diretamente à busca.
3. O campo "Industria" é muito discriminante — se a industria não tem relação com a busca, penalize fortemente.
4. Empresas que vendem algo SIMILAR mas não IGUAL devem ficar abaixo das que vendem o item exato.
5. Se a busca é por um SERVIÇO, empresas que vendem PRODUTOS (e vice-versa) devem ser penalizadas.

FORMATO DE RESPOSTA (apenas JSON, sem explicação):
{"ranking": [3, 1, 7, 2, ...]}

O array deve conter os números de 1 a ${items.length} na ordem de relevância (mais relevante primeiro).`;
}

/**
 * Re-ranks a pool of items using an LLM.
 * Returns the items reordered by LLM relevance judgment.
 *
 * @param {string} query - Original user query
 * @param {string|null} bm25Query - BM25 terms used
 * @param {Array} pool - Items to re-rank [{id, payload, score_final, ...}]
 * @returns {Promise<{reranked: Array, tokens_used: number, model: string}>}
 */
export async function llmRerank(query, bm25Query, pool) {
  if (!pool || pool.length === 0) {
    return { reranked: [], tokens_used: 0, model: MODEL };
  }

  if (pool.length <= 2) {
    return { reranked: [...pool], tokens_used: 0, model: MODEL };
  }

  const prompt = buildPrompt(query, bm25Query, pool);
  const client = getClient();

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: MAX_TOKENS,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const content = response.choices?.[0]?.message?.content ?? "{}";
  const tokensUsed = (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn("[llmRerank] Falha ao parsear resposta do LLM, mantendo ordem original:", content);
    return { reranked: [...pool], tokens_used: tokensUsed, model: MODEL };
  }

  const ranking = parsed.ranking;
  if (!Array.isArray(ranking)) {
    console.warn("[llmRerank] Resposta sem array 'ranking', mantendo ordem original");
    return { reranked: [...pool], tokens_used: tokensUsed, model: MODEL };
  }

  const reranked = [];
  const used = new Set();
  for (const idx of ranking) {
    const i = idx - 1;
    if (i >= 0 && i < pool.length && !used.has(i)) {
      reranked.push(pool[i]);
      used.add(i);
    }
  }

  for (let i = 0; i < pool.length; i++) {
    if (!used.has(i)) reranked.push(pool[i]);
  }

  return { reranked, tokens_used: tokensUsed, model: MODEL };
}
