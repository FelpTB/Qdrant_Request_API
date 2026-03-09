import express from "express";
import { multiVectorSearch } from "./multiVectorSearch.js";
import { normalizePointsInput, upsertPointsBatch } from "./upsertPoints.js";
import { markAsVectorized } from "./markVectorized.js";
import { isDbConfigured } from "./db.js";
import "dotenv/config";

const app = express();
const COLLECTION_NAME = process.env.COLLECTION_NAME;

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
    try {
      const size = batchSize != null ? Math.max(1, Math.min(500, Number(batchSize))) : undefined;
      const result = await upsertPointsBatch({
        collectionName: COLLECTION_NAME,
        points: normalized.points,
        batchSize: size,
        wait: true,
      });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("Erro no upsert em batch:", err);
      const status = err.status ?? err.statusCode ?? 500;
      const message =
        status === 400 && err.data?.status?.error
          ? err.data.status.error
          : "Erro ao inserir pontos no Qdrant";
      return res.status(status).json({ error: message });
    }
  }
);

app.use(express.json({ limit: "2mb" }));

/** Marca perfis como vetorizados no PostgreSQL (qdrant = true) por lista de CNPJ. Resposta síncrona ao fim da atualização. */
app.post("/company-profiles/mark-vectorized", async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({
      error: "DB_URL não configurado; não é possível atualizar company_profiles",
    });
  }
  const body = req.body;
  const cnpjs = Array.isArray(body) ? body : (body && body.cnpjs);
  if (!Array.isArray(cnpjs)) {
    return res.status(400).json({
      error: "Body deve ser um array de CNPJ ou um objeto { cnpjs: string[] }",
    });
  }
  try {
    const result = await markAsVectorized(cnpjs);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json({
      ok: true,
      message: "Perfis marcados como vetorizados. Pode prosseguir com a próxima leva.",
      ...result,
    });
  } catch (err) {
    console.error("Erro ao marcar perfis como vetorizados:", err);
    const status = err.code === "ECONNREFUSED" ? 503 : (err.status ?? err.statusCode ?? 500);
    const message = err.message || "Erro ao atualizar banco de dados";
    return res.status(status).json({ error: message });
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

/** Lista de chaves de payload permitidas para filtro (env QDRANT_PAYLOAD_KEYS, ex.: nome_empresa,industria,modelo_negocio). */
function getAllowedPayloadKeys() {
  const env = process.env.QDRANT_PAYLOAD_KEYS;
  if (!env || typeof env !== "string") return [];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
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
 * Converte filtro simples { chave: valor } em formato Qdrant (must + match).
 * Apenas chaves presentes em allowedKeys são aceitas.
 */
function buildQdrantFilter(payloadFilter, allowedKeys) {
  if (!payloadFilter || typeof payloadFilter !== "object" || allowedKeys.length === 0)
    return null;
  const must = [];
  for (const [key, value] of Object.entries(payloadFilter)) {
    if (!allowedKeys.includes(key)) continue;
    if (value === undefined || value === null) continue;
    must.push({ key, match: { value } });
  }
  return must.length > 0 ? { must } : null;
}

/** Valida request e retorna erro { status, message } ou null. */
function validateSearchBody(body) {
  if (!body || typeof body !== "object")
    return { status: 400, message: "Request body inválido" };

  const { vectors, weights, limit_per_vector, final_limit, filter, bm25_query } = body;
  const allowedPayloadKeys = getAllowedPayloadKeys();
  const dimensionKeys = getDimensionKeys();
  const useBm25 = bm25_query != null && bm25_query !== undefined;

  if (useBm25) {
    if (typeof bm25_query !== "string")
      return { status: 400, message: "Campo 'bm25_query' deve ser uma string" };
    const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim();
    if (!bm25VectorName)
      return { status: 400, message: "Para usar BM25 configure QDRANT_BM25_VECTOR_NAME no ambiente (nome do vetor esparso da coleção)" };
  }
  if (filter != null && filter !== undefined) {
    if (typeof filter !== "object" || Array.isArray(filter))
      return { status: 400, message: "Campo 'filter' deve ser um objeto" };
    if (allowedPayloadKeys.length === 0)
      return { status: 400, message: "Configure QDRANT_PAYLOAD_KEYS no ambiente para usar filtros de payload" };
    const invalidKeys = Object.keys(filter).filter((k) => !allowedPayloadKeys.includes(k));
    if (invalidKeys.length > 0)
      return { status: 400, message: `Chaves de filtro não permitidas: ${invalidKeys.join(", ")}. Permitidas: ${allowedPayloadKeys.join(", ")}` };
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

  const { vectors, weights, limit_per_vector, final_limit, filter, bm25_query } = req.body;
  const dimensionKeys = getDimensionKeys();
  const useBm25 = bm25_query != null && bm25_query !== "";
  const w = normalizeWeights(weights, dimensionKeys, useBm25);
  const allowedPayloadKeys = getAllowedPayloadKeys();
  const qdrantFilter = buildQdrantFilter(filter, allowedPayloadKeys);

  const vectorsForSearch = {};
  for (const dim of dimensionKeys) vectorsForSearch[dim] = vectors[dim];
  const debugMode = req.query.debug === "1";

  try {
    const out = await multiVectorSearch({
      vectors: vectorsForSearch,
      weights: w,
      vectorNamesMap: getVectorNamesMap(),
      limitPerVector: limit_per_vector,
      finalLimit: final_limit,
      collectionName: COLLECTION_NAME,
      filter: qdrantFilter,
      bm25Query: typeof bm25_query === "string" ? bm25_query : null,
      returnDebugCounts: debugMode,
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json(typeof out === "object" && out.results && out.debug ? out : { results: out });
  } catch (err) {
    console.error("Erro na busca vetorial:", err);
    const status = err.status ?? err.statusCode ?? 500;
    const message =
      status === 400 && err.data?.status?.error
        ? err.data.status.error
        : "Erro no banco vetorial";
    return res.status(status).json({ error: message });
  }
});

/** Lista payloads e vetores disponíveis conforme variáveis de ambiente (filtro, vetores densos, BM25). */
app.get("/config", (_req, res) => {
  const dimension_keys = getDimensionKeys();
  const payload_keys = getAllowedPayloadKeys();
  const vector_names = getVectorNamesMap();
  const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim() || null;
  const bm25_payload_keys = getBm25PayloadKeys();

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json({
    dimension_keys,
    payload_keys,
    vector_names,
    bm25: {
      vector_name: bm25VectorName,
      payload_keys: bm25_payload_keys.length > 0 ? bm25_payload_keys : null,
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`API de busca vetorial rodando em http://${HOST}:${PORT}`);
});
