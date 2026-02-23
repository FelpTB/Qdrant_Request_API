import { QdrantClient } from "@qdrant/js-client-rest";
import "dotenv/config";

const url = process.env.CLUSTER_ENDPOINT;
const apiKey = process.env.QDRANT_KEY;

if (!url || !apiKey) {
  const hint =
    typeof process.env.RAILWAY_ENVIRONMENT !== "undefined"
      ? " Configure QDRANT_KEY, CLUSTER_ENDPOINT e COLLECTION_NAME em Railway → Variables."
      : " Defina-as no arquivo .env (local) ou nas variáveis de ambiente do provedor.";
  throw new Error(
    "Variáveis CLUSTER_ENDPOINT e QDRANT_KEY são obrigatórias." + hint
  );
}

/** @type {import('@qdrant/js-client-rest').QdrantClient} */
const client = new QdrantClient({
  url,
  apiKey,
  timeout: Number(process.env.SEARCH_TIMEOUT_SECONDS) || 60,
  checkCompatibility: false,
});

export default client;
