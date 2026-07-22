import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Cria o MCP Server com tools de busca (mesma lógica de POST /search/text).
 * @param {{ executeSearchByText: Function, getPublicConfig: Function }} deps
 */
export function createMcpServer(deps) {
  const { executeSearchByText, getPublicConfig } = deps;

  const server = new McpServer({
    name: "qdrant-busca",
    version: "1.0.0",
  });

  const filterValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]);

  server.registerTool(
    "get_config",
    {
      title: "Configuração da busca",
      description:
        "Retorna as chaves de dimensões, filtros keyword/full-text, vetores e BM25 disponíveis. " +
        "Chame antes de search_text se precisar montar weights, filter ou filter_not corretamente.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const config = getPublicConfig();
      return {
        content: [{ type: "text", text: JSON.stringify(config, null, 2) }],
      };
    },
  );

  server.registerTool(
    "search_text",
    {
      title: "Busca de fornecedores por texto",
      description:
        "Busca empresas/fornecedores na coleção Qdrant a partir de texto livre. " +
        "A API gera embeddings (OpenAI text-embedding-3-small) e executa busca híbrida (vetores densos + BM25). " +
        "Use get_config para ver chaves permitidas em filter/weights. " +
        "Parâmetros opcionais permitem pesos, filtros, BM25, limites e rerank LLM.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Texto principal a vetorizar e buscar (obrigatório)"),
        queries: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Texto por dimensão (ex.: { produto: '...', servico: '...' }). Dimensões omitidas usam query.",
          ),
        weights: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            "Pesos por dimensão (+ bm25 se híbrido). Soma deve ser 1.0. Se omitido, pesos iguais.",
          ),
        filter: z
          .record(z.string(), filterValueSchema)
          .optional()
          .describe(
            'Filtro positivo. Keyword: uf, cidade, modelo_negocio, nome_empresa, cnpj. Full-text: descricao, endereco, publico, site, email, certificacoes. Ex.: { "uf": "SP" } ou { "uf": ["SP","RJ"] }',
          ),
        filter_not: z
          .record(z.string(), filterValueSchema)
          .optional()
          .describe(
            'Filtro negativo (exclusão). Mesmas chaves de filter. Ex.: { "descricao": "combustível" }',
          ),
        bm25_query: z
          .string()
          .optional()
          .describe("Termos BM25. Se omitido e BM25 estiver ativo, usa query. Envie bm25=false para desligar."),
        bm25: z
          .boolean()
          .optional()
          .describe("Se false, desliga BM25 mesmo com QDRANT_BM25_VECTOR_NAME configurado"),
        limit_per_vector: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Candidatos por vetor antes da fusão (default 50)"),
        final_limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Quantidade de resultados finais (default 20)"),
        rerank: z
          .boolean()
          .optional()
          .describe("Se true, reordena o top do pool com LLM"),
        query_text: z
          .string()
          .optional()
          .describe("Texto usado no rerank LLM; default = query"),
        embed_dimensions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Dimensões do embedding OpenAI (só se a coleção usar dim reduzida)"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await executeSearchByText(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const status = err.status ?? err.statusCode ?? 500;
        const message = err.message || "Falha na busca";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: message, status }),
            },
          ],
        };
      }
    },
  );

  return server;
}
