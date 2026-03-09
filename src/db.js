import pg from "pg";

const { Pool } = pg;

const DB_URL = process.env.DB_URL;
const MAX_POOL_SIZE = Math.min(20, Math.max(5, parseInt(process.env.DB_POOL_SIZE, 10) || 10));

/** Pool de conexões PostgreSQL (null se DB_URL não estiver definido). */
let pool = null;

/**
 * Retorna o pool do banco. Só é criado se DB_URL estiver definido.
 * @returns {pg.Pool | null}
 */
export function getPool() {
  if (!DB_URL || typeof DB_URL !== "string" || !DB_URL.trim()) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: DB_URL.trim(),
      max: MAX_POOL_SIZE,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on("error", (err) => {
      console.error("Pool PostgreSQL inesperado:", err.message);
    });
  }
  return pool;
}

/**
 * Verifica se o módulo de banco está disponível (DB_URL configurado).
 * @returns {boolean}
 */
export function isDbConfigured() {
  return Boolean(DB_URL && typeof DB_URL === "string" && DB_URL.trim());
}
