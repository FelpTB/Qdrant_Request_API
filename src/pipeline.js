import { fetchCompanyProfiles } from "./fetchCompanyProfiles.js";
import { transformAndFilter } from "./transformProfile.js";
import { generateEmbeddingsForItems } from "./embeddings.js";
import { upsertPointsBatch } from "./upsertPoints.js";
import { markAsVectorized } from "./markVectorized.js";
import { getPool } from "./db.js";

const COLLECTION_NAME = process.env.COLLECTION_NAME;
const PIPELINE_CHUNK_SIZE = Math.min(1000, Math.max(50, parseInt(process.env.PIPELINE_CHUNK_SIZE, 10) || 200));
const UPSERT_BATCH_SIZE = Math.min(1000, Math.max(1, parseInt(process.env.UPSERT_BATCH_SIZE, 10) || 500));
const UPSERT_WAIT = process.env.QDRANT_UPSERT_WAIT === "true";
const UPSERT_CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.QDRANT_UPSERT_CONCURRENCY, 10) || 3));

/**
 * Gera id numérico estável a partir do CNPJ (idempotência no Qdrant).
 * @param {string} cnpj
 * @returns {number}
 */
function pointIdFromCnpj(cnpj) {
  const s = String(cnpj || "").trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

/**
 * Monta um ponto Qdrant a partir de item transformado e vetores.
 * Inclui apenas os named vectors que existem em vecs (campos preenchidos).
 * Se não houver nenhum vetor denso, retorna null (ponto não inserido).
 *
 * @param {object} item - item com payload, bm25Text, cnpj
 * @param {Record<string, number[]>} vecs - ex.: { v_produto, v_descricao } (apenas os preenchidos)
 * @returns {object | null} point { id, payload, vectors } ou null
 */
function buildPoint(item, vecs) {
  const denseKeys = Object.keys(vecs || {}).filter((k) => k.startsWith("v_") && Array.isArray(vecs[k]) && vecs[k].length > 0);
  if (denseKeys.length === 0) return null;

  const id = pointIdFromCnpj(item.cnpj);
  const vectors = { ...vecs };
  vectors.bm25_complete_profile = {
    text: item.bm25Text || " ",
    model: "qdrant/bm25",
  };
  return {
    id,
    payload: item.payload,
    vectors,
  };
}

/** Estado global do pipeline (singleton). */
const pipelineState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  limit: null,
  fetch: { total: 0, success: 0, error: 0, duration_ms: 0, lastError: null },
  transform: { fetched: 0, after_transform: 0 },
  embed: { total: 0, success: 0, error: 0, duration_ms: 0, batches: 0, lastError: null },
  upsert: { total: 0, success: 0, error: 0, duration_ms: 0, batches: 0, lastError: null },
  mark: { updated: 0, chunks: 0, duration_ms: 0, lastError: null },
};

function resetState(limit) {
  pipelineState.status = "running";
  pipelineState.startedAt = Date.now();
  pipelineState.finishedAt = null;
  pipelineState.limit = limit;
  pipelineState.fetch = { total: 0, success: 0, error: 0, duration_ms: 0, lastError: null };
  pipelineState.transform = { fetched: 0, after_transform: 0 };
  pipelineState.embed = { total: 0, success: 0, error: 0, duration_ms: 0, batches: 0, lastError: null };
  pipelineState.upsert = { total: 0, success: 0, error: 0, duration_ms: 0, batches: 0, lastError: null };
  pipelineState.mark = { updated: 0, chunks: 0, duration_ms: 0, lastError: null };
}

export function getPipelineState() {
  return { ...pipelineState };
}

/**
 * Executa o pipeline completo: fetch -> transform -> (embed -> upsert -> mark) por chunks.
 * Atualiza pipelineState durante a execução. Em falha, define status = 'failed' e encerra.
 *
 * @param {number} limit - limite de registros a buscar do banco
 */
export async function runPipeline(limit) {
  if (pipelineState.status === "running") {
    return;
  }
  if (!getPool()) {
    pipelineState.status = "failed";
    pipelineState.finishedAt = Date.now();
    pipelineState.fetch.lastError = "DB_URL não configurado";
    return;
  }
  if (!COLLECTION_NAME) {
    pipelineState.status = "failed";
    pipelineState.finishedAt = Date.now();
    pipelineState.fetch.lastError = "COLLECTION_NAME não configurado";
    return;
  }

  resetState(limit);

  try {
    const t0Fetch = Date.now();
    const rows = await fetchCompanyProfiles(limit);
    pipelineState.fetch.total = rows.length;
    pipelineState.fetch.success = rows.length;
    pipelineState.fetch.duration_ms = Date.now() - t0Fetch;

    const { items, fetched, after_transform } = transformAndFilter(rows);
    pipelineState.transform.fetched = fetched;
    pipelineState.transform.after_transform = after_transform;

    if (items.length === 0) {
      pipelineState.status = "completed";
      pipelineState.finishedAt = Date.now();
      return;
    }

    const chunks = [];
    for (let i = 0; i < items.length; i += PIPELINE_CHUNK_SIZE) {
      chunks.push(items.slice(i, i + PIPELINE_CHUNK_SIZE));
    }

    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];

      const t0Embed = Date.now();
      const { vectors, errorCount, lastError } = await generateEmbeddingsForItems(chunk);
      pipelineState.embed.duration_ms += Date.now() - t0Embed;
      pipelineState.embed.batches += 1;
      pipelineState.embed.total += chunk.length;

      if (errorCount > 0) {
        pipelineState.status = "failed";
        pipelineState.finishedAt = Date.now();
        pipelineState.embed.error += errorCount;
        pipelineState.embed.lastError = lastError || "Erro na geração de embeddings";
        return;
      }
      pipelineState.embed.success += chunk.length;

      const points = chunk.map((item, i) => buildPoint(item, vectors[i] || {})).filter(Boolean);

      const t0Upsert = Date.now();
      const upsertResult = await upsertPointsBatch({
        collectionName: COLLECTION_NAME,
        points,
        batchSize: UPSERT_BATCH_SIZE,
        wait: UPSERT_WAIT,
        concurrency: UPSERT_CONCURRENCY,
      });
      pipelineState.upsert.duration_ms += Date.now() - t0Upsert;
      pipelineState.upsert.total += points.length;
      pipelineState.upsert.success += upsertResult.upserted;
      pipelineState.upsert.batches += upsertResult.batches;

      const cnpjs = points.map((p) => p.payload?.cnpj).filter(Boolean);
      const t0Mark = Date.now();
      const markResult = await markAsVectorized(cnpjs);
      pipelineState.mark.duration_ms += Date.now() - t0Mark;
      pipelineState.mark.updated += markResult.updated;
      pipelineState.mark.chunks += markResult.chunks;
    }

    pipelineState.status = "completed";
    pipelineState.finishedAt = Date.now();
  } catch (err) {
    pipelineState.status = "failed";
    pipelineState.finishedAt = Date.now();
    if (!pipelineState.embed.lastError) pipelineState.embed.lastError = err.message;
    if (!pipelineState.upsert.lastError) pipelineState.upsert.lastError = err.message;
    if (!pipelineState.mark.lastError) pipelineState.mark.lastError = err.message;
    throw err;
  }
}
