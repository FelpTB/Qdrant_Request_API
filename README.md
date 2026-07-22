# API de Busca Vetorial Multidimensional

API que recebe N vetores de embedding, consulta o Qdrant por **named vectors** e devolve empresas ordenadas por score ponderado. Suporta:

- **Múltiplos vetores densos** (ex.: produto, servico, descricao, publico, cliente) configuráveis via env
- **Busca híbrida com BM25** (vetor esparso na coleção)
- **Filtros keyword** (match exato / lista com OR): `uf`, `cidade`, `modelo_negocio`, `nome_empresa`, `cnpj`
- **Filtros full-text** (busca lexical em texto): `descricao`, `endereco`, `publico`, `site`, `email`, `certificacoes`
- **Filtro negativo** (`filter_not`) para desambiguação (ex.: excluir "combustível" na descrição)
- **Pipeline** de vetorização: PostgreSQL → OpenAI embeddings → Qdrant → marcação de vetorizados

## Requisitos

- **Node.js** >= 18
- **Coleção Qdrant** com vetores nomeados (ex.: `v_produto`, `v_servico`, `v_descricao`, `v_publico`, `v_cliente`), mesma dimensão (ex.: 1536), e opcionalmente vetor esparso BM25

## Configuração

Copie `.env.example` para `.env` e preencha:

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `QDRANT_KEY` | Sim | API key do Qdrant Cloud |
| `CLUSTER_ENDPOINT` | Sim | URL do cluster (ex.: `https://xxx.sa-east-1-0.aws.cloud.qdrant.io`) |
| `COLLECTION_NAME` | Sim | Nome da coleção existente |

### Vetores (dimensionalidade da busca)

- **QDRANT_DIMENSION_KEYS** — Chaves usadas no body da API em `vectors` e `weights`. Padrão: `segmento,produtos,clientes`. Para 5 vetores (esquema atual): `produto,servico,descricao,publico,cliente`.
- **QDRANT_VECTOR_NAMES** — Nomes exatos dos vetores na coleção, **na mesma ordem** que `QDRANT_DIMENSION_KEYS`. Ex.: `v_produto,v_servico,v_descricao,v_publico,v_cliente`.

Exemplo para a coleção com 5 vetores densos + BM25:

```env
QDRANT_DIMENSION_KEYS=produto,servico,descricao,publico,cliente
QDRANT_VECTOR_NAMES=v_produto,v_servico,v_descricao,v_publico,v_cliente
```

### Filtros de payload

- **QDRANT_PAYLOAD_KEYS** — Chaves de filtro **keyword** (match exato / lista OR). Se não definir, a API usa: `modelo_negocio,cidade,uf,nome_empresa,cnpj`. Valores em `cidade` e `uf` são normalizados (maiúsculas, sem acentos).
- **QDRANT_PAYLOAD_KEYS_TEXT** — Chaves de filtro **full-text** (busca lexical no Qdrant). Se não definir, a API usa: `descricao,endereco,publico,site,email,certificacoes`. Devem ser campos com índice text na coleção.

```env
# Opcional; padrões já cobrem o esquema atual
# QDRANT_PAYLOAD_KEYS=modelo_negocio,cidade,uf,nome_empresa,cnpj
# QDRANT_PAYLOAD_KEYS_TEXT=descricao,endereco,publico,site,email,certificacoes
```

### Busca BM25 (híbrida)

- **QDRANT_BM25_VECTOR_NAME** — Nome do vetor esparso BM25 na coleção (ex.: `bm25_complete_profile`). Se definido, o body do POST `/search` pode incluir `bm25_query` e a chave `bm25` em `weights` (soma total = 1.0).
- **QDRANT_BM25_PAYLOAD_KEYS** — (Opcional) Chaves de payload que alimentam o BM25; informativo em GET `/config`.
- **BM25_CANDIDATES_MULTIPLIER** — (Opcional, default 5) Multiplicador de candidatos BM25.
- **RRF_K** — (Opcional, default 60) Parâmetro RRF na fusão de rankings.

### PostgreSQL (marcação de vetorizados e pipeline)

- **DB_URL** — Connection string (ex.: `postgres://user:pass@host:5432/dbname`). Necessário para POST `/company-profiles/mark-vectorized` e para o pipeline de vetorização.
- **OPENAI_API_KEY** — Obrigatório para o pipeline (embeddings).
- Opcionais: `DB_POOL_SIZE`, `MARK_VECTORIZED_CHUNK_SIZE`, `MARK_VECTORIZED_CONCURRENCY`, `OPENAI_EMBED_BATCH_SIZE`, `PIPELINE_CHUNK_SIZE`, `UPSERT_BATCH_SIZE`, `QDRANT_UPSERT_WAIT`, `QDRANT_UPSERT_CONCURRENCY`, `QDRANT_UPSERT_MAX_BATCH`.

Outras: `SEARCH_TIMEOUT_SECONDS`, `PORT`, `HOST`.

### MCP (agentes)

A API expõe um servidor **MCP Streamable HTTP** em `POST/GET/DELETE /mcp` (sem autenticação nesta fase de testes).

Tools:

| Tool | Descrição |
|------|-----------|
| `get_config` | Chaves de dimensões, filtros, BM25 e rerank |
| `search_text` | Busca por texto (mesmo pipeline de `POST /search/text`) com `query`, `queries`, `weights`, `filter`, `filter_not`, `bm25_query`, `bm25`, `limit_per_vector`, `final_limit`, `rerank`, `query_text`, `embed_dimensions` |

URL após deploy no Railway: `https://SUA-API.up.railway.app/mcp`

### Interface X-Ray (teste)

Abra no browser:

`https://SUA-API.up.railway.app/search/xray`

ou localmente `http://localhost:3000/search/xray`.

A página usa um **agente LLM** que, a partir da query do usuário:
1. define `weights`, `queries` (por vetor denso), `bm25_query` e filtros
2. monta o tool call MCP `search_text`
3. executa a busca e mostra o raio-X do tool call + resultados

Endpoint interno: `POST /search/xray/run` com `{ "query": "...", "final_limit": 10 }`.

Teste local (API rodando):

```bash
npm run test:mcp:sdk -- "energia solar"
```

Ou aponte `MCP_URL` no `.env` para a URL pública.

---

## Deploy no Railway

1. Crie um projeto no [Railway](https://railway.app) e conecte este repositório.
2. O Railway detecta Node.js e usa `npm start`. Não é necessário Procfile.
3. Em **Variables** do serviço, defina no mínimo: `QDRANT_KEY`, `CLUSTER_ENDPOINT`, `COLLECTION_NAME`.
4. Opcionalmente: `QDRANT_PAYLOAD_KEYS`, `QDRANT_PAYLOAD_KEYS_TEXT`, `QDRANT_DIMENSION_KEYS`, `QDRANT_VECTOR_NAMES`, `QDRANT_BM25_VECTOR_NAME`, `DB_URL`, `OPENAI_API_KEY` (para pipeline), etc.
5. A URL pública será algo como `https://seu-projeto.up.railway.app`. Use-a nas chamadas (n8n, front, etc.).

A API escuta em `0.0.0.0` na porta definida pelo Railway.

---

## Uso

### GET `/config`

Retorna as chaves de vetores, payload e BM25 configuradas (sem chamar o Qdrant). Use para montar o body do POST `/search` corretamente.

**Resposta (200):**

```json
{
  "dimension_keys": ["produto", "servico", "descricao", "publico", "cliente"],
  "payload_keys": ["modelo_negocio", "cidade", "uf", "nome_empresa", "cnpj"],
  "payload_keys_full_text": ["descricao", "endereco", "publico", "site", "email", "certificacoes"],
  "vector_names": {
    "produto": "v_produto",
    "servico": "v_servico",
    "descricao": "v_descricao",
    "publico": "v_publico",
    "cliente": "v_cliente"
  },
  "filter_not_supported": true,
  "full_text_filter_supported": true,
  "bm25": {
    "vector_name": "bm25_complete_profile",
    "payload_keys": null
  }
}
```

- **dimension_keys** — Chaves obrigatórias em `vectors` e `weights` no POST `/search`.
- **payload_keys** — Chaves de filtro **keyword** (match exato / lista).
- **payload_keys_full_text** — Chaves de filtro **full-text** (busca por texto).
- **vector_names** — Mapeamento chave da API → nome do vetor na coleção.
- **filter_not_supported** — Sempre `true` (a API aceita `filter_not`).
- **full_text_filter_supported** — `true` se houver chaves full-text configuradas.

---

### POST `/search`

Busca por similaridade vetorial (e opcionalmente BM25), com filtros aplicados **antes** da busca.

**Body (JSON):**

```json
{
  "vectors": {
    "produto": [0.1, -0.2, ...],
    "servico": [...],
    "descricao": [...],
    "publico": [...],
    "cliente": [...]
  },
  "weights": {
    "produto": 0.2,
    "servico": 0.2,
    "descricao": 0.2,
    "publico": 0.2,
    "cliente": 0.2
  },
  "limit_per_vector": 50,
  "final_limit": 20,
  "filter": {
    "uf": "SP",
    "cidade": "SAO PAULO",
    "descricao": "energia solar"
  },
  "filter_not": {
    "descricao": "combustível"
  },
  "bm25_query": "tratamento de água"
}
```

| Campo | Obrigatório | Descrição |
|-------|-------------|-----------|
| **vectors** | Sim | Objeto com uma chave por `dimension_keys`; cada valor é um array de floats (mesma dimensão da coleção). |
| **weights** | Sim | Pesos por dimensão (e `bm25` se usar BM25). **Soma deve ser 1.0.** |
| **limit_per_vector** | Sim | Quantos pontos buscar por vetor (e por BM25) antes da fusão. |
| **final_limit** | Sim | Quantos resultados finais retornar após fusão e ordenação. |
| **filter** | Não | Filtro **positivo** (AND entre chaves). Chaves em `payload_keys` → match keyword; chaves em `payload_keys_full_text` → full-text. |
| **filter_not** | Não | Filtro **negativo**: pontos que atendem a qualquer condição são **excluídos** (ex.: desambiguação). Mesmas chaves permitidas que `filter`. |
| **bm25_query** | Não | Texto para busca BM25. Exige `QDRANT_BM25_VECTOR_NAME` e `weights.bm25`. |

**Semântica do filter**

- **Keyword** (`uf`, `cidade`, `modelo_negocio`, `nome_empresa`, `cnpj`):
  - Valor único: match exato. `cidade` e `uf` são normalizados (maiúsculas, sem acentos).
  - Lista ou string com vírgulas: OR (ex.: `uf: ["SP", "MG"]` ou `uf: "SP,MG"`).
- **Full-text** (`descricao`, `endereco`, `publico`, `site`, `email`, `certificacoes`):
  - Valor string (ou array unido por espaço): busca lexical no Qdrant (`match.text`).

**Regra pós-busca:** pontos com **score 0** em **servico** e **produto** ao mesmo tempo são removidos do resultado (evita empresas irrelevantes quando essas dimensões existem).

**Resposta (200):**

```json
{
  "results": [
    {
      "id": 123,
      "score_final": 0.85,
      "payload": { "nome_empresa": "...", "cnpj": "...", "cidade": "SAO PAULO", ... },
      "scores": { "produto": 0.9, "servico": 0.8, "descricao": 0.82, "publico": 0.79, "cliente": 0.81 }
    }
  ]
}
```

Com `?debug=1`: a resposta inclui objeto `debug` (ex.: `points_per_dimension`, `total_after_merge`, `filtered_zero_servico_produto`).

**Erros:** `400` (body inválido, vetor ausente, dimensões incorretas, soma de pesos ≠ 1, chave de filtro não permitida), `500` (erro no Qdrant).

---

### POST `/search/text`

Busca por **texto**: a API gera o embedding com OpenAI (`text-embedding-3-small`) e executa o mesmo pipeline de `POST /search` na coleção padrão (`COLLECTION_NAME`). Ideal para agentes / n8n (não precisa enviar vetores).

Requer `OPENAI_API_KEY`.

**Body (JSON):**

```json
{
  "query": "energia solar fotovoltaica",
  "weights": {
    "produto": 0.3,
    "servico": 0.2,
    "descricao": 0.15,
    "publico": 0.1,
    "cliente": 0.05,
    "bm25": 0.2
  },
  "limit_per_vector": 50,
  "final_limit": 20,
  "filter": { "uf": "SP" },
  "filter_not": { "descricao": "combustível" },
  "bm25_query": "energia solar painel",
  "rerank": true
}
```

| Campo | Obrigatório | Descrição |
|-------|-------------|-----------|
| **query** | Sim | Texto a vetorizar e buscar. |
| **queries** | Não | Objeto opcional com texto por dimensão (`produto`, `servico`, …). Dimensões omitidas usam `query`. |
| **weights** | Não | Pesos por dimensão (+ `bm25` se BM25 ativo). Se omitido, pesos iguais (soma 1.0). |
| **limit_per_vector** | Não | Default `50`. |
| **final_limit** | Não | Default `20`. |
| **filter** / **filter_not** | Não | Mesma semântica de `POST /search`. Aceita objeto ou string JSON. |
| **bm25_query** | Não | Termos BM25. Se omitido e BM25 estiver configurado, usa `query`. Envie `bm25: false` para desligar. |
| **rerank** | Não | `true` (ou `?rerank=1`) ativa reordenação LLM. |
| **query_text** | Não | Texto usado no rerank; default = `query`. |
| **embed_dimensions** | Não | Dimensões do embedding OpenAI (se a coleção usar dim reduzida). |

**Resposta (200):** igual a `POST /search`, com campos extras `query`, `mode: "text"`, `embedding_model`, `embedding_dims`, `query_texts`.

**Erros:** `400` (query ausente / body inválido), `503` (`OPENAI_API_KEY` ausente), `500` (falha OpenAI/Qdrant).

---

### POST `/search/validate-filter`

Testa o filtro **sem** busca vetorial: faz scroll no Qdrant com o filtro mesclado (filter + filter_not) e retorna quantos pontos batem e uma amostra de payloads. Útil para debugar filtros.

**Body (JSON):**

```json
{
  "filter": { "uf": "SP", "cidade": "SAO PAULO" },
  "filter_not": { "descricao": "combustível" },
  "limit": 100
}
```

**Resposta (200):**

```json
{
  "match_count": 42,
  "filter_sent": { "must": [...], "must_not": [...] },
  "sample_payloads": [{ "id": 1, "payload": { ... } }, ...],
  "hint": "..."
}
```

- Use **GET `/config`** para saber `payload_keys` e `payload_keys_full_text` permitidos.
- Dica: cidade/UF no payload do Qdrant devem estar normalizados (maiúsculas, sem acentos). Se não houver hits, confira os dados ou a normalização no pipeline.

---

### GET `/health`

Retorna `{ "status": "ok" }`. Use para health check (n8n, Railway, etc.).

---

### POST `/points/upsert`

Insere/atualiza pontos na coleção em batch. Body: array de pontos ou `{ "points": [...], "batch_size": 100 }`. Cada ponto: `id`, `payload`, `vectors` (objeto com vetores nomeados). Opcionalmente vetor esparso com `{ "text": "...", "model": "qdrant/bm25" }`. Resposta: `{ "ok": true, "upserted": N, "batches": M }`. Limite do body: 50 MB por padrão (`UPSERT_BODY_LIMIT`).

---

### POST `/company-profiles/mark-vectorized`

Marca perfis como vetorizados no PostgreSQL (`busca_fornecedor.company_profile`, coluna `qdrant = true`). Requer `DB_URL`.

**Body:** `{ "cnpjs": ["...", ...] }` ou array direto `["...", ...]`. Resposta: `{ "ok": true, "message": "...", "updated": N, "chunks": M, "concurrency": K }`. Processamento em chunks com workers em paralelo.

---

### Pipeline de vetorização

Fluxo: **PostgreSQL (empresas não vetorizadas) → transformação de perfil → embeddings OpenAI → upsert Qdrant → mark vectorized**.

- **POST `/pipeline/run`** — Inicia o pipeline. Body: `{ "limit": number }` (ex.: 5000). Resposta **202** com `dashboard_url`, `status_url`, `stream_url`. Se já estiver rodando: **409**.
- **GET `/pipeline/status`** — Estado atual (JSON): status, tempos, totais, taxas.
- **GET `/pipeline/stream`** — SSE: envia estado a cada ~1,5 s enquanto estiver rodando.
- **GET `/pipeline/dashboard`** — Página HTML que consome o stream e exibe métricas; inclui formulário para iniciar com um limite.

Requisitos: `DB_URL`, `COLLECTION_NAME`, `OPENAI_API_KEY`, variáveis do Qdrant. Opcionais: `OPENAI_EMBED_BATCH_SIZE`, `PIPELINE_CHUNK_SIZE`, `UPSERT_BATCH_SIZE`, `QDRANT_UPSERT_WAIT`, `QDRANT_UPSERT_CONCURRENCY`, `QDRANT_UPSERT_MAX_BATCH`.

---

## Uso no n8n

1. **HTTP Request (agente / texto)** — Método `POST`, URL `https://SUA-URL-RAILWAY.up.railway.app/search/text?rerank=1`, Body JSON com `query` e opcionalmente `weights`, `filter`, `filter_not`, `bm25_query`, `limit_per_vector`, `final_limit`. A API vetoriza com OpenAI.
2. **HTTP Request (vetores prontos)** — Método `POST`, URL `.../search`, Body JSON com `vectors`, `weights`, `limit_per_vector`, `final_limit` e opcionalmente `filter`, `filter_not`, `bm25_query`.
3. As chaves de `vectors` e `weights` devem ser exatamente as retornadas em **GET `/config`** em `dimension_keys` (e `bm25` em weights se usar BM25).
4. Para filtros, use chaves de `payload_keys` (keyword) e/ou `payload_keys_full_text` (full-text). Ex.: `filter: { uf: "SP", descricao: "energia solar" }`.
5. **GET `/config`** — para listar dimension_keys, payload_keys, payload_keys_full_text e vector_names.
6. **GET `/health`** — para verificar se a API está no ar.

---

## Instalação e execução (local)

```bash
npm install
npm start
```

API sobe em `http://0.0.0.0:3000` (ou `PORT`/`HOST` definidos no `.env`).

---

## Estrutura do projeto

```
src/
  server.js              # Express: /search, /search/text, /search/xray, /mcp, ...
  searchXrayHtml.js      # UI de teste com raio-X dos parâmetros de busca
  mcp/                   # MCP Streamable HTTP (tools get_config, search_text)
    createMcpServer.js
    mountMcp.js
  qdrantClient.js        # Cliente Qdrant Cloud
  multiVectorSearch.js   # Busca por vetores nomeados, fusão, BM25, remoção score 0 servico/produto
  upsertPoints.js        # Normalização e upsert em batch
  db.js                  # Pool PostgreSQL
  markVectorized.js      # Atualização qdrant=true por CNPJ
  fetchCompanyProfiles.js
  transformProfile.js    # Perfil → vetores + payload (filledVectorKeys, normalizeKeyword cidade/uf)
  embeddings.js         # OpenAI embeddings em batch
  pipeline.js            # Orquestração fetch → transform → embed → upsert → mark
  dashboardHtml.js
  normalizeKeyword.js    # NFD, sem acentos, maiúsculas (cidade/uf no filtro e payload)
  logger.js
.env
package.json
```
