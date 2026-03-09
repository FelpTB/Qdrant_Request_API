import qdrantClient from "./qdrantClient.js";

const DEFAULT_BATCH_SIZE = 100;

/**
 * Normaliza o body para um array de pontos.
 * Aceita:
 * - Array de { point: [ { id, payload, vectors } ] } (ou point com vários itens)
 * - Array direto de { id, payload, vectors }
 *
 * @param {unknown} body
 * @returns {{ points: Array<{ id: number|string, payload: object, vectors: object }>, error?: string }}
 */
export function normalizePointsInput(body) {
  if (!body || !Array.isArray(body)) {
    return { points: [], error: "Body deve ser um array de pontos ou de { point: [...] }" };
  }

  const points = [];
  for (let i = 0; i < body.length; i++) {
    const item = body[i];
    if (item && typeof item === "object" && "point" in item && Array.isArray(item.point)) {
      for (const p of item.point) {
        if (p && typeof p === "object" && "id" in p && "vectors" in p) {
          points.push({
            id: p.id,
            payload: p.payload && typeof p.payload === "object" ? p.payload : {},
            vectors: p.vectors && typeof p.vectors === "object" ? p.vectors : {},
          });
        }
      }
    } else if (item && typeof item === "object" && "id" in item && "vectors" in item) {
      points.push({
        id: item.id,
        payload: item.payload && typeof item.payload === "object" ? item.payload : {},
        vectors: item.vectors && typeof item.vectors === "object" ? item.vectors : {},
      });
    }
  }

  if (points.length === 0 && body.length > 0) {
    return { points: [], error: "Nenhum ponto válido (cada item deve ter id, payload e vectors)" };
  }
  return { points };
}

/**
 * Insere pontos na coleção Qdrant em lotes.
 *
 * @param {object} params
 * @param {string} params.collectionName - nome da coleção (ex.: COLLECTION_NAME)
 * @param {Array<{ id: number|string, payload: object, vectors: object }>} params.points - pontos no formato Qdrant (vectors = named vectors)
 * @param {number} [params.batchSize=100] - tamanho do lote por requisição
 * @param {boolean} [params.wait=true] - aguardar indexação
 * @returns {Promise<{ upserted: number, batches: number, error?: string }>}
 */
export async function upsertPointsBatch({
  collectionName,
  points,
  batchSize = DEFAULT_BATCH_SIZE,
  wait = true,
}) {
  if (!collectionName || !points || points.length === 0) {
    return { upserted: 0, batches: 0 };
  }

  const size = Math.max(1, Math.min(batchSize, 500));
  let upserted = 0;
  const totalBatches = Math.ceil(points.length / size);

  for (let i = 0; i < points.length; i += size) {
    const batch = points.slice(i, i + size);
    const batchIndex = Math.floor(i / size) + 1;
    try {
      await qdrantClient.upsert(collectionName, {
        wait,
        points: batch,
      });
      upserted += batch.length;
    } catch (err) {
      err.batchIndex = batchIndex;
      err.totalBatches = totalBatches;
      err.collectionName = collectionName;
      throw err;
    }
  }

  return { upserted, batches: totalBatches };
}
