import express from "express";
import { multiVectorSearch } from "./multiVectorSearch.js";
import { llmRerank } from "./llmRerank.js";
import qdrantClient from "./qdrantClient.js";
import { normalizePointsInput, normalizeSinglePointInput, upsertPointsBatch } from "./upsertPoints.js";
import { markAsVectorized } from "./markVectorized.js";
import { isDbConfigured } from "./db.js";
import { logSuccess, logError } from "./logger.js";
import { getPipelineState, runPipeline } from "./pipeline.js";
import { getDashboardHtml } from "./dashboardHtml.js";
import { getSearchXrayHtml } from "./searchXrayHtml.js";
import { runAgentSearch } from "./searchAgent.js";
import { normalizeKeyword } from "./normalizeKeyword.js";
import { embedQueryText } from "./embeddings.js";
import { searchByTextQuery } from "./searchByQuery.js";
import { mountMcp } from "./mcp/mountMcp.js";
import "dotenv/config";

const app = express();
const COLLECTION_NAME = process.env.COLLECTION_NAME;

const ENDPOINT_UPSERT = "POST /points/upsert";
const ENDPOINT_INSERT_POINT = "POST /points/insert";
const ENDPOINT_SEARCH = "POST /search";
const ENDPOINT_SEARCH_COLLECTION = "POST /search/collection";
const ENDPOINT_SEARCH_QUERY = "POST /search/query";
const ENDPOINT_SEARCH_TEXT = "POST /search/text";
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

/** Inserção de um único ponto em coleção informada no body (não usa COLLECTION_NAME do env). */
app.post(
  "/points/insert",
  express.json({ limit: process.env.UPSERT_BODY_LIMIT || "50mb" }),
  async (req, res) => {
    const normalized = normalizeSinglePointInput(req.body);
    if (normalized.error) {
      return res.status(400).json({ error: normalized.error });
    }
    const { collection, point } = normalized;
    const start = Date.now();
    try {
      const result = await upsertPointsBatch({
        collectionName: collection,
        points: [point],
        batchSize: 1,
        wait: true,
        concurrency: 1,
      });
      logSuccess(ENDPOINT_INSERT_POINT, "Ponto inserido no Qdrant", {
        collection,
        point_id: point.id,
        upserted: result.upserted,
        duration_ms: Date.now() - start,
      });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json({ ok: true, collection, ...result });
    } catch (err) {
      const status = err.status ?? err.statusCode ?? 500;
      const qdrantMsg = status === 400 && err.data?.status?.error ? err.data.status.error : null;
      const message = qdrantMsg || `Falha na inserção no Qdrant: ${err.message || "Erro desconhecido"}`;
      logError(ENDPOINT_INSERT_POINT, "Inserção de ponto no Qdrant falhou", err, {
        collection,
        point_id: point.id,
        status,
        qdrant_error: err.data?.status?.error,
      });
      return res.status(status).json({ error: message });
    }
  }
);

app.use(express.urlencoded({ extended: true }));
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

/**
 * Executa a busca multi-vetor e devolve o payload JSON (sem Express).
 * Usado por HTTP e pelo MCP.
 */
async function runMultiVectorSearch({
  body,
  collectionName,
  debugMode = false,
  rerankMode = false,
  includeCollectionInResponse = false,
}) {
  const { vectors, weights, limit_per_vector, final_limit, filter, filter_not, bm25_query, query_text } = body;
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

  try {
    const out = await multiVectorSearch({
      vectors: vectorsForSearch,
      weights: w,
      vectorNamesMap: getVectorNamesMap(),
      limitPerVector: limit_per_vector,
      finalLimit: final_limit,
      collectionName,
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

    if (debugMode && out.debug) {
      out.debug.filter_sent = qdrantFilter;
      out.debug.weights_used = w;
      return {
        ...(includeCollectionInResponse ? { collection: collectionName } : {}),
        results: formattedResults,
        rerank: rerankInfo,
        debug: out.debug,
      };
    }

    const response = {
      ...(includeCollectionInResponse ? { collection: collectionName } : {}),
      results: formattedResults,
    };
    if (rerankInfo) response.rerank = rerankInfo;
    return response;
  } catch (err) {
    const status = err.status ?? err.statusCode ?? 500;
    const message =
      status === 400 && err.data?.status?.error
        ? err.data.status.error
        : "Erro no banco vetorial (busca Qdrant)";
    const wrapped = new Error(message);
    wrapped.status = status;
    wrapped.data = err.data;
    throw wrapped;
  }
}

async function handleSearch(req, res, collectionName, endpointLabel, includeCollectionInResponse = false) {
  const debugMode = req.query.debug === "1";
  const rerankMode = req.query.rerank === "1" || req.body.rerank === true;

  try {
    const payload = await runMultiVectorSearch({
      body: req.body,
      collectionName,
      debugMode,
      rerankMode,
      includeCollectionInResponse,
    });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json(payload);
  } catch (err) {
    const status = err.status ?? err.statusCode ?? 500;
    logError(endpointLabel, "Busca vetorial falhou", err, {
      collection: collectionName,
      status,
      qdrant_error: err.data?.status?.error,
    });
    return res.status(status).json({ error: err.message || "Erro no banco vetorial (busca Qdrant)" });
  }
}

app.post("/search", async (req, res) => {
  const validationError = validateSearchBody(req.body);
  if (validationError) {
    return res.status(validationError.status).json({ error: validationError.message });
  }

  if (!COLLECTION_NAME) {
    return res.status(500).json({ error: "COLLECTION_NAME não configurado no ambiente" });
  }

  return handleSearch(req, res, COLLECTION_NAME, ENDPOINT_SEARCH);
});

/**
 * Aceita objeto ou string JSON (útil para tools n8n / form-urlencoded).
 * @returns {{ value?: object, error?: { status: number, message: string } }}
 */
function coerceJsonObjectField(raw, fieldName, { allowEmpty = true } = {}) {
  if (raw == null || raw === "") {
    return allowEmpty ? { value: undefined } : { error: { status: 400, message: `Campo '${fieldName}' é obrigatório` } };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { value: raw };
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { value: parsed };
      }
      return { error: { status: 400, message: `Campo '${fieldName}' deve ser um objeto JSON` } };
    } catch {
      return { error: { status: 400, message: `Campo '${fieldName}' não é um JSON válido` } };
    }
  }
  return { error: { status: 400, message: `Campo '${fieldName}' deve ser um objeto` } };
}

/**
 * Vetoriza textos por dimensão com OpenAI.
 * - query: texto padrão replicado em todas as dimensões
 * - queries: opcional, sobrescreve o texto de dimensões específicas
 */
async function buildVectorsFromQueryText({ query, queries, dimensionKeys, embedDimensions }) {
  const perDimText = {};
  const uniqueTexts = new Map();

  for (const dim of dimensionKeys) {
    const override =
      queries && typeof queries[dim] === "string" && queries[dim].trim()
        ? queries[dim].trim()
        : null;
    const text = override || query;
    perDimText[dim] = text;
    if (!uniqueTexts.has(text)) uniqueTexts.set(text, null);
  }

  for (const text of uniqueTexts.keys()) {
    uniqueTexts.set(text, await embedQueryText(text, embedDimensions));
  }

  const vectors = {};
  for (const dim of dimensionKeys) {
    vectors[dim] = uniqueTexts.get(perDimText[dim]);
  }
  return { vectors, perDimText, embedding_dims: vectors[dimensionKeys[0]]?.length ?? 0 };
}

/**
 * Busca por texto na coleção padrão (COLLECTION_NAME).
 * Usado por POST /search/text e pela tool MCP search_text.
 * @throws {Error} com .status em falhas de validação / infra
 */
async function executeSearchByText(rawBody = {}, options = {}) {
  if (!COLLECTION_NAME) {
    const err = new Error("COLLECTION_NAME não configurado no ambiente");
    err.status = 500;
    throw err;
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    const err = new Error("OPENAI_API_KEY não configurado; necessário para vetorizar a query");
    err.status = 503;
    throw err;
  }

  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    const err = new Error("Campo 'query' é obrigatório (texto a buscar/vetorizar)");
    err.status = 400;
    throw err;
  }

  const queriesCoerced = coerceJsonObjectField(body.queries, "queries");
  if (queriesCoerced.error) {
    const err = new Error(queriesCoerced.error.message);
    err.status = queriesCoerced.error.status;
    throw err;
  }
  const weightsCoerced = coerceJsonObjectField(body.weights, "weights");
  if (weightsCoerced.error) {
    const err = new Error(weightsCoerced.error.message);
    err.status = weightsCoerced.error.status;
    throw err;
  }
  const filterCoerced = coerceJsonObjectField(body.filter, "filter");
  if (filterCoerced.error) {
    const err = new Error(filterCoerced.error.message);
    err.status = filterCoerced.error.status;
    throw err;
  }
  const filterNotCoerced = coerceJsonObjectField(body.filter_not, "filter_not");
  if (filterNotCoerced.error) {
    const err = new Error(filterNotCoerced.error.message);
    err.status = filterNotCoerced.error.status;
    throw err;
  }

  const dimensionKeys = getDimensionKeys();
  const queries = queriesCoerced.value;
  if (queries) {
    const invalidQueryKeys = Object.keys(queries).filter((k) => !dimensionKeys.includes(k));
    if (invalidQueryKeys.length > 0) {
      const err = new Error(
        `Chaves de queries não permitidas: ${invalidQueryKeys.join(", ")}. Permitidas: ${dimensionKeys.join(", ")}`,
      );
      err.status = 400;
      throw err;
    }
  }

  const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim();
  const useBm25 =
    body.bm25 !== false &&
    Boolean(bm25VectorName) &&
    (typeof body.bm25_query === "string" ? body.bm25_query.trim() !== "" : true);
  const bm25_query = useBm25
    ? (typeof body.bm25_query === "string" && body.bm25_query.trim()
        ? body.bm25_query.trim()
        : query)
    : undefined;

  const weights =
    weightsCoerced.value ??
    buildEqualWeights(dimensionKeys, Boolean(bm25_query));

  const limit_per_vector = body.limit_per_vector != null ? Number(body.limit_per_vector) : 50;
  const final_limit = body.final_limit != null ? Number(body.final_limit) : 20;
  const embedDimensions = getEmbedDimensionsForCollection(COLLECTION_NAME, body);
  const start = Date.now();
  const debugMode = options.debug === true;
  const rerankMode = options.rerank === true || body.rerank === true;

  try {
    const { vectors, perDimText, embedding_dims } = await buildVectorsFromQueryText({
      query,
      queries,
      dimensionKeys,
      embedDimensions,
    });

    const searchBody = {
      ...body,
      query,
      query_text:
        typeof body.query_text === "string" && body.query_text.trim()
          ? body.query_text.trim()
          : query,
      vectors,
      weights,
      filter: filterCoerced.value,
      filter_not: filterNotCoerced.value,
      limit_per_vector,
      final_limit,
      bm25_query,
    };

    const validationError = validateSearchBody(searchBody);
    if (validationError) {
      const err = new Error(validationError.message);
      err.status = validationError.status;
      throw err;
    }

    logSuccess(ENDPOINT_SEARCH_TEXT, "Query vetorizada; iniciando busca", {
      collection: COLLECTION_NAME,
      embedding_dims,
      dimensions: dimensionKeys.length,
      duration_ms: Date.now() - start,
      query_preview: query.slice(0, 80),
      per_dim_override: Boolean(queries),
    });

    const payload = await runMultiVectorSearch({
      body: searchBody,
      collectionName: COLLECTION_NAME,
      debugMode,
      rerankMode,
    });

    return {
      ...payload,
      query,
      mode: "text",
      embedding_model: "text-embedding-3-small",
      embedding_dims,
      query_texts: perDimText,
    };
  } catch (err) {
    if (err.status) throw err;
    const status = err.statusCode ?? 500;
    const wrapped = new Error(err.message || "Falha ao vetorizar query ou buscar no Qdrant");
    wrapped.status = status;
    throw wrapped;
  }
}

/**
 * Busca por texto na coleção padrão (COLLECTION_NAME):
 * vetoriza a query com OpenAI e executa o mesmo pipeline de POST /search.
 *
 * Body:
 * - query (string, obrigatório) — texto a vetorizar
 * - queries (objeto opcional) — texto por dimensão (produto, servico, ...)
 * - weights, filter, filter_not, limit_per_vector, final_limit, bm25_query, bm25, rerank, query_text, embed_dimensions
 */
app.post("/search/text", async (req, res) => {
  try {
    const payload = await executeSearchByText(req.body || {}, {
      debug: req.query.debug === "1",
      rerank: req.query.rerank === "1",
    });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json(payload);
  } catch (err) {
    const status = err.status ?? err.statusCode ?? 500;
    logError(ENDPOINT_SEARCH_TEXT, "Busca por texto falhou", err, {
      collection: COLLECTION_NAME,
      status,
    });
    return res.status(status).json({ error: err.message || "Falha ao vetorizar query ou buscar no Qdrant" });
  }
});

/** Busca vetorial em coleção informada no body (não usa COLLECTION_NAME do env). */
app.post("/search/collection", async (req, res) => {
  const collection = typeof req.body?.collection === "string" ? req.body.collection.trim() : "";
  if (!collection) {
    return res.status(400).json({ error: "Campo 'collection' é obrigatório (nome da coleção a buscar)" });
  }

  const validationError = validateSearchBody(req.body);
  if (validationError) {
    return res.status(validationError.status).json({ error: validationError.message });
  }

  return handleSearch(req, res, collection, ENDPOINT_SEARCH_COLLECTION, true);
});

function getSearchCollectionProfile(collection) {
  const env = process.env.SEARCH_COLLECTION_PROFILES;
  if (!env || typeof env !== "string") return null;
  try {
    const profiles = JSON.parse(env);
    return profiles && typeof profiles === "object" ? profiles[collection] ?? null : null;
  } catch {
    return null;
  }
}

/** Define se a busca por texto usa vetor único ou multi-vetor (mesmo embedding replicado). */
function resolveQuerySearchConfig(collection, body) {
  if (typeof body?.vector_name === "string" && body.vector_name.trim()) {
    return { mode: "single", vectorName: body.vector_name.trim() };
  }

  if (collection === "whatsapp_bf") {
    const vectorName = process.env.WHATSAPP_BF_VECTOR_NAME?.trim() || null;
    return { mode: "single", vectorName };
  }

  const profile = getSearchCollectionProfile(collection);
  if (profile?.mode === "single") {
    const vectorName = profile.vector_name ? String(profile.vector_name).trim() : null;
    return { mode: "single", vectorName: vectorName || null };
  }

  return { mode: "multi", profile };
}

function buildEqualWeights(dimensionKeys, includeBm25 = false) {
  const n = dimensionKeys.length + (includeBm25 ? 1 : 0);
  const w = 1 / n;
  const weights = {};
  for (const dim of dimensionKeys) weights[dim] = w;
  if (includeBm25) weights.bm25 = w;
  return weights;
}

/** Dimensões do embedding OpenAI por coleção (whatsapp_bf: text-embedding-3-small, 1536d). */
function getEmbedDimensionsForCollection(collection, body) {
  if (body?.embed_dimensions != null) {
    const n = Number(body.embed_dimensions);
    if (Number.isInteger(n) && n > 0) return n;
  }
  if (collection === "whatsapp_bf") {
    const n = Number(process.env.WHATSAPP_BF_EMBED_DIMENSIONS);
    if (Number.isInteger(n) && n > 0) return n;
    return 1536;
  }
  const global = Number(process.env.OPENAI_EMBED_DIMENSIONS);
  if (Number.isInteger(global) && global > 0) return global;
  return undefined;
}

/**
 * Busca por texto: vetoriza a query com OpenAI e consulta a coleção informada.
 * Modo single (ex.: whatsapp_bf): vetor default sem nome; opcional WHATSAPP_BF_VECTOR_NAME ou body.vector_name.
 * Modo multi: replica o embedding em todas as dimensões configuradas (QDRANT_DIMENSION_KEYS).
 */
app.post("/search/query", async (req, res) => {
  const collection = typeof req.body?.collection === "string" ? req.body.collection.trim() : "";
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";

  if (!collection) {
    return res.status(400).json({ error: "Campo 'collection' é obrigatório (nome da coleção a buscar)" });
  }
  if (!query) {
    return res.status(400).json({ error: "Campo 'query' é obrigatório (texto a buscar)" });
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return res.status(503).json({
      error: "OPENAI_API_KEY não configurado; necessário para vetorizar a query",
    });
  }

  const finalLimit = Number(req.body.final_limit) || 20;
  if (!Number.isInteger(finalLimit) || finalLimit < 1) {
    return res.status(400).json({ error: "final_limit deve ser um inteiro >= 1" });
  }

  const keywordKeys = getAllowedPayloadKeys();
  const fullTextKeys = getFullTextPayloadKeys();
  const { filter, filter_not } = req.body;
  const qdrantFilterPositive = buildQdrantFilter(filter, keywordKeys, fullTextKeys);
  const qdrantFilterNegative = buildQdrantFilterNot(filter_not, keywordKeys, fullTextKeys);
  const qdrantFilter = mergeQdrantFilter(qdrantFilterPositive, qdrantFilterNegative);

  const config = resolveQuerySearchConfig(collection, req.body);
  const embedDimensions = getEmbedDimensionsForCollection(collection, req.body);
  const start = Date.now();

  try {
    if (config.mode === "single") {
      const { results, embedding_dims } = await searchByTextQuery({
        collectionName: collection,
        query,
        vectorName: config.vectorName || undefined,
        limit: finalLimit,
        embedDimensions,
        filter: qdrantFilter,
      });

      logSuccess(ENDPOINT_SEARCH_QUERY, "Busca por query vetorizada concluída", {
        collection,
        mode: "single",
        vector_name: config.vectorName,
        results: results.length,
        embedding_dims,
        duration_ms: Date.now() - start,
      });

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json({
        collection,
        query,
        mode: "single",
        vector_name: config.vectorName ?? null,
        results,
      });
    }

    const embedding = await embedQueryText(query, embedDimensions);
    const dimensionKeys = config.profile?.dimension_keys ?? getDimensionKeys();
    const vectors = {};
    for (const dim of dimensionKeys) vectors[dim] = embedding;

    const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim();
    const useBm25 = req.body.bm25 !== false && Boolean(bm25VectorName);
    const bm25_query = typeof req.body.bm25_query === "string" ? req.body.bm25_query.trim() : query;
    const weights = req.body.weights
      ?? config.profile?.weights
      ?? buildEqualWeights(dimensionKeys, useBm25);

    const searchReq = {
      ...req,
      body: {
        ...req.body,
        vectors,
        weights,
        limit_per_vector: req.body.limit_per_vector ?? 50,
        final_limit: finalLimit,
        bm25_query: useBm25 ? bm25_query : undefined,
        filter,
        filter_not,
      },
    };

    const validationError = validateSearchBody(searchReq.body);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.message });
    }

    return handleSearch(searchReq, res, collection, ENDPOINT_SEARCH_QUERY, true);
  } catch (err) {
    const status = err.status ?? err.statusCode ?? 500;
    const qdrantMsg = err.data?.status?.error;
    const message = qdrantMsg || err.message || "Falha ao vetorizar query ou buscar no Qdrant";
    logError(ENDPOINT_SEARCH_QUERY, "Busca por query falhou", err, {
      collection,
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
function getPublicConfig() {
  const dimension_keys = getDimensionKeys();
  const payload_keys = getAllowedPayloadKeys();
  const payload_keys_full_text = getFullTextPayloadKeys();
  const vector_names = getVectorNamesMap();
  const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim() || null;
  const bm25_payload_keys = getBm25PayloadKeys();
  const rrfK = Number(process.env.RRF_K);

  return {
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
    mcp: {
      endpoint: "/mcp",
      tools: ["get_config", "search_text"],
      auth: false,
    },
  };
}

app.get("/config", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(getPublicConfig());
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", mcp: "/mcp", search_xray: "/search/xray" });
});

/** UI de teste: busca com raio-X dos parâmetros (POST /search/text). */
app.get("/search/xray", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getSearchXrayHtml());
});

/**
 * Agente X-Ray: LLM monta args da tool MCP search_text e executa a busca.
 * Body: { query: string, final_limit?: number }
 */
app.post("/search/xray/run", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    return res.status(400).json({ error: "Campo 'query' é obrigatório" });
  }
  const final_limit = req.body?.final_limit != null ? Number(req.body.final_limit) : 10;

  try {
    const out = await runAgentSearch({
      userQuery: query,
      config: getPublicConfig(),
      executeSearchByText,
      final_limit: Number.isInteger(final_limit) && final_limit >= 1 ? final_limit : 10,
    });
    logSuccess("POST /search/xray/run", "Agente MCP search_text executado", {
      query_preview: query.slice(0, 80),
      agent_ms: out.duration_ms,
      search_ms: out.search_duration_ms,
      results: out.search?.results?.length ?? 0,
    });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json(out);
  } catch (err) {
    const status = err.status ?? err.statusCode ?? 500;
    logError("POST /search/xray/run", "Agente X-Ray falhou", err, { status });
    return res.status(status).json({ error: err.message || "Falha no agente de busca" });
  }
});

mountMcp(app, {
  executeSearchByText,
  getPublicConfig,
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
  console.log(`MCP Streamable HTTP em http://${HOST}:${PORT}/mcp`);
  console.log(`Busca X-Ray em http://${HOST}:${PORT}/search/xray`);
});
