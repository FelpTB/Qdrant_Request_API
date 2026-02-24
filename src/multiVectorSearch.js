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

const QDRANT_VECTOR_NAMES = getQdrantVectorNames();

/**
 * Executa buscas independentes por cada vetor nomeado e combina os scores com pesos.
 *
 * @param {object} params
 * @param {Record<string, number[]>} params.vectors - { segmento: float[], produtos: float[], clientes: float[] }
 * @param {Record<string, number>} params.weights - { segmento: float, produtos: float, clientes: float }, soma = 1
 * @param {number} params.limitPerVector - top N por dimensão
 * @param {number} params.finalLimit - quantidade final no ranking
 * @param {string} params.collectionName - nome da coleção
 * @param {object|null} params.filter - filtro Qdrant (must/match), aplicado antes da busca semântica
 * @returns {Promise<Array<{ id: number|string, score_final: number, payload: object, scores: Record<string, number> }>>}
 */
export async function multiVectorSearch({
  vectors,
  weights,
  limitPerVector,
  finalLimit,
  collectionName,
  filter = null,
}) {
  const collection = collectionName;

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
          scores: { segmento: 0, produtos: 0, clientes: 0 },
        };
      }
      byId[id].scores[dim] = point.score ?? 0;
    }
  }

  const combined = Object.values(byId).map((item) => {
    const score_final =
      item.scores.segmento * weights.segmento +
      item.scores.produtos * weights.produtos +
      item.scores.clientes * weights.clientes;
    return { ...item, score_final };
  });

  combined.sort((a, b) => b.score_final - a.score_final);
  return combined.slice(0, finalLimit);
}
