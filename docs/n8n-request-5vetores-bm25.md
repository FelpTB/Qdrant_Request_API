# n8n — HTTP Request para busca 5 vetores + BM25

Use um nó **HTTP Request** com as opções abaixo. O body em JSON deve seguir o formato da API (5 vetores + BM25).

## Configuração do nó

| Campo | Valor |
|-------|--------|
| **Método** | `POST` |
| **URL** | `https://SUA-URL-RAILWAY.up.railway.app/search` |
| **Authentication** | None |
| **Send Body** | Yes |
| **Body Content Type** | JSON |
| **Specify Body** | Using JSON |

## JSON Body (5 vetores + BM25)

Cole no campo **JSON** do body. Ajuste as expressões conforme os nomes dos campos que vêm do nó anterior (ex.: nós de embedding que geram os 5 vetores).

```json
{
  "vectors": {
    "capacidades": {{ $json.vector_capacidades }},
    "produtos": {{ $json.vector_produtos }},
    "clientes": {{ $json.vector_clientes }},
    "descricao": {{ $json.vector_descricao }},
    "servico": {{ $json.vector_servico }}
  },
  "weights": {
    "capacidades": 0.2,
    "produtos": 0.2,
    "clientes": 0.2,
    "descricao": 0.2,
    "servico": 0.2
  },
  "limit_per_vector": 50,
  "final_limit": 20,
  "filter": {
    "industria": "{{ $json.payload_values.Industria }}",
    "modelo_negocio": "{{ $json.payload_values.Modelo_Negocio }}"
  },
  "bm25_query": "{{ $json.parametros.descricao }}",
  "bm25_weight": 0.3
}
```

## Se os nomes do nó anterior forem outros

- **Vetores:** troque `$json.vector_capacidades` etc. pelos campos onde estão os arrays de embedding (ex.: `$json.embedding_capacidades`).
- **Filtro:** troque `payload_values.Industria` e `Modelo_Negocio` pelas chaves que você envia (devem estar em `QDRANT_PAYLOAD_KEYS` na API). Se você tem `industria_enum` / `modelo_negocio_enum` (arrays), use um valor só no filter, ex.: `"{{ $json.industria_enum[0] }}"` ou um item escolhido.
- **BM25:** troque `$json.parametros.descricao` pelo campo de texto da busca (ex.: descrição + segmento concatenados).

## Variáveis na API (Railway)

Para 5 vetores + BM25, a API precisa destas variáveis no Railway:

- `QDRANT_DIMENSION_KEYS=capacidades,produtos,clientes,descricao,servico`
- `QDRANT_VECTOR_NAMES=v_capacidades,v_produtos,v_clientes,v_descricao,v_servico`
- `QDRANT_PAYLOAD_KEYS=industria,modelo_negocio` (ou as chaves que você usa no `filter`)
- `QDRANT_BM25_VECTOR_NAME=bm25_texto` (ou o nome do vetor BM25 na sua coleção)

## Resposta

Em `$json.results` virá o array de empresas, cada item com `id`, `score_final`, `payload` e `scores` (incluindo `scores.bm25` quando `bm25_query` for enviado).
