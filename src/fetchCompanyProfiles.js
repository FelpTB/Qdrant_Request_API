import { getPool } from "./db.js";

const SCHEMA = "busca_fornecedor";
const TABLE = "company_profile";

const SQL_SELECT = `SELECT cnpj, full_profile, created_at, updated_at, municipio, uf
  FROM ${SCHEMA}.${TABLE}
  WHERE (qdrant IS NULL OR qdrant = false)
  ORDER BY updated_at ASC NULLS LAST
  LIMIT $1`;

/**
 * Busca perfis de empresa ainda não vetorizados (qdrant = false ou null).
 *
 * @param {number} limit - número máximo de registros
 * @returns {Promise<Array<{ cnpj: string, full_profile: object, created_at?: string, updated_at?: string, municipio?: string, uf?: string }>>}
 */
export async function fetchCompanyProfiles(limit) {
  const pool = getPool();
  if (!pool) {
    throw new Error("DB_URL não configurado");
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 50000));
  const result = await pool.query(SQL_SELECT, [safeLimit]);
  return result.rows ?? [];
}
