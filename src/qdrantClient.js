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

/** Inspeção de requisições ao Qdrant: quando LOG_QDRANT_REQUESTS=1, loga no console o body de cada POST ao cluster. */
function installQdrantRequestLogger() {
  const enable = process.env.LOG_QDRANT_REQUESTS === "1" || process.env.DEBUG_QDRANT_REQUESTS === "1";
  if (!enable || !url) return;
  const base = url.replace(/\/$/, "");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const reqUrl = typeof input === "string" ? input : input?.url ?? "";
    const method = (init?.method ?? input?.method ?? "GET").toUpperCase();
    if (reqUrl.startsWith(base) && method === "POST" && init?.body != null) {
      let bodyStr = init.body;
      if (typeof bodyStr !== "string") {
        try {
          bodyStr = await new Response(bodyStr).text();
        } catch {
          bodyStr = String(bodyStr);
        }
      }
      try {
        const parsed = JSON.parse(bodyStr);
        const filterInfo = parsed.filter != null ? { filter: parsed.filter } : { filter: "(ausente)" };
        console.log(`[Qdrant request] ${reqUrl} | filter no body: ${JSON.stringify(filterInfo)}`);
        console.log("[Qdrant request] body completo (resumido):", JSON.stringify({
          ...parsed,
          vector: parsed.vector ? "(vetor presente)" : undefined,
          prefetch: parsed.prefetch ? "(prefetch presente)" : undefined,
          query: parsed.query ? "(query presente)" : undefined,
        }));
      } catch {
        console.log("[Qdrant request]", reqUrl, "body (raw):", bodyStr?.slice?.(0, 500));
      }
      return originalFetch.call(this, input, { ...init, body: bodyStr });
    }
    return originalFetch.call(this, input, init);
  };
}

installQdrantRequestLogger();

/** @type {import('@qdrant/js-client-rest').QdrantClient} */
const client = new QdrantClient({
  url,
  apiKey,
  timeout: (Number(process.env.SEARCH_TIMEOUT_SECONDS) || 120) * 1000,
  checkCompatibility: false,
});

export default client;
