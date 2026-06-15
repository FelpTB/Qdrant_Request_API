/**
 * Estatísticas de pontos no Qdrant: nome_empresa vazio, ≤2 vetores densos, payload+vetores completos.
 * Uso: node scripts/qdrant-point-stats.mjs
 * Lê .env: CLUSTER_ENDPOINT, QDRANT_KEY, COLLECTION_NAME (ou COLLECTION_NAM), optional CLUSTER_ID (só validação do host), QDRANT_VECTOR_NAMES, QDRANT_PAYLOAD_KEYS.
 */
import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "qdrant-point-stats-output.json");

const url = (process.env.CLUSTER_ENDPOINT || "").trim().replace(/^["']|["']$/g, "");
/** Chave com aspas/ espaços a mais no .env não deve falhar. */
const apiKey = (process.env.QDRANT_KEY || "")
  .trim()
  .replace(/^["']|["']$/g, "");
/** Alias comum: COLLECTION_NAM (E final em falta). */
const collectionName = process.env.COLLECTION_NAME || process.env.COLLECTION_NAM;

if (!url || !apiKey || !collectionName) {
  console.error("Defina CLUSTER_ENDPOINT, QDRANT_KEY e COLLECTION_NAME (ou COLLECTION_NAM) no .env.");
  process.exit(1);
}

const clusterId = process.env.CLUSTER_ID?.replace(/"/g, "").trim();
if (clusterId && !new URL(url).hostname.startsWith(clusterId)) {
  console.warn(
    "[aviso] CLUSTER_ID não coincide com o host de CLUSTER_ENDPOINT; confirme a URL no Qdrant Cloud (Cluster → Connect)."
  );
}

/**
 * Qdrant Cloud: API REST no host HTTPS na porta 6333 (não 443). O js-client usa 6333
 * se a URL não tiver porta — não forçar 443.
 * Opcional: QDRANT_API_PORT para self-hosted (ex. 80, 443, 6333).
 */
function urlToClientOptions(u) {
  const explicit = process.env.QDRANT_API_PORT;
  if (explicit) {
    const n = parseInt(explicit, 10);
    if (Number.isFinite(n)) {
      return { url: u, port: n, apiKey, checkCompatibility: false };
    }
  }
  return { url: u, apiKey, checkCompatibility: false };
}

const client = new QdrantClient({
  ...urlToClientOptions(url),
  timeout: (Number(process.env.SEARCH_TIMEOUT_SECONDS) || 300) * 1000,
});

const DEFAULT_KEYWORD_PAYLOAD = ["modelo_negocio", "cidade", "uf", "nome_empresa", "cnpj"];

function getKeywordPayloadKeys() {
  const env = process.env.QDRANT_PAYLOAD_KEYS;
  if (env && typeof env === "string") {
    const keys = env.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length > 0) return keys;
  }
  return DEFAULT_KEYWORD_PAYLOAD;
}

function isNonEmptyString(v) {
  return v != null && String(v).trim() !== "";
}

function cnpjHasDigits(p) {
  return String(p?.cnpj ?? "").replace(/\D/g, "").length > 0;
}

function isNomeEmpresaFilled(payload) {
  return payload && isNonEmptyString(payload.nome_empresa);
}

/** Só vetores densos; sparse_vectors da coleção não entram. */
function getDenseVectorNamesFromCollection(collection) {
  const fromEnv = process.env.QDRANT_VECTOR_NAMES;
  if (fromEnv && typeof fromEnv === "string") {
    const names = fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length > 0) return names;
  }
  const params = collection?.config?.params;
  const named = params?.vectors;
  if (named && typeof named === "object" && !Array.isArray(named)) {
    return Object.keys(named);
  }
  if (Array.isArray(named) && named.length > 0) {
    return ["default"];
  }
  return [];
}

function isValidDenseVector(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && !Number.isNaN(x));
}

function countPresentDense(vectors, denseNames) {
  if (!vectors || !denseNames.length) return 0;
  let n = 0;
  for (const name of denseNames) {
    const v = vectors[name];
    if (isValidDenseVector(v)) n++;
  }
  return n;
}

function isPayloadCompleteForKeywords(payload, keys) {
  for (const k of keys) {
    if (k === "cnpj") {
      if (!cnpjHasDigits(payload)) return false;
    } else if (!isNonEmptyString(payload?.[k])) {
      return false;
    }
  }
  return true;
}

async function main() {
  const col = await client.getCollection(collectionName);
  const denseNames = getDenseVectorNamesFromCollection(col);
  const payloadKeys = getKeywordPayloadKeys();

  const expectedDense = denseNames.length;

  const semNomeEmpresa = [];
  const ateDoisVetores = [];
  const completos = [];

  let total = 0;
  let nextPage = null;
  const batch = 256;

  console.log("Coleção:", collectionName);
  console.log("Vetores densos considerados:", denseNames.length ? denseNames.join(", ") : "(nenhum — verifique a coleção)");
  console.log("Chaves de payload (completude):", payloadKeys.join(", "));
  console.log("Scroll com with_vector (lotes de " + batch + ")…");

  for (;;) {
    const res = await client.scroll(collectionName, {
      limit: batch,
      offset: nextPage,
      with_payload: true,
      with_vector: denseNames.length > 0 ? denseNames : true,
    });
    const points = res.points ?? [];
    for (const p of points) {
      total++;
      const payload = p.payload ?? {};
      const vectors = p.vectors;
      if (!isNomeEmpresaFilled(payload)) semNomeEmpresa.push(p.id);
      const present = countPresentDense(vectors, denseNames);
      if (present <= 2) ateDoisVetores.push(p.id);
      const allDense = expectedDense > 0 && present === expectedDense;
      const payloadOk = isPayloadCompleteForKeywords(payload, payloadKeys);
      if (allDense && payloadOk) completos.push(p.id);
    }
    nextPage = res.next_page_offset ?? res.nextPageOffset;
    if (!nextPage) break;
  }

  const out = {
    collection: collectionName,
    total_points: total,
    criterios: {
      sem_nome_empresa: "chave ausente, null ou string só em branco após trim",
      ate_2_vetores_densos: `até 2 dos ${expectedDense} vetores densos com embedding válido (não nulo)`,
      completos: `todos os ${expectedDense} vetores densos presentes + chaves keyword preenchidas: ${payloadKeys.join(", ")} (cnpj: pelo menos um dígito)`,
    },
    nome_empresa_nao_preenchido: {
      count: semNomeEmpresa.length,
      point_ids: semNomeEmpresa,
    },
    dois_ou_menos_vetores_densos: {
      count: ateDoisVetores.length,
      point_ids: ateDoisVetores,
    },
    payload_e_vetores_completos: {
      count: completos.length,
      point_ids: completos,
    },
  };

  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log("\nResumo:");
  console.log("  Total de pontos:", total);
  console.log("  Sem nome_empresa preenchido:", semNomeEmpresa.length);
  console.log("  Com 2 ou menos vetores densos:", ateDoisVetores.length);
  console.log("  Payload+vetores completos (regra acima):", completos.length);
  console.log("\nLista completa de IDs em:", outPath);
}

main().catch((e) => {
  const status = e?.status ?? e?.statusCode;
  const body = e?.data && typeof e.data === "string" ? e.data : e?.data?.status?.error;
  const msg = body || e?.data?.status?.error || e?.message || String(e);
  console.error(msg);
  if (status === 404 || msg === "Not Found") {
    console.error(
      "\n(404) Confirma no Qdrant Cloud: Cluster → Connect, URL https://<id>.<região>.cloud.qdrant.io (API REST, porta 6333 por omissão no Node). " +
        "Coleção: COLLECTION_NAME com o nome exato."
    );
  }
  if (status === 403 || /forbidden/i.test(String(msg))) {
    console.error(
      "\n(403 Forbidden) A ligação ao host está a funcionar, mas a API key é recusada. Corrige assim:\n" +
        "  • No Qdrant Cloud, abre ESTE cluster → separador Connect (ou Data Access).\n" +
        "  • Cria/copia a API key do cluster (acesso à base de dados) — NÃO use só a 'Cloud API' de gestão de contas (api.cloud.qdrant.io).\n" +
        "  • Cola em QDRANT_KEY no .env. Cada cluster novo precisa de uma chave desse ecrã (a chave antiga de outro cluster deixa de servir se mudaste de cluster).\n" +
        "  • Garante que o host no CLUSTER_ENDPOINT é o do mesmo cluster para o qual geras a chave."
    );
  }
  process.exit(1);
});
