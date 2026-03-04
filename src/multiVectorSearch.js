import qdrantClient from "./qdrantClient.js";

/** Chaves da API (sempre segmento, produtos, clientes). */
const DIMENSION_KEYS = ["segmento", "produtos", "clientes"];

/**
 * Nomes reais dos vetores na coleção Qdrant (named vectors).
 * Por padrão: v_segmento, v_produtos, v_clientes.
 * Se a coleção usar outros nomes, defina QDRANT_VECTOR_NAMES no .env, ex.: segmento,produtos,clientes (sem prefixo v_).
 */
function getQdrantVectorNames() {
  const env = process.env.QDRANT_VECTOR_NAMES;
  if (env && typeof env === "string") {
    const names = env.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 3) return names;
  }
  return ["v_segmento", "v_produtos", "v_clientes"];
}

/** Nome do vetor esparso BM25 na coleção (campos produtos, servicos, descricao). Env: QDRANT_BM25_VECTOR_NAME. */
function getBm25VectorName() {
  const env = process.env.QDRANT_BM25_VECTOR_NAME;
  return env && typeof env === "string" ? env.trim() : null;
}

/** Modelo de inferência BM25 no Qdrant. Env: QDRANT_BM25_MODEL (default: qdrant/bm25). */
function getBm25Model() {
  const env = process.env.QDRANT_BM25_MODEL;
  return env && typeof env === "string" ? env.trim() : "qdrant/bm25";
}

/** Multiplicador de candidatos BM25 antes da fusão (env: BM25_CANDIDATES_MULTIPLIER, default: 5). */
function getBm25CandidatesMultiplier() {
  const n = Number(process.env.BM25_CANDIDATES_MULTIPLIER);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 5;
}

/** Constante k do RRF: RRF_score = 1 / (k + rank). Env: RRF_K (default: 60). */
function getRrfK() {
  const n = Number(process.env.RRF_K);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

const QDRANT_VECTOR_NAMES = getQdrantVectorNames();

/**
 * Executa buscas independentes por cada vetor nomeado e combina os scores com pesos.
 * Opcionalmente inclui busca BM25 (texto) nos campos produtos, servicos, descricao e funde o score.
 *
 * @param {object} params
 * @param {Record<string, number[]>} params.vectors - { segmento: float[], produtos: float[], clientes: float[] }
 * @param {Record<string, number>} params.weights - { segmento: float, produtos: float, clientes: float }, soma = 1
 * @param {number} params.limitPerVector - top N por dimensão
 * @param {number} params.finalLimit - quantidade final no ranking
 * @param {string} params.collectionName - nome da coleção
 * @param {object|null} params.filter - filtro Qdrant (must/match), aplicado antes da busca semântica
 * @param {string|null} [params.bm25Query] - texto para busca BM25 (vetor esparso; payloads: produtos, servicos, descricao)
 * @param {number} [params.bm25Weight=0.3] - peso do score BM25 na fusão (0..1); o restante é da busca vetorial
 * @returns {Promise<Array<{ id: number|string, score_final: number, payload: object, scores: Record<string, number> }>>}
 */
export async function multiVectorSearch({
  vectors,
  weights,
  limitPerVector,
  finalLimit,
  collectionName,
  filter = null,
  bm25Query = null,
  bm25Weight = 0.3,
}) {
  const collection = collectionName;
  const bm25VectorName = getBm25VectorName();
  const useBm25 = Boolean(bm25Query && bm25Query.trim() && bm25VectorName);
  const safeBm25Weight = useBm25
    ? Math.max(0, Math.min(1, Number(bm25Weight)))
    : 0;

  /** @type {Record<string|number, { id: number|string, payload: object, scores: Record<string, number> }>} */
  const byId = {};

  const searchOpts = {
    limit: limitPerVector,
    with_payload: true,
    with_vector: false,
    ...(filter && { filter }),
  };

  const searchPromises = DIMENSION_KEYS.map(async (dim, index) => {
    const queryVector = vectors[dim];
    const vectorName = QDRANT_VECTOR_NAMES[index];
    const points = await qdrantClient.search(collection, {
      vector: { name: vectorName, vector: queryVector },
      ...searchOpts,
    });
    return { dim, points };
  });

  const results = await Promise.all(searchPromises);

  for (const { dim, points } of results) {
    for (const point of points) {
      let id = point.id;
      if (typeof id === "object") {
        if (id.num !== undefined) id = id.num;
        else if (id.uuid !== undefined) id = id.uuid;
      }
      id = typeof id === "number" ? id : String(id);
      if (!byId[id]) {
        byId[id] = {
          id,
          payload: point.payload ?? {},
          scores: { segmento: 0, produtos: 0, clientes: 0, bm25: 0 },
        };
      }
      byId[id].scores[dim] = point.score ?? 0;
    }
  }

  if (useBm25) {
    const multiplier = getBm25CandidatesMultiplier();
    const bm25Limit = Math.max(limitPerVector * multiplier, finalLimit * multiplier);
    const rrfK = getRrfK();
    const bm25Opts = {
      query: { text: bm25Query.trim(), model: getBm25Model() },
      using: bm25VectorName,
      limit: bm25Limit,
      with_payload: true,
      with_vector: false,
      ...(filter && { filter }),
    };
    const bm25Response = await qdrantClient.query(collection, bm25Opts);
    const bm25Points = Array.isArray(bm25Response)
      ? bm25Response
      : (bm25Response?.result?.points ?? bm25Response?.points ?? []);
    let maxRrf = 0;
    bm25Points.forEach((point, index) => {
      const rank = index + 1;
      const rrfScore = 1 / (rrfK + rank);
      let id = point.id;
      if (typeof id === "object") {
        if (id.num !== undefined) id = id.num;
        else if (id.uuid !== undefined) id = id.uuid;
      }
      id = typeof id === "number" ? id : String(id);
      if (!byId[id]) {
        byId[id] = {
          id,
          payload: point.payload ?? {},
          scores: { segmento: 0, produtos: 0, clientes: 0, bm25: 0 },
        };
      }
      byId[id].scores.bm25 = point.score ?? 0;
      byId[id].scores.bm25_rrf = rrfScore;
      if (rrfScore > maxRrf) maxRrf = rrfScore;
    });
    const norm = maxRrf > 0 ? maxRrf : 1;
    for (const item of Object.values(byId)) {
      item.scores.bm25_normalized = (item.scores.bm25_rrf ?? 0) / norm;
    }
  }

  const vectorWeight = 1 - safeBm25Weight;
  const combined = Object.values(byId).map((item) => {
    const vectorScore =
      item.scores.segmento * weights.segmento +
      item.scores.produtos * weights.produtos +
      item.scores.clientes * weights.clientes;
    const bm25Score = item.scores.bm25_normalized ?? 0;
    const score_final = vectorWeight * vectorScore + safeBm25Weight * bm25Score;
    const { bm25_normalized: _, bm25_rrf: __, ...scores } = item.scores;
    return { ...item, scores, score_final };
  });

  combined.sort((a, b) => b.score_final - a.score_final);
  return combined.slice(0, finalLimit);
}
