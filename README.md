# API de Busca Vetorial Multidimensional (MVP)

API que recebe 3 vetores de embedding (segmento, produtos, clientes), consulta o Qdrant por named vectors e devolve empresas ordenadas por score ponderado.

## Requisitos

- Node.js >= 18
- Coleção Qdrant com vetores nomeados: `v_segmento`, `v_produtos`, `v_clientes` (mesma dimensão, ex.: 1536)

## Configuração

Copie `.env` e preencha:

- `QDRANT_KEY` — API key do Qdrant Cloud
- `CLUSTER_ENDPOINT` — URL do cluster (ex.: `https://xxx.sa-east-1-0.aws.cloud.qdrant.io`)
- `COLLECTION_NAME` — Nome da coleção existente

Opcionais: `SEARCH_TIMEOUT_SECONDS`, `PORT`, `HOST` (local use `127.0.0.1` se quiser).

---

## Deploy no Railway

1. Crie um projeto no [Railway](https://railway.app) e conecte este repositório (ou faça deploy via CLI).
2. O Railway detecta Node.js e usa `npm start` automaticamente. Não é necessário `Procfile`.
3. **Variáveis de ambiente** — em **Variables** do serviço, configure:
   - `QDRANT_KEY`
   - `CLUSTER_ENDPOINT`
   - `COLLECTION_NAME`
   - (Opcional) `SEARCH_TIMEOUT_SECONDS`
   - O Railway define `PORT` automaticamente; não é preciso configurá-lo.
4. Após o deploy, a URL pública será algo como `https://qdrant-busca-api-production-xxxx.up.railway.app`. Use-a no n8n.

A API escuta em `0.0.0.0` e na porta definida pelo Railway para funcionar corretamente no ambiente deles.

---

## Uso no n8n

Use o nó **HTTP Request** para chamar a API.

1. **Método:** `POST`
2. **URL:** `https://SUA-URL-RAILWAY.up.railway.app/search`
3. **Authentication:** None (ou adicione header de API key se você implementar depois).
4. **Body Content Type:** `JSON`
5. **Specify Body:** Using JSON
6. **JSON Body:** use uma expressão que monte o payload ou um JSON fixo, por exemplo:

```json
{
  "vectors": {
    "segmento": {{ $json.embedding_segmento }},
    "produtos": {{ $json.embedding_produtos }},
    "clientes": {{ $json.embedding_clientes }}
  },
  "weights": {
    "segmento": 0.4,
    "produtos": 0.3,
    "clientes": 0.3
  },
  "limit_per_vector": 50,
  "final_limit": 20
}
```

Se os embeddings vierem de nós anteriores (ex.: OpenAI Embeddings ou outro modelo), mapeie os outputs para `embedding_segmento`, `embedding_produtos` e `embedding_clientes` e use `$json.embedding_segmento` etc. no body.

**Resposta:** em `$json.results` você terá o array de empresas ordenadas por `score_final`, cada item com `id`, `score_final`, `payload` (nome_empresa, cnpj, etc.) e `scores` por dimensão.

**Health check no n8n:** use um HTTP Request `GET` em `.../health` para verificar se a API está no ar antes de chamar o `/search`.

**Teste rápido:** para testar sem embeddings dinâmicos, use no body arrays de mesmo tamanho da sua coleção (ex.: 1536 floats). Pode gerar no n8n com um nó Code que retorne `vectors: { segmento: [...], produtos: [...], clientes: [...] }` ou colar um JSON de teste.

---

## Instalação e execução (local)

```bash
npm install
npm start
```

## Endpoint

### POST `/search`

**Body (JSON):**

```json
{
  "vectors": {
    "segmento": [float, ...],
    "produtos": [float, ...],
    "clientes": [float, ...]
  },
  "weights": {
    "segmento": 0.4,
    "produtos": 0.3,
    "clientes": 0.3
  },
  "limit_per_vector": 50,
  "final_limit": 20
}
```

- Soma de `weights` deve ser `1.0`.
- Os três vetores são obrigatórios e devem ter a mesma dimensão da coleção.

**Resposta (200):**

```json
{
  "results": [
    {
      "id": 123,
      "score_final": 0.85,
      "payload": { "nome_empresa": "...", "cnpj": "...", ... },
      "scores": { "segmento": 0.9, "produtos": 0.8, "clientes": 0.82 }
    }
  ]
}
```

Ordenação: `score_final` decrescente.

**Erros:** `400` (vetor ausente, dimensões inválidas, pesos ≠ 1), `500` (erro no Qdrant).

### GET `/health`

Retorna `{ "status": "ok" }`.

## Estrutura do projeto

```
src/
  server.js          # Express, POST /search, validações
  qdrantClient.js    # Cliente Qdrant (Cloud)
  multiVectorSearch.js # Busca por v_* e combinação ponderada
.env
package.json
```
