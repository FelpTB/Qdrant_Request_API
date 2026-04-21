import { getPool } from "./db.js";

const SCHEMA = "busca_fornecedor";
const TABLE = "company_profile";

/** Máximo de linhas por query (memória do Node). Lotes maiores usam várias queries no pipeline. */
export const PIPELINE_DB_QUERY_MAX = Math.min(
  100_000,
  Math.max(1000, parseInt(process.env.PIPELINE_DB_QUERY_MAX, 10) || 25_000)
);

const SQL_SELECT = `SELECT cnpj, full_profile, created_at, updated_at, municipio, uf
  FROM ${SCHEMA}.${TABLE}
  WHERE (qdrant IS NULL OR qdrant = false)
  ORDER BY updated_at ASC NULLS LAST
  LIMIT $1`;

/**
 * Busca perfis de empresa ainda não vetorizados (qdrant = false ou null).
 *
 * @param {number} limit - número máximo de registros nesta query (cortado em PIPELINE_DB_QUERY_MAX)
 * @returns {Promise<Array<{ cnpj: string, full_profile: object, created_at?: string, updated_at?: string, municipio?: string, uf?: string }>>}
 */
export async function fetchCompanyProfiles(limit) {
  const pool = getPool();
  if (!pool) {
    throw new Error("DB_URL não configurado");
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, PIPELINE_DB_QUERY_MAX));
  const result = await pool.query(SQL_SELECT, [safeLimit]);
  return result.rows ?? [];
}
