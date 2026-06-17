import OpenAI from "openai";

const MODEL = "text-embedding-3-small";
/** Textos por request (OpenAI aceita até 2048; batch maior = menos requests, respeitar RPM do tier). */
const BATCH_SIZE = Math.min(2048, Math.max(1, parseInt(process.env.OPENAI_EMBED_BATCH_SIZE, 10) || 200));

let client = null;

function getClient() {
  if (!client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || typeof key !== "string" || !key.trim()) {
      throw new Error("OPENAI_API_KEY não configurado");
    }
    client = new OpenAI({ apiKey: key.trim() });
  }
  return client;
}

/**
 * Chama a API de embeddings para um array de textos.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts) {
  if (texts.length === 0) return [];
  const openai = getClient();
  const response = await openai.embeddings.create({
    model: MODEL,
    input: texts,
  });
  const order = response.data
    .filter((d) => d.embedding != null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return order.map((d) => d.embedding);
}

/**
 * Gera embedding de um único texto (ex.: query de busca).
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedQueryText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("Texto da query vazio");
  }
  const [embedding] = await embedBatch([trimmed]);
  if (!embedding || embedding.length === 0) {
    throw new Error("OpenAI não retornou embedding para a query");
  }
  return embedding;
}

const VECTOR_KEYS = ["produto", "servico", "descricao", "publico", "cliente"];
const VECTOR_KEY_TO_NAMED = {
  produto: "v_produto",
  servico: "v_servico",
  descricao: "v_descricao",
  publico: "v_publico",
  cliente: "v_cliente",
};

/**
 * Gera embeddings apenas para os campos preenchidos de cada item.
 * Cada item pode ter um subconjunto dos 5 vetores (v_produto, v_servico, v_descricao, v_publico, v_cliente).
 *
 * @param {Array<{ produto: string, servico: string, descricao: string, publico: string, cliente: string, filledVectorKeys: string[] }>} items
 * @returns {Promise<{ vectors: Array<Record<string, number[]>>, errorCount: number, lastError?: string }>}
 */
export async function generateEmbeddingsForItems(items) {
  if (items.length === 0) {
    return { vectors: [], errorCount: 0 };
  }

  let errorCount = 0;
  let lastError = null;

  const runOne = async (key) => {
    const named = VECTOR_KEY_TO_NAMED[key];
    const list = [];
    for (let i = 0; i < items.length; i++) {
      const filled = items[i].filledVectorKeys;
      const text = items[i][key];
      if (filled && filled.includes(key) && text != null && String(text).trim() !== "") {
        list.push({ index: i, text: String(text).trim() });
      }
    }
    if (list.length === 0) return [];
    const texts = list.map((x) => x.text);
    const allEmbeddings = [];
    for (let j = 0; j < texts.length; j += BATCH_SIZE) {
      const chunk = texts.slice(j, j + BATCH_SIZE);
      try {
        const vecs = await embedBatch(chunk);
        allEmbeddings.push(...vecs);
      } catch (err) {
        errorCount += 1;
        lastError = err.message || String(err);
        for (let k = 0; k < chunk.length; k++) {
          allEmbeddings.push([]);
        }
      }
    }
    return list.map((x, idx) => ({ index: x.index, vec: allEmbeddings[idx] || [] }));
  };

  const results = await Promise.all(VECTOR_KEYS.map((key) => runOne(key)));

  const vectors = [];
  for (let i = 0; i < items.length; i++) {
    vectors[i] = {};
  }
  results.forEach((keyResults, keyIdx) => {
    const named = VECTOR_KEY_TO_NAMED[VECTOR_KEYS[keyIdx]];
    for (const { index, vec } of keyResults) {
      if (vec && vec.length > 0) {
        vectors[index][named] = vec;
      }
    }
  });

  return { vectors, errorCount, lastError };
}
