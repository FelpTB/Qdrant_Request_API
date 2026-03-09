import OpenAI from "openai";

const MODEL = "text-embedding-3-small";
const BATCH_SIZE = Math.min(2048, Math.max(1, parseInt(process.env.OPENAI_EMBED_BATCH_SIZE, 10) || 100));

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
 * Gera embeddings para os 5 vetores de um conjunto de itens.
 * Cada item tem: produto, servico, descricao, publico, cliente (strings).
 * Faz até 5 chamadas em paralelo (uma por vetor), subdividindo em batches se necessário.
 *
 * @param {Array<{ produto: string, servico: string, descricao: string, publico: string, cliente: string }>} items
 * @returns {Promise<{ vectors: Array<{ v_produto: number[], v_servico: number[], v_descricao: number[], v_publico: number[], v_cliente: number[] }>, errorCount: number, lastError?: string }>}
 */
export async function generateEmbeddingsForItems(items) {
  if (items.length === 0) {
    return { vectors: [], errorCount: 0 };
  }

  const cols = {
    produto: items.map((i) => i.produto ?? " "),
    servico: items.map((i) => i.servico ?? " "),
    descricao: items.map((i) => i.descricao ?? " "),
    publico: items.map((i) => i.publico ?? " "),
    cliente: items.map((i) => i.cliente ?? " "),
  };

  let errorCount = 0;
  let lastError = null;

  const runOne = async (key) => {
    const texts = cols[key];
    const allEmbeddings = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE);
      try {
        const vecs = await embedBatch(chunk);
        allEmbeddings.push(...vecs);
      } catch (err) {
        errorCount += 1;
        lastError = err.message || String(err);
        for (let j = 0; j < chunk.length; j++) {
          allEmbeddings.push([]);
        }
      }
    }
    return allEmbeddings;
  };

  const [v_produto, v_servico, v_descricao, v_publico, v_cliente] = await Promise.all([
    runOne("produto"),
    runOne("servico"),
    runOne("descricao"),
    runOne("publico"),
    runOne("cliente"),
  ]);

  const vectors = [];
  const n = items.length;
  for (let i = 0; i < n; i++) {
    vectors.push({
      v_produto: v_produto[i] || [],
      v_servico: v_servico[i] || [],
      v_descricao: v_descricao[i] || [],
      v_publico: v_publico[i] || [],
      v_cliente: v_cliente[i] || [],
    });
  }

  return { vectors, errorCount, lastError };
}
