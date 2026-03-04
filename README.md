# API de Busca Vetorial Multidimensional (MVP)

API que recebe N vetores de embedding (por padrão 3: segmento, produtos, clientes), consulta o Qdrant por named vectors e devolve empresas ordenadas por score ponderado. Suporta 3 ou 5 (ou mais) vetores via variáveis de ambiente.

## Requisitos

- Node.js >= 18
- Coleção Qdrant com vetores nomeados (ex.: `v_segmento`, `v_produtos`, `v_clientes` ou 5 vetores com nomes configuráveis; mesma dimensão, ex.: 1536)

## Configuração

Copie `.env` e preencha:

- `QDRANT_KEY` — API key do Qdrant Cloud
- `CLUSTER_ENDPOINT` — URL do cluster (ex.: `https://xxx.sa-east-1-0.aws.cloud.qdrant.io`)
- `COLLECTION_NAME` — Nome da coleção existente

Opcionais: `SEARCH_TIMEOUT_SECONDS`, `PORT`, `HOST` (local use `127.0.0.1` se quiser).

**Filtros de payload** — para aceitar o campo `filter` no POST `/search`, defina `QDRANT_PAYLOAD_KEYS` com as chaves permitidas (as mesmas do payload no banco), ex.:  
`QDRANT_PAYLOAD_KEYS=nome_empresa,cnpj,industria,modelo_negocio,publico_alvo,cobertura_geografica`  
O filtro é aplicado **antes** da busca semântica no Qdrant (apenas pontos que atendem às condições entram na busca).

**Se aparecer erro "Not existing vector name error"** — defina `QDRANT_VECTOR_NAMES` com os nomes exatos dos vetores na coleção, na mesma ordem das dimensões. Para **3 vetores** (padrão):  
`QDRANT_VECTOR_NAMES=v_capacidades,v_produtos,v_clientes`  
Para **5 vetores**, defina também `QDRANT_DIMENSION_KEYS` com as chaves da API na mesma ordem:  
`QDRANT_DIMENSION_KEYS=capacidades,produtos,clientes,descricao,servico`  
`QDRANT_VECTOR_NAMES=v_capacidades,v_produtos,v_clientes,v_descricao,v_servico`  
O body do POST `/search` deve ter `vectors` e `weights` com exatamente essas chaves. Use **GET `/config`** para listar `dimension_keys` e `vector_names` configurados.

**Busca híbrida com BM25** — para usar busca lexical (palavras-chave) nos campos `produtos`, `servicos` e `descricao`, a coleção precisa de um vetor esparso BM25. Defina `QDRANT_BM25_VECTOR_NAME` com o nome desse vetor (ex.: `bm25_texto`). No body do POST `/search` use `bm25_query` (string) e opcionalmente `bm25_weight` (0..1, padrão 0.3). O score BM25 é convertido com **RRF** (Reciprocal Rank Fusion, `1/(k+rank)`) antes da fusão, para estabilidade entre consultas. Candidatos BM25 usam multiplicador 5 por padrão (`BM25_CANDIDATES_MULTIPLIER`); opcional `RRF_K` (default 60). Opcionalmente defina `QDRANT_BM25_PAYLOAD_KEYS` com as chaves de payload que alimentam o vetor BM25 (ex.: `descricao,segmento,categoria`); isso é exposto em **GET `/config`** para quem consome a API.

---

## Deploy no Railway

1. Crie um projeto no [Railway](https://railway.app) e conecte este repositório (ou faça deploy via CLI).
2. O Railway detecta Node.js e usa `npm start` automaticamente. Não é necessário `Procfile`.
3. **Variáveis de ambiente (obrigatório)** — o container **só inicia** se estiverem definidas. No Railway: projeto → seu serviço → **Variables** → **Add Variable** (ou **Raw Editor** para colar várias):
   - `QDRANT_KEY` — API key do Qdrant Cloud
   - `CLUSTER_ENDPOINT` — URL do cluster (ex.: `https://xxx.sa-east-1-0.aws.cloud.qdrant.io`)
   - `COLLECTION_NAME` — nome da coleção
   - (Opcional) `QDRANT_PAYLOAD_KEYS` — chaves de payload permitidas para filtro (ex.: `nome_empresa,industria,modelo_negocio`)
   - (Opcional) `QDRANT_BM25_VECTOR_NAME` — nome do vetor esparso BM25 na coleção (para busca por texto)
   - (Opcional) **5 vetores:** `QDRANT_DIMENSION_KEYS=capacidades,produtos,clientes,descricao,servico` e `QDRANT_VECTOR_NAMES=v_capacidades,v_produtos,v_clientes,v_descricao,v_servico` (mesma ordem)
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

**Health check no n8n:** use um HTTP Request `GET` em `.../health` para verificar se a API está no ar antes de chamar o `/search`. Use **GET `/config`** para listar os payloads e vetores disponíveis (filtro, vetores densos, BM25).

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
  "final_limit": 20,
  "filter": {
    "industria": "Fabricante",
    "modelo_negocio": "B2B"
  },
  "bm25_query": "tratamento de água ETE",
  "bm25_weight": 0.3
}
```

- Soma de `weights` deve ser `1.0`.
- Os vetores são obrigatórios para cada chave em `dimension_keys` (veja GET `/config`). Com 3 dimensões (padrão): `segmento`, `produtos`, `clientes`. Com 5: as chaves definidas em `QDRANT_DIMENSION_KEYS` (ex.: `capacidades`, `produtos`, `clientes`, `descricao`, `servico`). Todos os vetores devem ter a mesma dimensão da coleção.
- **filter** (opcional): objeto com chaves de payload e valores exatos. Só chaves listadas em `QDRANT_PAYLOAD_KEYS` são aceitas. O filtro é aplicado no Qdrant **antes** da busca por similaridade.
- **bm25_query** (opcional): texto para busca BM25. Exige `QDRANT_BM25_VECTOR_NAME`. O vetor esparso deve ter sido construído a partir dos payloads configurados (ex.: produtos, servicos, descricao).
- **bm25_weight** (opcional): peso do score BM25 na fusão (0 a 1; padrão 0.3).

**Exemplo com 5 vetores** (quando `QDRANT_DIMENSION_KEYS` e `QDRANT_VECTOR_NAMES` têm 5 itens):

```json
{
  "vectors": {
    "capacidades": [float, ...],
    "produtos": [float, ...],
    "clientes": [float, ...],
    "descricao": [float, ...],
    "servico": [float, ...]
  },
  "weights": {
    "capacidades": 0.2,
    "produtos": 0.2,
    "clientes": 0.2,
    "descricao": 0.2,
    "servico": 0.2
  },
  "limit_per_vector": 50,
  "final_limit": 20
}
```

**Resposta (200):**

```json
{
  "results": [
    {
      "id": 123,
      "score_final": 0.85,
      "payload": { "nome_empresa": "...", "cnpj": "...", ... },
      "scores": { "segmento": 0.9, "produtos": 0.8, "clientes": 0.82, "bm25": 0.75 }
    }
  ]
}
```

Ordenação: `score_final` decrescente. Com `bm25_query`, `scores.bm25` traz o score BM25 e o `score_final` é a combinação ponderada.

**Erros:** `400` (vetor ausente, dimensões inválidas, pesos ≠ 1, bm25_query sem QDRANT_BM25_VECTOR_NAME), `500` (erro no Qdrant).

### GET `/config`

Retorna os payloads e vetores disponíveis conforme as variáveis de ambiente (sem chamar o Qdrant). Útil para saber quais chaves usar em `filter`, quais vetores densos existem e se o BM25 está configurado.

**Resposta (200):**

```json
{
  "dimension_keys": ["segmento", "produtos", "clientes"],
  "payload_keys": ["industria", "modelo_negocio", "nome_empresa"],
  "vector_names": {
    "segmento": "v_capacidades",
    "produtos": "v_produtos",
    "clientes": "v_clientes"
  },
  "bm25": {
    "vector_name": "bm25_texto",
    "payload_keys": ["descricao", "segmento", "categoria", "subcategoria"]
  }
}
```

- **dimension_keys**: chaves que devem aparecer em `vectors` e `weights` no POST `/search` (variável `QDRANT_DIMENSION_KEYS` ou padrão segmento, produtos, clientes).
- **payload_keys**: chaves de payload permitidas para filtro (variável `QDRANT_PAYLOAD_KEYS`). Use essas chaves no corpo `filter` do POST `/search`.
- **vector_names**: mapeamento da chave da API para o nome do vetor na coleção Qdrant (`QDRANT_VECTOR_NAMES`).
- **bm25.vector_name**: nome do vetor esparso BM25 na coleção (`QDRANT_BM25_VECTOR_NAME`); `null` se não configurado.
- **bm25.payload_keys**: payloads que alimentam o vetor BM25 (`QDRANT_BM25_PAYLOAD_KEYS`, opcional); `null` se não definido.

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
