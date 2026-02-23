import qdrantClient from "./qdrantClient.js";

/**
 * Nomes dos vetores na coleção Qdrant (named vectors).
 * Request usa: segmento, produtos, clientes → mapeados para v_segmento, v_produtos, v_clientes.
 */
const VECTOR_NAMES = ["segmento", "produtos", "clientes"];
const QDRANT_VECTOR_PREFIX = "v_";

/**
 * Executa buscas independentes por cada vetor nomeado e combina os scores com pesos.
 *
 * @param {object} params
 * @param {Record<string, number[]>} params.vectors - { segmento: float[], produtos: float[], clientes: float[] }
 * @param {Record<string, number>} params.weights - { segmento: float, produtos: float, clientes: float }, soma = 1
 * @param {number} params.limitPerVector - top N por dimensão
 * @param {number} params.finalLimit - quantidade final no ranking
 * @param {string} params.collectionName - nome da coleção
 * @returns {Promise<Array<{ id: number|string, score_final: number, payload: object, scores: Record<string, number> }>>}
 */
export async function multiVectorSearch({
  vectors,
  weights,
  limitPerVector,
  finalLimit,
  collectionName,
}) {
  const collection = collectionName;

  /** @type {Record<string|number, { id: number|string, payload: object, scores: Record<string, number> }>} */
  const byId = {};

  const searchPromises = VECTOR_NAMES.map(async (dim) => {
    const queryVector = vectors[dim];
    const vectorName = QDRANT_VECTOR_PREFIX + dim;
    const points = await qdrantClient.search(collection, {
      vector: { name: vectorName, vector: queryVector },
      limit: limitPerVector,
      with_payload: true,
      with_vector: false,
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
