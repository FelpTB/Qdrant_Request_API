# Arquitetura do Sistema

## Visao Geral

```
Supabase (PostgreSQL)          OpenAI API              Qdrant Cloud
  busca_fornecedor.             text-embedding-         company_profiles
  company_profile               3-small (512d)          (sa-east-1)
       |                            |                        |
       v                            v                        v
  [02_indexar_empresas.py] --> gera embeddings --> upsert pontos
  [04_atualizar.py]        --> gera embeddings --> upsert pontos
  [03_buscar.py]           --> gera embedding  --> query_points
```

## Arquivos do Projeto

| Arquivo | Funcao |
|---------|--------|
| `config.py` | Configuracoes centralizadas (env, constantes, pesos, parametros de performance) |
| `utils.py` | Funcoes auxiliares (DB, OpenAI, Qdrant, textos, BM25, embeddings paralelos, logging) |
| `batch_embeddings.py` | Helpers para OpenAI Batch API (criar .jsonl, submit, poll, download) |
| `01_criar_collection.py` | Cria collection no Qdrant (--bulk para desabilitar indexacao, --enable-index) |
| `02_indexar_empresas.py` | Indexacao: --mode parallel (ThreadPool) ou --mode batch (Batch API) |
| `03_buscar.py` | Busca hibrida via CLI (semantica + BM25 + filtros) |
| `04_atualizar.py` | Atualizacao incremental (embeddings paralelos + upload_points) |
| `05_reindexar.py` | Re-indexacao completa (bulk mode + reabilita indexacao) |

## Fluxo de Indexacao — Modo PARALLEL (padrao)

```
1. Conecta ao Supabase, OpenAI e Qdrant
2. Warmup do modelo BM25 FastEmbed
3. Busca todos os perfis com full_profile nao nulo
4. Para cada lote de 5000 registros:
   a. Filtra perfis sem dados uteis (~11% ignorados)
   b. Monta textos para cada vetor
   c. Gera embeddings dos 5 vetores EM PARALELO (ThreadPoolExecutor, 5 workers)
   d. Gera sparse vectors BM25 via FastEmbed (local)
   e. Monta PointStruct com vetores + payload
   f. Envia via upload_points(batch_size=64, parallel=4, max_retries=3)
5. Salva relatorio JSON em logs/
```

## Fluxo de Indexacao — Modo BATCH

```
1. Conecta ao Supabase e prepara todos os perfis
2. Gera arquivo .jsonl com todas as requests de embedding
3. Faz upload do .jsonl para OpenAI e cria batch job
4. Aguarda conclusao via polling (tipicamente minutos a horas)
5. Baixa resultados e mapeia embeddings de volta aos perfis
6. Gera sparse vectors BM25 via FastEmbed (local)
7. Envia todos os pontos via upload_points(batch_size=64, parallel=4)
```

## Fluxo de Busca (03_buscar.py)

```
1. Recebe query do usuario (texto + filtros opcionais UF/Cidade)
2. Gera embedding denso da query via OpenAI
3. Gera sparse vector BM25 da query via FastEmbed
4. Monta query com prefetch aninhado:
   a. Estagio 1 - 5 prefetches densos (um por vetor, limit=50 cada)
   b. Estagio 2 - Fusao dos densos via RRF (limit=100)
   c. Estagio 3 - 1 prefetch BM25 (limit=100)
   d. Fusao final - Densos + BM25 via RRF (limit=20)
5. Aplica filtro de payload (UF/Cidade) se fornecido
6. Retorna resultados formatados
```

## Fluxo de Atualizacao Incremental (04_atualizar.py)

```
1. Le timestamp da ultima atualizacao (.last_update)
2. Busca perfis com updated_at > timestamp
3. Processa igual ao indexador (embeddings + BM25 + upsert)
4. Salva novo timestamp
```

## Tipos de Vetores na Collection

A collection `company_profiles` armazena **dois tipos diferentes** de vetores por ponto:

### Vetores Densos (5 named vectors)

Gerados pela OpenAI (`text-embedding-3-small`). Cada vetor tem 512 numeros decimais (todas as posicoes preenchidas). Capturam o **significado semantico** do texto — entendem sinonimos, contexto e conceitos relacionados.

Exemplo: buscar "equipamentos para hospital" encontra uma empresa que vende "materiais cirurgicos" mesmo sem nenhuma palavra em comum, porque o modelo entende que sao conceitos relacionados.

| Vetor | O que captura |
|-------|--------------|
| `produto` | Significado semantico dos produtos oferecidos |
| `servico` | Significado semantico dos servicos prestados |
| `descricao` | Significado semantico da descricao geral da empresa |
| `publico` | Significado semantico do publico-alvo e industria |
| `cliente` | Significado semantico da carteira de clientes |

### Vetor Esparso BM25 (1 sparse vector)

Gerado pelo FastEmbed localmente (modelo `Qdrant/bm25`). Diferente dos densos, tem milhares de posicoes possiveis mas **so algumas preenchidas** (por isso "esparso"). Funciona por **correspondencia exata de palavras-chave** — similar a um motor de busca tradicional como o Google.

Exemplo: buscar "Endobag" encontra exatamente empresas que mencionam "Endobag" no perfil. Um vetor denso poderia confundir com outros produtos medicos genericos.

O texto de entrada do BM25 e a concatenacao de todos os campos (nome, descricao, produtos, servicos, publico, clientes, certificacoes), maximizando a cobertura de palavras-chave.

### Por que precisamos dos dois tipos?

Cada tipo tem pontos fortes e fracos complementares:

| Cenario de busca | Semantico (denso) | BM25 (esparso) |
|------------------|-------------------|----------------|
| Nome tecnico exato ("Endobag") | Fraco — pode confundir com produtos similares | **Forte** — match exato da palavra |
| Busca conceitual ("equipamentos para hospital") | **Forte** — entende o conceito | Fraco — nao tem as palavras exatas |
| Busca mista ("manutencao de motores WEG") | Bom no conceito, pode errar a marca | Bom na marca, pode errar o conceito |
| Siglas e codigos ("NBR ISO 9001") | Fraco — siglas confundem embeddings | **Forte** — match exato |

Combinando os dois via RRF, empresas que aparecem bem ranqueadas em **ambas** as buscas sao priorizadas. Isso produz resultados significativamente melhores do que usar apenas um dos dois metodos isoladamente.

---

## Estrategia de Busca Hibrida

### Reciprocal Rank Fusion (RRF)

A formula RRF combina rankings de multiplas buscas:

```
RRF_score(d) = sum( 1 / (k + rank_i(d)) ) para cada busca i
```

Onde `k` e uma constante (tipicamente 60) que suaviza a contribuicao de rankings baixos.

### Dois estagios de fusao

1. **Fusao densa:** Os 5 vetores semanticos sao combinados via RRF. Um documento que aparece bem ranqueado em multiplos vetores (ex: bom em "produto" E em "descricao") recebe score maior.

2. **Fusao final:** O resultado denso e combinado com BM25 via RRF. Isso garante que:
   - Documentos semanticamente relevantes (mesmo sem palavras exatas) aparecem
   - Documentos com match exato de palavras-chave tambem aparecem
   - Documentos que satisfazem ambos os criterios sao priorizados

### Pesos futuros (quando atualizar para qdrant-client 1.17+)

Os pesos ja estao definidos em `config.py`:

```python
VECTOR_WEIGHTS = {
    "produto": 0.30,   # Maior peso - match de produto e mais importante
    "servico": 0.25,
    "descricao": 0.20,
    "publico": 0.15,
    "cliente": 0.10,   # Menor peso - clientes sao indicativo indireto
}

SEMANTIC_WEIGHT = 0.70  # Semantica domina
BM25_WEIGHT = 0.30      # BM25 complementa
```

## Padroes de Codigo

- **Singleton para BM25:** `get_bm25_model()` em `utils.py` evita recarregar o modelo a cada chamada
- **Embeddings paralelos:** `generate_embeddings_parallel()` usa ThreadPoolExecutor para gerar os 5 vetores simultaneamente
- **upload_points:** Substitui upsert manual. Batch automatico (64 pontos), paralelismo (4 processos), retries built-in
- **Bulk mode:** `01_criar_collection.py --bulk` desabilita HNSW durante carga, `--enable-index` reabilita
- **Dois modos de embedding:** `--mode parallel` (tempo real) ou `--mode batch` (50% mais barato)
- **Logging duplo:** Console + arquivo para cada script
- **Relatorios JSON:** Estatisticas salvas em `logs/` para auditoria
- **Filtro de perfis vazios:** `has_useful_text()` evita gerar embeddings para perfis sem conteudo
