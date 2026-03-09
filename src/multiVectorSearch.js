import qdrantClient from "./qdrantClient.js";

/**
 * Nomes reais dos vetores na coleção Qdrant (named vectors).
 * Derivado de vectorNamesMap passado pelo server (QDRANT_VECTOR_NAMES / QDRANT_DIMENSION_KEYS).
 */
function getQdrantVectorNames(vectorNamesMap) {
  return vectorNamesMap ? Object.values(vectorNamesMap) : ["v_segmento", "v_produtos", "v_clientes"];
}

/** Chaves das dimensões (ordem consistente). */
function getDimensionKeysFromMap(vectorNamesMap) {
  return vectorNamesMap ? Object.keys(vectorNamesMap) : ["segmento", "produtos", "clientes"];
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

/**
 * Executa buscas independentes por cada vetor nomeado e combina os scores com pesos.
 * Opcionalmente inclui busca BM25 (texto) e funde o score.
 *
 * @param {object} params
 * @param {Record<string, number[]>} params.vectors - um vetor por dimensão (chaves = dimension_keys)
 * @param {Record<string, number>} params.weights - peso por dimensão (+ bm25 se bm25Query); soma total = 1
 * @param {Record<string, string>} params.vectorNamesMap - mapa chave da API → nome do vetor no Qdrant
 * @param {number} params.limitPerVector - top N por dimensão
 * @param {number} params.finalLimit - quantidade final no ranking
 * @param {string} params.collectionName - nome da coleção
 * @param {object|null} params.filter - filtro Qdrant (must/match), aplicado antes da busca semântica
 * @param {string|null} [params.bm25Query] - texto para busca BM25
 * @param {boolean} [params.returnDebugCounts=false] - se true, retorna { results, debug: { points_per_dimension, bm25_points } }
 * @returns {Promise<Array<...>|{ results: Array<...>, debug: object }>}
 */
export async function multiVectorSearch({
  vectors,
  weights,
  vectorNamesMap,
  limitPerVector,
  finalLimit,
  collectionName,
  filter = null,
  bm25Query = null,
  returnDebugCounts = false,
}) {
  const dimensionKeys = getDimensionKeysFromMap(vectorNamesMap);
  const vectorNames = getQdrantVectorNames(vectorNamesMap);
  if (dimensionKeys.length !== vectorNames.length) {
    throw new Error("vectorNamesMap: número de chaves deve coincidir com o número de nomes de vetor");
  }
  const collection = collectionName;
  const bm25VectorName = getBm25VectorName();
  const useBm25 = Boolean(bm25Query && bm25Query.trim() && bm25VectorName);
  const bm25Weight = useBm25 ? (Number(weights.bm25) || 0) : 0;

  /** @type {Record<string|number, { id: number|string, payload: object, scores: Record<string, number> }>} */
  const byId = {};

  const searchOpts = {
    limit: limitPerVector,
    with_payload: true,
    with_vector: false,
    ...(filter && { filter }),
  };

  const searchPromises = dimensionKeys.map(async (dim, index) => {
    const queryVector = vectors[dim];
    const vectorName = vectorNames[index];
    const points = await qdrantClient.search(collection, {
      vector: { name: vectorName, vector: queryVector },
      ...searchOpts,
    });
    return { dim, points };
  });

  const results = await Promise.all(searchPromises);

  const pointsPerDimension = {};
  dimensionKeys.forEach((dim) => { pointsPerDimension[dim] = 0; });

  const initialScores = {};
  dimensionKeys.forEach((dim) => { initialScores[dim] = 0; });
  initialScores.bm25 = 0;

  for (const { dim, points } of results) {
    if (returnDebugCounts) pointsPerDimension[dim] = points?.length ?? 0;
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
          scores: { ...initialScores },
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
    if (returnDebugCounts) pointsPerDimension.bm25 = bm25Points.length;
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
          scores: { ...initialScores },
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

  const combined = Object.values(byId).map((item) => {
    let score_final = 0;
    for (const dim of dimensionKeys) {
      score_final += (item.scores[dim] ?? 0) * (weights[dim] ?? 0);
    }
    score_final += bm25Weight * (item.scores.bm25_normalized ?? 0);
    const { bm25_normalized: _, bm25_rrf: __, ...scores } = item.scores;
    return { ...item, scores, score_final };
  });

  combined.sort((a, b) => b.score_final - a.score_final);
  const resultsSlice = combined.slice(0, finalLimit);
  if (returnDebugCounts) {
    return {
      results: resultsSlice,
      debug: {
        points_per_dimension: pointsPerDimension,
        total_after_merge: combined.length,
        returned: resultsSlice.length,
      },
    };
  }
  return resultsSlice;
}
