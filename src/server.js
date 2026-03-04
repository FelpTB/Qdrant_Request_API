import express from "express";
import { multiVectorSearch } from "./multiVectorSearch.js";
import "dotenv/config";

const app = express();
app.use(express.json({ limit: "2mb" }));

const COLLECTION_NAME = process.env.COLLECTION_NAME;
const REQUIRED_DIMENSIONS = ["segmento", "produtos", "clientes"];

/** Lista de chaves de payload permitidas para filtro (env QDRANT_PAYLOAD_KEYS, ex.: nome_empresa,industria,modelo_negocio). */
function getAllowedPayloadKeys() {
  const env = process.env.QDRANT_PAYLOAD_KEYS;
  if (!env || typeof env !== "string") return [];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Mapeamento chave da API → nome do vetor na coleção Qdrant (env QDRANT_VECTOR_NAMES; ordem: segmento, produtos, clientes). */
function getVectorNamesMap() {
  const env = process.env.QDRANT_VECTOR_NAMES;
  const keys = ["segmento", "produtos", "clientes"];
  if (env && typeof env === "string") {
    const names = env.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 3) {
      return { segmento: names[0], produtos: names[1], clientes: names[2] };
    }
  }
  return { segmento: "v_segmento", produtos: "v_produtos", clientes: "v_clientes" };
}

/** Lista de chaves de payload usadas para construir o vetor BM25 (env QDRANT_BM25_PAYLOAD_KEYS, opcional). */
function getBm25PayloadKeys() {
  const env = process.env.QDRANT_BM25_PAYLOAD_KEYS;
  if (!env || typeof env !== "string") return [];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

function normalizeWeights(weights) {
  if (!weights || typeof weights !== "object") return null;
  const w = {
    segmento: Number(weights.segmento),
    produtos: Number(weights.produtos),
    clientes: Number(weights.clientes),
  };
  if (Number.isNaN(w.segmento) || Number.isNaN(w.produtos) || Number.isNaN(w.clientes))
    return null;
  return w;
}

function sumWeights(w) {
  return w.segmento + w.produtos + w.clientes;
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

  const { vectors, weights, limit_per_vector, final_limit, filter, bm25_query, bm25_weight } = body;
  const allowedPayloadKeys = getAllowedPayloadKeys();

  if (bm25_query != null && bm25_query !== undefined) {
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

  for (const dim of REQUIRED_DIMENSIONS) {
    if (!(dim in vectors))
      return { status: 400, message: `Vetor ausente: '${dim}'` };
    if (!isValidVector(vectors[dim]))
      return { status: 400, message: `Vetor '${dim}' inválido ou dimensões incorretas` };
  }

  const dimLength = vectors.segmento.length;
  if (vectors.produtos.length !== dimLength || vectors.clientes.length !== dimLength)
    return { status: 400, message: "Dimensões dos vetores devem coincidir" };

  const w = normalizeWeights(weights);
  if (!w)
    return { status: 400, message: "Campo 'weights' inválido (segmento, produtos, clientes)" };
  const sum = sumWeights(w);
  if (Math.abs(sum - 1) > 1e-6)
    return { status: 400, message: "Soma dos pesos deve ser 1.0" };

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

  const { vectors, weights, limit_per_vector, final_limit, filter, bm25_query, bm25_weight } = req.body;
  const w = normalizeWeights(weights);
  const allowedPayloadKeys = getAllowedPayloadKeys();
  const qdrantFilter = buildQdrantFilter(filter, allowedPayloadKeys);
  const bm25Weight =
    bm25_query != null && bm25_query !== ""
      ? Math.max(0, Math.min(1, Number(bm25_weight ?? 0.3)))
      : undefined;

  try {
    const results = await multiVectorSearch({
      vectors: {
        segmento: vectors.segmento,
        produtos: vectors.produtos,
        clientes: vectors.clientes,
      },
      weights: w,
      limitPerVector: limit_per_vector,
      finalLimit: final_limit,
      collectionName: COLLECTION_NAME,
      filter: qdrantFilter,
      bm25Query: typeof bm25_query === "string" ? bm25_query : null,
      bm25Weight,
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json({ results });
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
  const payload_keys = getAllowedPayloadKeys();
  const vector_names = getVectorNamesMap();
  const bm25VectorName = process.env.QDRANT_BM25_VECTOR_NAME?.trim() || null;
  const bm25_payload_keys = getBm25PayloadKeys();

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json({
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
