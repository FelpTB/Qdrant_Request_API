import qdrantClient from "./qdrantClient.js";

const RRF_K = 10;

function getQdrantVectorNames(vectorNamesMap) {
  return vectorNamesMap ? Object.values(vectorNamesMap) : ["v_segmento", "v_produtos", "v_clientes"];
}

function getDimensionKeysFromMap(vectorNamesMap) {
  return vectorNamesMap ? Object.keys(vectorNamesMap) : ["segmento", "produtos", "clientes"];
}

function getBm25VectorName() {
  const env = process.env.QDRANT_BM25_VECTOR_NAME;
  return env && typeof env === "string" ? env.trim() : null;
}

function getBm25Model() {
  const env = process.env.QDRANT_BM25_MODEL;
  return env && typeof env === "string" ? env.trim() : "qdrant/bm25";
}

function getBm25RrfK() {
  const n = Number(process.env.RRF_K);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

function getBm25ModifierBoost() {
  const n = Number(process.env.BM25_MODIFIER_BOOST);
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

function getBm25ModifierAbsent() {
  const n = Number(process.env.BM25_MODIFIER_ABSENT);
  return Number.isFinite(n) && n > 0 ? n : 0.85;
}

function getPathTopN() {
  const n = Number(process.env.PATH_TOP_N);
  return Number.isFinite(n) && n >= 5 ? Math.round(n) : 20;
}

function getLlmRerankPoolSize() {
  const n = Number(process.env.LLM_RERANK_POOL);
  return Number.isFinite(n) && n >= 3 ? Math.round(n) : 20;
}

function normalizePointId(raw) {
  let id = raw;
  if (typeof id === "object") {
    if (id.num !== undefined) id = id.num;
    else if (id.uuid !== undefined) id = id.uuid;
  }
  return typeof id === "number" ? id : String(id);
}

function buildDenseFilter(originalFilter, prefetchIds) {
  if (!prefetchIds || prefetchIds.length === 0) return originalFilter;
  const hasIdCondition = { has_id: prefetchIds };
  if (!originalFilter) return { must: [hasIdCondition] };
  const merged = { ...originalFilter };
  merged.must = [...(merged.must || []), hasIdCondition];
  return merged;
}

// ---------------------------------------------------------------------------
// Shared data collection helpers
// ---------------------------------------------------------------------------

async function fetchBm25(collection, bm25Query, bm25VectorName, limit, filter) {
  const rrfK = getBm25RrfK();
  const opts = {
    query: { text: bm25Query.trim(), model: getBm25Model() },
    using: bm25VectorName,
    limit,
    with_payload: true,
    with_vector: false,
    ...(filter && { filter }),
  };
  const response = await qdrantClient.query(collection, opts);
  const points = Array.isArray(response)
    ? response
    : (response?.result?.points ?? response?.points ?? []);

  const byId = {};
  let maxRrf = 0;
  const idList = [];

  points.forEach((point, index) => {
    const rank = index + 1;
    const rrfScore = 1 / (rrfK + rank);
    const id = normalizePointId(point.id);
    idList.push(id);
    byId[id] = {
      payload: point.payload ?? {},
      bm25_raw: point.score ?? 0,
      bm25_rrf: rrfScore,
      rank,
    };
    if (rrfScore > maxRrf) maxRrf = rrfScore;
  });

  const norm = maxRrf > 0 ? maxRrf : 1;
  for (const item of Object.values(byId)) {
    item.bm25_normalized = item.bm25_rrf / norm;
  }

  return { byId, idList, count: points.length };
}

async function fetchDenseAll(collection, dimensionKeys, vectorNames, vectors, limitPerVector, filter) {
  const promises = dimensionKeys.map(async (dim, index) => {
    const points = await qdrantClient.search(collection, {
      vector: { name: vectorNames[index], vector: vectors[dim] },
      limit: limitPerVector,
      with_payload: true,
      with_vector: false,
      ...(filter && { filter }),
    });
    return { dim, points };
  });
  const results = await Promise.all(promises);

  const byId = {};
  for (const { dim, points } of results) {
    for (const point of points) {
      const id = normalizePointId(point.id);
      if (!byId[id]) {
        byId[id] = { payload: point.payload ?? {}, scores: {} };
      }
      byId[id].scores[dim] = point.score ?? 0;
      if (point.payload) byId[id].payload = point.payload;
    }
  }
  return byId;
}

function computeDenseScore(scores, dimensionKeys, weights) {
  let total = 0;
  for (const dim of dimensionKeys) {
    total += (scores[dim] ?? 0) * (weights[dim] ?? 0);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Path A (BM25-First): BM25 seleciona pool → dense rankeia dentro
// ---------------------------------------------------------------------------

function runPathA(densePrefetchById, bm25ById, dimensionKeys, weights, bm25Weight, topN) {
  const allIds = new Set([...Object.keys(densePrefetchById), ...Object.keys(bm25ById)]);
  const results = [];
  for (const pid of allIds) {
    const dItem = densePrefetchById[pid];
    const bItem = bm25ById[pid];
    const dimScores = dItem ? { ...dItem.scores } : {};
    const ds = dItem ? computeDenseScore(dItem.scores, dimensionKeys, weights) : 0;
    const bm25Norm = bItem ? bItem.bm25_normalized : 0;
    const bm25Add = bm25Weight * bm25Norm;
    const score = ds + bm25Add;
    if (score <= 0) continue;
    if (dItem) {
      const s = dItem.scores.servico ?? 0;
      const p = dItem.scores.produto ?? 0;
      if (s === 0 && p === 0 && ds === 0) continue;
    } else if (ds === 0) {
      continue;
    }
    results.push({
      id: pid,
      payload: dItem?.payload ?? bItem?.payload ?? {},
      score,
      dim_scores: dimScores,
      bm25_norm: Math.round(bm25Norm * 1e4) / 1e4,
      dense_total: Math.round(ds * 1e6) / 1e6,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topN);
}

// ---------------------------------------------------------------------------
// Path B (Dense-First + BM25 Modifier): dense banco inteiro → BM25 modifica
// ---------------------------------------------------------------------------

function runPathB(denseFullById, bm25ById, dimensionKeys, weights, topN) {
  const boost = getBm25ModifierBoost();
  const absent = getBm25ModifierAbsent();
  const results = [];
  for (const [pid, item] of Object.entries(denseFullById)) {
    const ds = computeDenseScore(item.scores, dimensionKeys, weights);
    if (ds <= 0) continue;
    const inBm25 = pid in bm25ById;
    const bm25Norm = inBm25 ? bm25ById[pid].bm25_normalized : 0;
    const bm25Mod = inBm25 ? 1.0 + (bm25Norm * boost) : absent;
    results.push({
      id: pid,
      payload: item.payload,
      score: ds * bm25Mod,
      dim_scores: { ...item.scores },
      bm25_norm: Math.round(bm25Norm * 1e4) / 1e4,
      bm25_modifier: Math.round(bm25Mod * 1e4) / 1e4,
      dense_total: Math.round(ds * 1e6) / 1e6,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topN);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function multiVectorSearch({
  vectors,
  weights,
  vectorNamesMap,
  limitPerVector,
  finalLimit,
  collectionName,
  filter = null,
  filterNotPredicates = [],
  bm25Query = null,
  returnDebugCounts = false,
}) {
  const dimensionKeys = getDimensionKeysFromMap(vectorNamesMap);
  const vectorNames = getQdrantVectorNames(vectorNamesMap);
  if (dimensionKeys.length !== vectorNames.length) {
    throw new Error("vectorNamesMap: número de chaves deve coincidir com o número de nomes de vetor");
  }

  const collection = collectionName;
  const bm25VectorName = getBm25VectorName();
  const useBm25 = Boolean(bm25Query && bm25Query.trim() && bm25VectorName);
  const bm25Weight = useBm25 ? (Number(weights.bm25) || 0) : 0;
  const topN = getPathTopN();

  // Stage 1: Fetch BM25 + Dense full bank in parallel
  const bm25Promise = useBm25
    ? fetchBm25(collection, bm25Query, bm25VectorName, 200, filter)
    : Promise.resolve({ byId: {}, idList: [], count: 0 });

  const denseFullPromise = fetchDenseAll(
    collection, dimensionKeys, vectorNames, vectors, limitPerVector, filter
  );

  const [bm25Data, denseFullById] = await Promise.all([bm25Promise, denseFullPromise]);
  const bm25ById = bm25Data.byId;
  const bm25IdList = bm25Data.idList;

  // Stage 1b: Fetch dense within BM25 prefetch pool (for Path A)
  const prefetchIds150 = bm25IdList.slice(0, 150);
  const densePrefetchById = prefetchIds150.length > 0
    ? await fetchDenseAll(collection, dimensionKeys, vectorNames, vectors, limitPerVector, buildDenseFilter(filter, prefetchIds150))
    : {};

  // Stage 2: Run 2 paths
  const denseWeights = {};
  for (const d of dimensionKeys) denseWeights[d] = weights[d] ?? 0;

  const pathA = runPathA(densePrefetchById, bm25ById, dimensionKeys, denseWeights, bm25Weight, topN);
  const pathB = runPathB(denseFullById, bm25ById, dimensionKeys, denseWeights, topN);

  // Stage 3: RRF merge — direct A+B with per-dimension score propagation
  const pathAById = {};
  pathA.forEach((item, i) => { pathAById[item.id] = { ...item, rank: i + 1 }; });
  const pathBById = {};
  pathB.forEach((item, i) => { pathBById[item.id] = { ...item, rank: i + 1 }; });

  const allIds = new Set([...pathA.map((i) => i.id), ...pathB.map((i) => i.id)]);
  const merged = [];

  for (const pid of allIds) {
    const itemA = pathAById[pid];
    const itemB = pathBById[pid];
    let rrfScore = 0;
    const paths = [];
    if (itemA) { rrfScore += 1 / (RRF_K + itemA.rank); paths.push(`A#${itemA.rank}`); }
    if (itemB) { rrfScore += 1 / (RRF_K + itemB.rank); paths.push(`B#${itemB.rank}`); }

    const avgDimScores = {};
    for (const dim of dimensionKeys) {
      const vA = itemA?.dim_scores?.[dim];
      const vB = itemB?.dim_scores?.[dim];
      if (vA !== undefined && vB !== undefined) {
        avgDimScores[dim] = (vA + vB) / 2;
      } else {
        avgDimScores[dim] = vA ?? vB ?? 0;
      }
    }

    const bm25A = itemA?.bm25_norm ?? 0;
    const bm25B = itemB?.bm25_norm ?? 0;
    const avgBm25 = (itemA && itemB) ? (bm25A + bm25B) / 2 : (bm25A || bm25B);

    let scorePonderado = 0;
    for (const dim of dimensionKeys) {
      scorePonderado += avgDimScores[dim] * (denseWeights[dim] ?? 0);
    }
    scorePonderado += bm25Weight * avgBm25;

    const round4 = (n) => Math.round(n * 1e4) / 1e4;
    const scores = {};
    for (const dim of dimensionKeys) scores[dim] = round4(avgDimScores[dim]);
    scores.bm25 = round4(avgBm25);

    merged.push({
      id: pid,
      payload: itemA?.payload ?? itemB?.payload ?? {},
      score_final: Math.round(scorePonderado * 1e6) / 1e6,
      score_rrf: Math.round(rrfScore * 1e6) / 1e6,
      scores,
      paths,
      n_paths: paths.length,
      in_both: Boolean(itemA && itemB),
    });
  }
  merged.sort((a, b) => b.score_rrf - a.score_rrf);

  // Stage 4: Post-processing filters
  let filtered = merged;
  const beforeFilterNot = filtered.length;
  if (Array.isArray(filterNotPredicates) && filterNotPredicates.length > 0) {
    filtered = filtered.filter(
      (item) => !filterNotPredicates.some((pred) => pred(item.payload ?? {}))
    );
  }
  const filteredByFilterNot = beforeFilterNot - filtered.length;

  // Stage 5: Build LLM re-rank pool (top N by score)
  const llmPoolSize = getLlmRerankPoolSize();
  const llmPool = filtered.slice(0, llmPoolSize);
  const restAfterPool = filtered.slice(llmPoolSize);

  const resultsSlice = filtered.slice(0, finalLimit);

  if (returnDebugCounts) {
    const round6 = (n) => Math.round(n * 1e6) / 1e6;
    const round4 = (n) => Math.round(n * 1e4) / 1e4;

    const pathDetail = (list) => list.map((item, i) => {
      const detail = {
        rank: i + 1,
        id: item.id,
        nome_empresa: item.payload?.nome_empresa ?? "N/A",
        industria: item.payload?.industria ?? "N/A",
        produto: String(item.payload?.produto ?? "").slice(0, 120),
        servico: String(item.payload?.servico ?? "").slice(0, 120),
        score: round6(item.score),
        dense_total: item.dense_total ?? 0,
        bm25_norm: item.bm25_norm ?? 0,
      };
      if (item.bm25_modifier !== undefined) detail.bm25_modifier = item.bm25_modifier;
      if (item.dim_scores) {
        for (const [dim, val] of Object.entries(item.dim_scores)) {
          detail[`v_${dim}`] = round4(val);
        }
      }
      return detail;
    });

    return {
      results: resultsSlice,
      llm_rerank_pool: llmPool,
      rest_after_pool: restAfterPool,
      debug: {
        architecture: "dual-path-rrf-v5",
        rrf_k: RRF_K,
        path_top_n: topN,
        bm25_total: bm25Data.count,
        dense_full_total: Object.keys(denseFullById).length,
        dense_prefetch_total: Object.keys(densePrefetchById).length,
        path_counts: { A: pathA.length, B: pathB.length },
        path_details: { A: pathDetail(pathA), B: pathDetail(pathB) },
        merged_total: merged.length,
        filtered_by_filter_not: filteredByFilterNot,
        llm_pool_size: llmPool.length,
        returned: resultsSlice.length,
        bm25_modifier: { boost: getBm25ModifierBoost(), absent: getBm25ModifierAbsent() },
        bm25_rrf_k: getBm25RrfK(),
        weights_used: denseWeights,
        bm25_weight_used: bm25Weight,
      },
    };
  }

  return { results: resultsSlice, llm_rerank_pool: llmPool, rest_after_pool: restAfterPool };
}
