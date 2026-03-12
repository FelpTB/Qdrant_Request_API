/**
 * Normaliza string para uso em match de payload (filtro e índice).
 * Remove acentos e coloca em maiúsculas para comparação consistente.
 * Ex.: "São Lourenço" e "SAO LOURENCO" → "SAO LOURENCO"
 *
 * @param {string} str
 * @returns {string}
 */
export function normalizeKeyword(str) {
  if (str == null || typeof str !== "string") return "";
  const trimmed = str.trim();
  if (trimmed === "") return "";
  return trimmed
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase();
}
