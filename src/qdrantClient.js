import { QdrantClient } from "@qdrant/js-client-rest";
import "dotenv/config";

const url = process.env.CLUSTER_ENDPOINT;
const apiKey = process.env.QDRANT_KEY;

if (!url || !apiKey) {
  throw new Error(
    "Variáveis CLUSTER_ENDPOINT e QDRANT_KEY são obrigatórias no .env"
  );
}

/** @type {import('@qdrant/js-client-rest').QdrantClient} */
const client = new QdrantClient({
  url,
  apiKey,
  timeout: Number(process.env.SEARCH_TIMEOUT_SECONDS) || 30,
});

export default client;
