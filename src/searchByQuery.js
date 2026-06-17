import qdrantClient from "./qdrantClient.js";
import { embedQueryText } from "./embeddings.js";

function normalizePointId(raw) {
  let id = raw;
  if (typeof id === "object") {
    if (id.num !== undefined) id = id.num;
    else if (id.uuid !== undefined) id = id.uuid;
  }
  return typeof id === "number" ? id : String(id);
}

/**
 * Busca por um único vetor denso (coleções com schema simples, ex.: whatsapp_bf).
 *
 * @param {object} params
 * @param {string} params.collectionName
 * @param {number[]} params.embedding
 * @param {string} [params.vectorName] - nome do named vector; omita se a coleção usa vetor default
 * @param {number} params.limit
 * @param {object|null} [params.filter]
 */
export async function searchSingleVector({
  collectionName,
  embedding,
  vectorName,
  limit,
  filter = null,
}) {
  const opts = {
    limit,
    with_payload: true,
    with_vector: false,
    ...(filter && { filter }),
  };
  if (vectorName) {
    opts.vector = { name: vectorName, vector: embedding };
  } else {
    opts.vector = embedding;
  }
  const points = await qdrantClient.search(collectionName, opts);
  return (points ?? []).map((point, index) => ({
    posicao: index + 1,
    id: normalizePointId(point.id),
    score_final: point.score ?? 0,
    payload: point.payload ?? {},
  }));
}

/**
 * Vetoriza a query com OpenAI e executa busca em vetor único.
 *
 * @param {object} params
 * @param {string} params.collectionName
 * @param {string} params.query
 * @param {string} [params.vectorName]
 * @param {number} [params.limit=20]
 * @param {number} [params.embedDimensions]
 * @param {object|null} [params.filter]
 */
export async function searchByTextQuery({
  collectionName,
  query,
  vectorName,
  limit = 20,
  embedDimensions,
  filter = null,
}) {
  const embedding = await embedQueryText(query, embedDimensions);
  const results = await searchSingleVector({
    collectionName,
    embedding,
    vectorName: vectorName || undefined,
    limit,
    filter,
  });
  return { embedding_dims: embedding.length, results };
}
