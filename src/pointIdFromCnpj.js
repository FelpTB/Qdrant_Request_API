/**
 * Gera id numérico estável a partir do CNPJ (idempotência no Qdrant, mesmo algoritmo em todo o upsert).
 * @param {string} cnpj
 * @returns {number}
 */
export function pointIdFromCnpj(cnpj) {
  const s = String(cnpj || "").trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}
