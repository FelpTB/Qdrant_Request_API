import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";

const url = (process.env.CLUSTER_ENDPOINT || "").trim().replace(/^["']|["']$/g, "");
const apiKey = (process.env.QDRANT_KEY || "")
  .trim()
  .replace(/^["']|["']$/g, "");
if (!url || !apiKey) {
  console.error("CLUSTER_ENDPOINT e QDRANT_KEY são obrigatórios");
  process.exit(1);
}
const client = new QdrantClient({ url, apiKey, checkCompatibility: false });
const res = await client.getCollections();
const names = (res.collections || []).map((c) => c.name).filter(Boolean);
console.log("Coleções neste cluster:", names.length ? names.join("\n") : "(nenhuma)");
process.exit(0);
