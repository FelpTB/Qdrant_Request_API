import { getPool } from "./db.js";

const SCHEMA = "busca_fornecedor";
const TABLE = "company_profile";
const COLUMN_CNPJ = "cnpj";
const COLUMN_QDRANT = "qdrant";

const CHUNK_SIZE = Math.min(5000, Math.max(200, parseInt(process.env.MARK_VECTORIZED_CHUNK_SIZE, 10) || 1000));
const CONCURRENCY = Math.min(15, Math.max(2, parseInt(process.env.MARK_VECTORIZED_CONCURRENCY, 10) || 8));

const SQL_UPDATE = `UPDATE ${SCHEMA}.${TABLE} SET ${COLUMN_QDRANT} = true WHERE ${COLUMN_CNPJ} = ANY($1::text[]) AND (${COLUMN_QDRANT} IS NULL OR ${COLUMN_QDRANT} = false)`;

/**
 * Executa um lote de UPDATE (uma transação por lote).
 * @param {pg.Pool} pool
 * @param {string[]} cnpjs
 * @returns {Promise<number>} rowCount
 */
async function runChunk(pool, cnpjs) {
  if (cnpjs.length === 0) return 0;
  const client = await pool.connect();
  try {
    const result = await client.query(SQL_UPDATE, [cnpjs]);
    return result.rowCount ?? 0;
  } finally {
    client.release();
  }
}

/**
 * Processa vários chunks em paralelo com limite de concorrência.
 * @param {pg.Pool} pool
 * @param {string[][]} chunks
 * @param {number} concurrency
 * @returns {Promise<number>} total de linhas atualizadas
 */
async function runChunksWithLimit(pool, chunks, concurrency) {
  let total = 0;
  let index = 0;

  async function worker() {
    while (index < chunks.length) {
      const i = index++;
      const chunk = chunks[i];
      if (!chunk || chunk.length === 0) continue;
      try {
        const count = await runChunk(pool, chunk);
        total += count;
      } catch (err) {
        err.chunkIndex = i + 1;
        err.totalChunks = chunks.length;
        err.cnpjsInChunk = chunk.length;
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker());
  await Promise.all(workers);
  return total;
}

/**
 * Marca como vetorizados (qdrant = true) os registros cujo cnpj está na lista.
 * Processa em chunks com concorrência limitada para não estourar o pool.
 *
 * @param {string[]} cnpjs - lista de CNPJ (basico ou completo; formato deve bater com a coluna)
 * @returns {Promise<{ updated: number, chunks: number, concurrency: number }>}
 */
export async function markAsVectorized(cnpjs) {
  const pool = getPool();
  if (!pool) {
    throw new Error("DB_URL não configurado");
  }

  const normalized = cnpjs
    .filter((c) => c != null && typeof c === "string")
    .map((c) => c.trim())
    .filter(Boolean);

  const unique = [...new Set(normalized)];
  if (unique.length === 0) {
    return { updated: 0, chunks: 0, concurrency: CONCURRENCY };
  }

  const chunks = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + CHUNK_SIZE));
  }

  const updated = await runChunksWithLimit(pool, chunks, CONCURRENCY);
  return { updated, chunks: chunks.length, concurrency: CONCURRENCY };
}
