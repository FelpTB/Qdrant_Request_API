import qdrantClient from "./qdrantClient.js";

const DEFAULT_BATCH_SIZE = 100;
/** Máximo de pontos por request (Qdrant recomenda 1k–10k para ingest; 1k seguro no free tier). */
const MAX_BATCH_SIZE = Math.min(2000, Math.max(500, parseInt(process.env.QDRANT_UPSERT_MAX_BATCH, 10) || 1000));
/** Concorrência de upserts (requests em paralelo). Free tier: 2–4 para não estourar rate limit. */
const DEFAULT_UPSERT_CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.QDRANT_UPSERT_CONCURRENCY, 10) || 1));
/** Aguardar indexação (false = retorno rápido; true = consistência forte). Pipeline usa false por padrão. */
const DEFAULT_WAIT = process.env.QDRANT_UPSERT_WAIT !== "true";

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
 * Valida body de inserção de um único ponto em coleção informada no request.
 *
 * @param {unknown} body
 * @returns {{ collection: string, point: { id: number|string, payload: object, vectors: object }, error?: string }}
 */
export function normalizeSinglePointInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body deve ser um objeto JSON com 'collection' e 'point'" };
  }

  const collection = typeof body.collection === "string" ? body.collection.trim() : "";
  if (!collection) {
    return { error: "Campo 'collection' é obrigatório (nome da coleção destino)" };
  }

  const { point } = body;
  if (!point || typeof point !== "object" || Array.isArray(point)) {
    return { error: "Campo 'point' é obrigatório (objeto com id, payload e vectors)" };
  }
  if (!("id" in point) || !("vectors" in point)) {
    return { error: "Campo 'point' deve conter id e vectors" };
  }

  return {
    collection,
    point: {
      id: point.id,
      payload: point.payload && typeof point.payload === "object" ? point.payload : {},
      vectors: point.vectors && typeof point.vectors === "object" ? point.vectors : {},
    },
  };
}

/**
 * Insere pontos na coleção Qdrant em lotes.
 * Suporta concorrência limitada (várias requisições em paralelo) e wait=false para maior throughput.
 *
 * @param {object} params
 * @param {string} params.collectionName - nome da coleção (ex.: COLLECTION_NAME)
 * @param {Array<{ id: number|string, payload: object, vectors: object }>} params.points - pontos no formato Qdrant (vectors = named vectors)
 * @param {number} [params.batchSize=100] - tamanho do lote por requisição
 * @param {boolean} [params.wait] - aguardar indexação (default: QDRANT_UPSERT_WAIT env ou false)
 * @param {number} [params.concurrency=1] - quantas requisições de upsert em paralelo (1 = sequencial)
 * @returns {Promise<{ upserted: number, batches: number, error?: string }>}
 */
export async function upsertPointsBatch({
  collectionName,
  points,
  batchSize = DEFAULT_BATCH_SIZE,
  wait = DEFAULT_WAIT,
  concurrency = DEFAULT_UPSERT_CONCURRENCY,
}) {
  if (!collectionName || !points || points.length === 0) {
    return { upserted: 0, batches: 0 };
  }

  const size = Math.max(1, Math.min(batchSize, MAX_BATCH_SIZE));
  const batches = [];
  for (let i = 0; i < points.length; i += size) {
    batches.push(points.slice(i, i + size));
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, batches.length));
  let upserted = 0;

  if (safeConcurrency <= 1) {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        await qdrantClient.upsert(collectionName, { wait, points: batch });
        upserted += batch.length;
      } catch (err) {
        err.batchIndex = i + 1;
        err.totalBatches = batches.length;
        err.collectionName = collectionName;
        throw err;
      }
    }
  } else {
    let nextIndex = 0;
    let workerError = null;
    async function worker() {
      while (workerError == null && nextIndex < batches.length) {
        const i = nextIndex++;
        const batch = batches[i];
        if (!batch.length) continue;
        try {
          await qdrantClient.upsert(collectionName, { wait, points: batch });
          upserted += batch.length;
        } catch (err) {
          workerError = err;
          err.batchIndex = i + 1;
          err.totalBatches = batches.length;
          err.collectionName = collectionName;
          throw err;
        }
      }
    }
    const workers = Array.from({ length: safeConcurrency }, () => worker());
    await Promise.all(workers);
  }

  return { upserted, batches: batches.length };
}
