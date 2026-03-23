import express from "express";
import { multiVectorSearch } from "./multiVectorSearch.js";
import { llmRerank } from "./llmRerank.js";
import qdrantClient from "./qdrantClient.js";
import { normalizePointsInput, upsertPointsBatch } from "./upsertPoints.js";
import { markAsVectorized } from "./markVectorized.js";
import { isDbConfigured } from "./db.js";
import { logSuccess, logError } from "./logger.js";
import { getPipelineState, runPipeline } from "./pipeline.js";
import { getDashboardHtml } from "./dashboardHtml.js";
import { normalizeKeyword } from "./normalizeKeyword.js";
import "dotenv/config";

const app = express();
const COLLECTION_NAME = process.env.COLLECTION_NAME;

const ENDPOINT_UPSERT = "POST /points/upsert";
const ENDPOINT_MARK_VECTORIZED = "POST /company-profiles/mark-vectorized";

/** POST /points/upsert usa body grande (lista de pontos); parser próprio antes do global. */
app.post(
  "/points/upsert",
  express.json({ limit: process.env.UPSERT_BODY_LIMIT || "50mb" }),
  async (req, res) => {
    if (!COLLECTION_NAME) {
      return res.status(500).json({ error: "COLLECTION_NAME não configurado no ambiente" });
    }
    const { points: rawPoints, batch_size: batchSize } = req.body || {};
    const body = Array.isArray(rawPoints) ? rawPoints : req.body;
    const normalized = normalizePointsInput(body);
    if (normalized.error) {
      return res.status(400).json({ error: normalized.error });
    }
    if (normalized.points.length === 0) {
      return res.status(400).json({ error: "Nenhum ponto para inserir" });
    }
    const start = Date.now();
    try {
      const size = batchSize != null ? Math.max(1, Math.min(1000, Number(batchSize))) : undefined;
      const result = await upsertPointsBatch({
        collectionName: COLLECTION_NAME,
        points: normalized.points,
        batchSize: size,
        wait: true,
        concurrency: 1,
      });
      logSuccess(ENDPOINT_UPSERT, "Inserção no Qdrant concluída", {
        collection: COLLECTION_NAME,
        upserted: result.upserted,
        batches: result.batches,
        duration_ms: Date.now() - start,
      });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json({ ok: true, ...result });
    } catch (err) {
      const status = err.status ?? err.statusCode ?? 500;
      const qdrantMsg = status === 400 && err.data?.status?.error ? err.data.status.error : null;
      const message = qdrantMsg || (err.batchIndex != null
        ? `Falha na inserção no Qdrant: lote ${err.batchIndex}/${err.totalBatches}. ${err.message || "Erro desconhecido"}`
        : `Falha na inserção no Qdrant: ${err.message || "Erro desconhecido"}`);
      logError(ENDPOINT_UPSERT, "Inserção no Qdrant falhou", err, {
        collection: COLLECTION_NAME,
        batch_index: err.batchIndex,
        total_batches: err.totalBatches,
        status,
        qdrant_error: err.data?.status?.error,
      });
      return res.status(status).json({ error: message });
    }
  }
);

app.use(express.json({ limit: "2mb" }));

/** Marca perfis como vetorizados no PostgreSQL (qdrant = true) por lista de CNPJ. Resposta síncrona ao fim da atualização. */
app.post("/company-profiles/mark-vectorized", async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({
      error: "DB_URL não configurado; não é possível atualizar company_profile",
    });
  }
  const body = req.body;
  const cnpjs = Array.isArray(body) ? body : (body && body.cnpjs);
  if (!Array.isArray(cnpjs)) {
    return res.status(400).json({
      error: "Body deve ser um array de CNPJ ou um objeto { cnpjs: string[] }",
    });
  }
  const start = Date.now();
  try {
    const result = await markAsVectorized(cnpjs);
    logSuccess(ENDPOINT_MARK_VECTORIZED, "Atualização no banco concluída", {
      cnpjs_recebidos: cnpjs.length,
      updated: result.updated,
      chunks: result.chunks,
      concurrency: result.concurrency,
      duration_ms: Date.now() - start,
    });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json({
      ok: true,
      message: "Perfis marcados como vetorizados. Pode prosseguir com a próxima leva.",
      ...result,
    });
  } catch (err) {
    const status = err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" ? 503
      : err.code === "ETIMEDOUT" ? 504
      : err.status ?? err.statusCode ?? 500;
    const message = err.message || "Falha ao atualizar banco de dados (company_profile.qdrant)";
    const detail = err.chunkIndex != null
      ? ` Chunk ${err.chunkIndex}/${err.totalChunks} (${err.cnpjsInChunk} CNPJs).`
      : "";
    logError(ENDPOINT_MARK_VECTORIZED, "Atualização no banco falhou", err, {
      cnpjs_count: cnpjs.length,
      chunk_index: err.chunkIndex,
      total_chunks: err.totalChunks,
      pg_code: err.code,
      status,
    });
    return res.status(status).json({ error: message + detail });
  }
});

/** Chaves das dimensões da API (env QDRANT_DIMENSION_KEYS). Padrão: segmento,produtos,clientes. Para 5 vetores: ex. capacidades,produtos,clientes,descricao,servico. */
function getDimensionKeys() {
  const env = process.env.QDRANT_DIMENSION_KEYS;
  if (env && typeof env === "string") {
    const keys = env.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length >= 1) return keys;
  }
  return ["segmento", "produtos", "clientes"];
}

/** Mapeamento chave da API → nome do vetor na coleção Qdrant. QDRANT_VECTOR_NAMES deve ter o mesmo número de nomes que QDRANT_DIMENSION_KEYS (ordem 1:1). */
function getVectorNamesMap() {
  const dimensionKeys = getDimensionKeys();
  const env = process.env.QDRANT_VECTOR_NAMES;
  if (env && typeof env === "string") {
    const names = env.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === dimensionKeys.length) {
      const map = {};
      dimensionKeys.forEach((key, i) => { map[key] = names[i]; });
      return map;
    }
  }
  const defaultNames = ["v_segmento", "v_produtos", "v_clientes"];
  const map = {};
  dimensionKeys.forEach((key, i) => {
    map[key] = (defaultNames.length === dimensionKeys.length && defaultNames[i]) ? defaultNames[i] : `v_${key}`;
  });
  return map;
}

/** Chaves de payload permitidas para filtro keyword (env QDRANT_PAYLOAD_KEYS). Se vazio, usa as chaves keyword do esquema da coleção. */
const DEFAULT_PAYLOAD_KEYS = ["modelo_negocio", "cidade", "uf", "nome_empresa", "cnpj"];

function getAllowedPayloadKeys() {
  const env = process.env.QDRANT_PAYLOAD_KEYS;
  if (env && typeof env === "string") {
    const keys = env.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length > 0) return keys;
  }
  return DEFAULT_PAYLOAD_KEYS;
}

/** Chaves de payload com índice full-text no Qdrant (env QDRANT_PAYLOAD_KEYS_TEXT). Usadas em filter com match.text. Se vazio, nenhum filtro full-text. */
const DEFAULT_PAYLOAD_KEYS_TEXT = ["descricao", "endereco", "publico", "site", "email", "certificacoes"];

function getFullTextPayloadKeys() {
  const env = process.env.QDRANT_PAYLOAD_KEYS_TEXT;
  if (env && typeof env === "string") {
    const keys = env.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length > 0) return keys;
  }
  return DEFAULT_PAYLOAD_KEYS_TEXT;
}

/** Todas as chaves permitidas para filter/filter_not: keyword + full-text (sem duplicatas). */
function getAllowedFilterKeys() {
  const keyword = getAllowedPayloadKeys();
  const text = getFullTextPayloadKeys();
  const set = new Set([...keyword, ...text]);
  return [...set];
}

/** Lista de chaves de payload usadas para construir o vetor BM25 (env QDRANT_BM25_PAYLOAD_KEYS, opcional). */
function getBm25PayloadKeys() {
  const env = process.env.QDRANT_BM25_PAYLOAD_KEYS;
  if (!env || typeof env !== "string") return [];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

function normalizeWeights(weights, dimensionKeys, includeBm25 = false) {
  if (!weights || typeof weights !== "object" || !Array.isArray(dimensionKeys)) return null;
  const w = {};
  for (const dim of dimensionKeys) {
    const v = Number(weights[dim]);
    if (Number.isNaN(v)) return null;
    w[dim] = v;
  }
  if (includeBm25) {
    const v = Number(weights.bm25);
    if (Number.isNaN(v) || v < 0) return null;
    w.bm25 = v;
  }
  return w;
}

function sumWeights(w) {
  return Object.values(w).reduce((a, b) => a + b, 0);
}

function isValidVector(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "number" && !Number.isNaN(x));
}

/**
 * Converte filtro simples { chave: valor | valor[] } em formato Qdrant.
 * Apenas chaves presentes em allowedKeys são aceitas.
 * Valores vazios ou só espaços (" ") são ignorados.
 *
 * Semântica:
 * - valor escalar → match: { value } (campo = valor).
 * - array de valores → should: [ match value, ... ] (campo = QUALQUER UM da lista, OR).
 *   Ex.: uf: ["RJ", "SP", "MG"] → empresas cuja uf é RJ OU SP OU MG.
 * - string com vírgulas é convertida em array: uf: "SP,RJ" → ["SP", "RJ"] (OR).
 * - Várias chaves no filter → must: [ cond1, cond2 ] (AND entre chaves).
 *
 * Usamos "should" + vários "match value" em vez de "match.any" para máxima compatibilidade com o Qdrant.
 */
function isFilterValueEmpty(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** Normaliza valor do filtro: string "SP,RJ" vira array ["SP", "RJ"] para tratar como OR. */
function normalizeFilterValue(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.includes(",")) {
    const arr = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
    return arr.length === 0 ? null : arr.length === 1 ? arr[0] : arr;
  }
  return value;
}

/** Chaves de payload cujos valores são normalizados (maiúsculas, sem acentos) no filtro. modelo_negocio fica como recebido. */
const FILTER_KEYS_NORMALIZE = ["cidade", "uf"];

/**
 * Constrói o filtro Qdrant.
 * - Chaves em fullTextKeys → match.text (full-text no Qdrant); valor string ou array unido por espaço.
 * - Chaves em keywordKeys → match.value / match.any (keyword).
 */
function buildQdrantFilter(payloadFilter, keywordKeys, fullTextKeys = []) {
  if (!payloadFilter || typeof payloadFilter !== "object") return null;
  const must = [];
  for (const [key, value] of Object.entries(payloadFilter)) {
    const raw = value;
    if (raw === undefined || raw === null) continue;

    if (fullTextKeys.includes(key)) {
      const textQuery = Array.isArray(raw)
        ? raw.filter((v) => !isFilterValueEmpty(v)).map(String).join(" ").trim()
        : typeof raw === "string" ? raw.trim() : String(raw).trim();
      if (!textQuery) continue;
      must.push({ key, match: { text: textQuery } });
      continue;
    }

    if (!keywordKeys.includes(key)) continue;
    const valueNorm = normalizeFilterValue(raw);
    if (valueNorm === undefined || valueNorm === null) continue;
    const normalize = (v) =>
      typeof v === "string" && FILTER_KEYS_NORMALIZE.includes(key) ? normalizeKeyword(v) : v;
    if (Array.isArray(valueNorm)) {
      const values = valueNorm.filter(
        (v) =>
          !isFilterValueEmpty(v) &&
          (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      );
      if (values.length === 0) continue;
      const normalized = values.map((v) => normalize(v));
      if (normalized.length === 1) {
        must.push({ key, match: { value: normalized[0] } });
      } else {
        must.push({ key, match: { any: normalized } });
      }
    } else {
      if (isFilterValueEmpty(valueNorm)) continue;
      must.push({ key, match: { value: normalize(valueNorm) } });
    }
  }
  return must.length > 0 ? { must } : null;
}

/**
 * Constrói o filtro negativo Qdrant (must_not).
 * Chaves em fullTextKeys usam match.text; chaves em keywordKeys usam match.value / match.any.
 */
function buildQdrantFilterNot(payloadFilterNot, keywordKeys, fullTextKeys = []) {
  if (!payloadFilterNot || typeof payloadFilterNot !== "object") return null;
  const must_not = [];
  for (const [key, value] of Object.entries(payloadFilterNot)) {
    const raw = value;
    if (raw === undefined || raw === null) continue;

    if (fullTextKeys.includes(key)) {
      const textQuery = Array.isArray(raw)
        ? raw.filter((v) => !isFilterValueEmpty(v)).map(String).join(" ").trim()
        : typeof raw === "string" ? raw.trim() : String(raw).trim();
      if (!textQuery) continue;
      must_not.push({ key, match: { text: textQuery } });
      continue;
    }

    if (!keywordKeys.includes(key)) continue;
    const valueNorm = normalizeFilterValue(raw);
    if (valueNorm === undefined || valueNorm === null) continue;
    const normalize = (v) =>
      typeof v === "string" && FILTER_KEYS_NORMALIZE.includes(key) ? normalizeKeyword(v) : v;
    if (Array.isArray(valueNorm)) {
      const values = valueNorm.filter(
        (v) =>
          !isFilterValueEmpty(v) &&
          (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      );
      if (values.length === 0) continue;
      const normalized = values.map((v) => normalize(v));
      if (normalized.length === 1) {
        must_not.push({ key, match: { value: normalized[0] } });
      } else {
        must_not.push({ key, match: { any: normalized } });
      }
    } else {
      if (isFilterValueEmpty(valueNorm)) continue;
      must_not.push({ key, match: { value: normalize(valueNorm) } });
    }
  }
  return must_not.length > 0 ? { must_not } : null;
}

/** Mescla filtro positivo (must) com filtro negativo (must_not) para enviar ao Qdrant. */
function mergeQdrantFilter(positive, negative) {
  const hasPositive = positive && (positive.must?.length > 0 || positive.should?.length > 0);
  const hasNegative = negative && negative.must_not?.length > 0;
  if (!hasPositive && !hasNegative) return null;
  const out = {};
  if (hasPositive) {
    if (positive.must?.length) out.must = positive.must;
    if (positive.should?.length) out.should = positive.should;
  }
  if (hasNegative) out.must_not = negative.must_not;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Predicados de exclusão para pós-processamento: o Qdrant pode não aplicar must_not com match.text.
 * Retorna array de funções (payload) => true se o ponto deve ser excluído.
 * Full-text: termos são verificados em TODOS os campos full-text do payload (descricao, endereco, publico, etc.).
 * Keyword: cada chave aplica apenas ao seu campo (match exato).
 */
function buildFilterNotPredicates(payloadFilterNot, keywordKeys, fullTextKeys = []) {
  if (!payloadFilterNot || typeof payloadFilterNot !== "object") return [];
  const predicates = [];
  const allFullTextTerms = new Set();

  for (const [key, value] of Object.entries(payloadFilterNot)) {
    const raw = value;
    if (raw === undefined || raw === null || isFilterValueEmpty(raw)) continue;

    if (fullTextKeys.includes(key)) {
      const textQuery = Array.isArray(raw)
        ? raw.filter((v) => !isFilterValueEmpty(v)).map(String).join(" ").trim()
        : typeof raw === "string" ? raw.trim() : String(raw).trim();
      if (!textQuery) continue;
      textQuery.split(/\s+/).filter(Boolean).forEach((t) => allFullTextTerms.add(t.toLowerCase()));
      continue;
    }

    if (!keywordKeys.includes(key)) continue;
    const valueNorm = normalizeFilterValue(raw);
    if (valueNorm === undefined || valueNorm === null) continue;
    const normalize = (v) =>
      typeof v === "string" && FILTER_KEYS_NORMALIZE.includes(key) ? normalizeKeyword(v) : (v != null ? String(v).trim() : "");
    const values = Array.isArray(valueNorm)
      ? valueNorm.filter(
          (v) =>
            !isFilterValueEmpty(v) &&
            (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        ).map(normalize)
      : [normalize(valueNorm)];
    if (values.length === 0) continue;
    const valueSet = new Set(values);
    predicates.push((payload) => {
      const pv = payload?.[key];
      const norm = normalize(pv);
      return valueSet.has(norm);
    });
  }

  if (allFullTextTerms.size > 0 && fullTextKeys.length > 0) {
    const terms = [...allFullTextTerms];
    predicates.push((payload) => {
      for (const key of fullTextKeys) {
        const text = String(payload?.[key] ?? "").toLowerCase();
        if (terms.some((term) => text.includes(term))) return true;
      }
      return false;
    });
  }

  return predicates;
}
function validateSearchBody(body) {
  if (!body || typeof body !== "object")
    return { status: 400, message: "Request body inválido" };

  const { vectors, weights, limit_per_vector, final_limit, filter, filter_not, bm25_query } = body;
  const dimensionKeys = getDimensionKeys();
  const useBm25 = bm25_query != null && bm25_query !== undefined;

  if (useBm25) {
    if (typeof bm25_query !== "string")
      return { status: 400, message: "Campo 'bm25_query' deve ser uma string" };
    const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim();
    if (!bm25VectorName)
      return { status: 400, message: "Para usar BM25 configure QDRANT_BM25_VECTOR_NAME no ambiente (nome do vetor esparso da coleção)" };
  }
  const allowedFilterKeys = getAllowedFilterKeys();
  if (filter != null && filter !== undefined) {
    if (typeof filter !== "object" || Array.isArray(filter))
      return { status: 400, message: "Campo 'filter' deve ser um objeto" };
    if (allowedFilterKeys.length === 0)
      return { status: 400, message: "Configure QDRANT_PAYLOAD_KEYS e/ou QDRANT_PAYLOAD_KEYS_TEXT no ambiente para usar filtros" };
    const invalidKeys = Object.keys(filter).filter((k) => !allowedFilterKeys.includes(k));
    if (invalidKeys.length > 0)
      return { status: 400, message: `Chaves de filtro não permitidas: ${invalidKeys.join(", ")}. Permitidas: ${allowedFilterKeys.join(", ")}` };
  }
  if (filter_not != null && filter_not !== undefined) {
    if (typeof filter_not !== "object" || Array.isArray(filter_not))
      return { status: 400, message: "Campo 'filter_not' deve ser um objeto" };
    if (allowedFilterKeys.length === 0)
      return { status: 400, message: "Configure QDRANT_PAYLOAD_KEYS e/ou QDRANT_PAYLOAD_KEYS_TEXT no ambiente para usar filtros negativos (filter_not)" };
    const invalidKeys = Object.keys(filter_not).filter((k) => !allowedFilterKeys.includes(k));
    if (invalidKeys.length > 0)
      return { status: 400, message: `Chaves de filter_not não permitidas: ${invalidKeys.join(", ")}. Permitidas: ${allowedFilterKeys.join(", ")}` };
  }

  if (!vectors || typeof vectors !== "object")
    return { status: 400, message: "Campo 'vectors' é obrigatório" };

  for (const dim of dimensionKeys) {
    if (!(dim in vectors))
      return { status: 400, message: `Vetor ausente: '${dim}'` };
    if (!isValidVector(vectors[dim]))
      return { status: 400, message: `Vetor '${dim}' inválido ou dimensões incorretas` };
  }

  const firstDim = dimensionKeys[0];
  const dimLength = vectors[firstDim].length;
  for (let i = 1; i < dimensionKeys.length; i++) {
    if (vectors[dimensionKeys[i]].length !== dimLength)
      return { status: 400, message: "Dimensões dos vetores devem coincidir" };
  }

  const w = normalizeWeights(weights, dimensionKeys, useBm25);
  if (!w)
    return { status: 400, message: useBm25
      ? `Campo 'weights' inválido. Chaves esperadas: ${dimensionKeys.join(", ")}, bm25 (soma = 1.0)`
      : `Campo 'weights' inválido. Chaves esperadas: ${dimensionKeys.join(", ")} (soma = 1.0)` };
  const sum = sumWeights(w);
  if (Math.abs(sum - 1) > 1e-6)
    return { status: 400, message: "Soma dos pesos (densos + bm25 quando usado) deve ser 1.0" };

  const limitPerVector = Number(limit_per_vector);
  const finalLimit = Number(final_limit);
  if (!Number.isInteger(limitPerVector) || limitPerVector < 1)
    return { status: 400, message: "limit_per_vector deve ser um inteiro >= 1" };
  if (!Number.isInteger(finalLimit) || finalLimit < 1)
    return { status: 400, message: "final_limit deve ser um inteiro >= 1" };

  return null;
}

app.post("/search", async (req, res) => {
  const validationError = validateSearchBody(req.body);
  if (validationError) {
    return res.status(validationError.status).json({ error: validationError.message });
  }

  if (!COLLECTION_NAME) {
    return res.status(500).json({ error: "COLLECTION_NAME não configurado no ambiente" });
  }

  const { vectors, weights, limit_per_vector, final_limit, filter, filter_not, bm25_query, query_text } = req.body;
  const dimensionKeys = getDimensionKeys();
  const useBm25 = bm25_query != null && bm25_query !== "";
  const w = normalizeWeights(weights, dimensionKeys, useBm25);
  const keywordKeys = getAllowedPayloadKeys();
  const fullTextKeys = getFullTextPayloadKeys();
  const qdrantFilterPositive = buildQdrantFilter(filter, keywordKeys, fullTextKeys);
  const qdrantFilterNegative = buildQdrantFilterNot(filter_not, keywordKeys, fullTextKeys);
  const qdrantFilter = mergeQdrantFilter(qdrantFilterPositive, qdrantFilterNegative);
  const filterNotPredicates = buildFilterNotPredicates(filter_not, keywordKeys, fullTextKeys);

  const vectorsForSearch = {};
  for (const dim of dimensionKeys) vectorsForSearch[dim] = vectors[dim];
  const debugMode = req.query.debug === "1";
  const rerankMode = req.query.rerank === "1" || req.body.rerank === true;

  try {
    const out = await multiVectorSearch({
      vectors: vectorsForSearch,
      weights: w,
      vectorNamesMap: getVectorNamesMap(),
      limitPerVector: limit_per_vector,
      finalLimit: final_limit,
      collectionName: COLLECTION_NAME,
      filter: qdrantFilter,
      filterNotPredicates,
      bm25Query: typeof bm25_query === "string" ? bm25_query : null,
      returnDebugCounts: debugMode,
    });

    const searchResults = debugMode ? out.results : (out.results ?? out);
    const llmPool = out.llm_rerank_pool ?? [];
    const restPool = out.rest_after_pool ?? [];

    let finalResults = searchResults;
    let rerankInfo = null;

    if (rerankMode && llmPool.length > 0) {
      const queryForRerank = typeof query_text === "string" && query_text.trim()
        ? query_text.trim()
        : typeof bm25_query === "string" ? bm25_query.trim() : "";

      if (queryForRerank) {
        try {
          const { reranked, tokens_used, model } = await llmRerank(
            queryForRerank,
            typeof bm25_query === "string" ? bm25_query : null,
            llmPool
          );
          finalResults = [...reranked, ...restPool].slice(0, final_limit);
          rerankInfo = {
            enabled: true,
            model,
            tokens_used,
            pool_size: llmPool.length,
            query_used: queryForRerank,
          };
        } catch (rerankErr) {
          console.error("[rerank] LLM re-ranking falhou, usando ordem original:", rerankErr.message);
          rerankInfo = { enabled: true, error: rerankErr.message, fallback: "original_order" };
        }
      }
    }

    const formattedResults = finalResults.map((item, index) => ({
      posicao: index + 1,
      id: item.id,
      score_final: item.score_final,
      score_rrf: item.score_rrf,
      scores: item.scores,
      paths: item.paths,
      in_both: item.in_both,
      payload: item.payload,
    }));

    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (debugMode && out.debug) {
      out.debug.filter_sent = qdrantFilter;
      out.debug.weights_used = w;
      return res.json({
        results: formattedResults,
        rerank: rerankInfo,
        debug: out.debug,
      });
    }

    const response = { results: formattedResults };
    if (rerankInfo) response.rerank = rerankInfo;
    return res.json(response);
  } catch (err) {
    const status = err.status ?? err.statusCode ?? 500;
    const message =
      status === 400 && err.data?.status?.error
        ? err.data.status.error
        : "Erro no banco vetorial (busca Qdrant)";
    logError("POST /search", "Busca vetorial falhou", err, {
      collection: COLLECTION_NAME,
      status,
      qdrant_error: err.data?.status?.error,
    });
    return res.status(status).json({ error: message });
  }
});

/** Diagnóstico: testa o filtro no Qdrant sem busca vetorial. Retorna quantos pontos batem e amostra de payloads. */
app.post("/search/validate-filter", express.json(), async (req, res) => {
  if (!COLLECTION_NAME) {
    return res.status(500).json({ error: "COLLECTION_NAME não configurado no ambiente" });
  }
  const allowedFilterKeys = getAllowedFilterKeys();
  if (allowedFilterKeys.length === 0) {
    return res.status(400).json({
      error: "Configure QDRANT_PAYLOAD_KEYS e/ou QDRANT_PAYLOAD_KEYS_TEXT no ambiente para usar filtros",
    });
  }
  const filter = req.body?.filter;
  const filter_not = req.body?.filter_not;
  if (filter != null && (typeof filter !== "object" || Array.isArray(filter))) {
    return res.status(400).json({ error: "Campo 'filter' deve ser um objeto" });
  }
  let invalidKeys = filter ? Object.keys(filter).filter((k) => !allowedFilterKeys.includes(k)) : [];
  if (invalidKeys.length > 0) {
    return res.status(400).json({
      error: `Chaves de filtro não permitidas: ${invalidKeys.join(", ")}. Permitidas: ${allowedFilterKeys.join(", ")}`,
    });
  }
  if (filter_not != null && (typeof filter_not !== "object" || Array.isArray(filter_not))) {
    return res.status(400).json({ error: "Campo 'filter_not' deve ser um objeto" });
  }
  invalidKeys = filter_not ? Object.keys(filter_not).filter((k) => !allowedFilterKeys.includes(k)) : [];
  if (invalidKeys.length > 0) {
    return res.status(400).json({
      error: `Chaves de filter_not não permitidas: ${invalidKeys.join(", ")}. Permitidas: ${allowedFilterKeys.join(", ")}`,
    });
  }
  const keywordKeys = getAllowedPayloadKeys();
  const fullTextKeys = getFullTextPayloadKeys();
  const qdrantFilterPositive = buildQdrantFilter(filter || {}, keywordKeys, fullTextKeys);
  const qdrantFilterNegative = buildQdrantFilterNot(filter_not || {}, keywordKeys, fullTextKeys);
  const qdrantFilter = mergeQdrantFilter(qdrantFilterPositive, qdrantFilterNegative);
  const limit = Math.min(500, Math.max(10, Number(req.body?.limit) || 100));
  try {
    const result = await qdrantClient.scroll(COLLECTION_NAME, {
      filter: qdrantFilter,
      limit,
      with_payload: true,
      with_vector: false,
    });
    const list = Array.isArray(result?.points)
      ? result.points
      : Array.isArray(result)
        ? (result[0] ?? [])
        : [];
    const sample_payloads = list.slice(0, 5).map((p) => ({
      id: p.id,
      payload: p.payload ?? {},
    }));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json({
      match_count: list.length,
      filter_sent: qdrantFilter,
      sample_payloads,
      hint:
        list.length === 0
          ? "Nenhum ponto bateu no filtro. Cidade/UF no payload devem estar em MAIÚSCULAS e sem acentos (ex: SAO LOURENCO). Envie body {} para ver amostra de payloads da coleção. Reindexe com o pipeline atual se os dados foram inseridos antes da normalização."
          : undefined,
    });
  } catch (err) {
    const status = err.status ?? err.statusCode ?? 500;
    const message =
      status === 400 && err.data?.status?.error
        ? err.data.status.error
        : "Erro ao validar filtro no Qdrant";
    logError("POST /search/validate-filter", "Validação de filtro falhou", err);
    return res.status(status).json({ error: message });
  }
});

/** Lista payloads e vetores disponíveis conforme variáveis de ambiente (filtro, vetores densos, BM25). */
app.get("/config", (_req, res) => {
  const dimension_keys = getDimensionKeys();
  const payload_keys = getAllowedPayloadKeys();
  const payload_keys_full_text = getFullTextPayloadKeys();
  const vector_names = getVectorNamesMap();
  const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim() || null;
  const bm25_payload_keys = getBm25PayloadKeys();

  const rrfK = Number(process.env.RRF_K);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json({
    architecture: "dual-path-rrf-v5",
    dimension_keys,
    payload_keys,
    payload_keys_full_text: payload_keys_full_text.length > 0 ? payload_keys_full_text : null,
    vector_names,
    filter_not_supported: true,
    full_text_filter_supported: payload_keys_full_text.length > 0,
    bm25: {
      vector_name: bm25VectorName,
      payload_keys: bm25_payload_keys.length > 0 ? bm25_payload_keys : null,
      rrf_k: Number.isFinite(rrfK) ? rrfK : 20,
    },
    dual_path: {
      paths: ["A (BM25-First)", "B (Dense-First + BM25 Modifier)"],
      rrf_k: 10,
      path_top_n: Number(process.env.PATH_TOP_N) || 20,
      bm25_modifier: {
        boost: Number(process.env.BM25_MODIFIER_BOOST) || 1.0,
        absent_factor: Number(process.env.BM25_MODIFIER_ABSENT) || 0.85,
      },
    },
    llm_rerank: {
      enabled: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.LLM_RERANK_MODEL || "gpt-4o-mini",
      pool_size: Number(process.env.LLM_RERANK_POOL) || 20,
      usage: "Envie rerank=1 como query param ou rerank: true no body para ativar. Inclua query_text com a busca original.",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/** Pipeline: inicia processamento em background. Body: { limit: number }. */
app.post("/pipeline/run", (req, res) => {
  const state = getPipelineState();
  if (state.status === "running") {
    return res.status(409).json({ error: "Pipeline já está em execução" });
  }
  const limit = req.body && req.body.limit != null ? Number(req.body.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1) {
    return res.status(400).json({ error: "Body deve conter 'limit' (inteiro >= 1)" });
  }
  Promise.resolve().then(() => runPipeline(limit)).catch((err) => {
    console.error("Pipeline error:", err);
  });
  res.status(202).json({
    ok: true,
    message: "Pipeline iniciado",
    limit,
    dashboard_url: "/pipeline/dashboard",
    status_url: "/pipeline/status",
    stream_url: "/pipeline/stream",
  });
});

/** Pipeline: estado atual (JSON). */
app.get("/pipeline/status", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json(getPipelineState());
});

/** Pipeline: SSE com estado a cada ~1.5s enquanto running; encerra ao completar ou falhar. */
app.get("/pipeline/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const interval = setInterval(() => {
    const state = getPipelineState();
    send(state);
    if (state.status !== "running") {
      clearInterval(interval);
      res.end();
    }
  }, 1500);

  req.on("close", () => clearInterval(interval));
});

/** Pipeline: dashboard HTML (página que consome SSE e exibe métricas). */
app.get("/pipeline/dashboard", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getDashboardHtml());
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`API de busca vetorial rodando em http://${HOST}:${PORT}`);
});
