/**
 * Estudo: perfis (company_profile) "montados" em 20 e 21/04, por tamanho de full_profile;
 * 50 com mais caracteres (mais completos) e 50 com menos (menos completos);
 * análise agregada de scraped_chunks para esses 100 CNPJs.
 *
 * .env: DB_URL obrigatório.
 * Variáveis opcionais (defaults para 20–21/04/2026, fuso America/Sao_Paulo, criados em created_at):
 *   PROFILE_STUDY_DAYS=2026-04-20,2026-04-21
 *   PROFILE_STUDY_TIMEZONE=America/Sao_Paulo
 *   PROFILE_STUDY_USE_COLUMN=created_at   (ou updated_at)
 *   PG_COMPANY_TABLE=company_profile
 *   PG_SCHEMA=busca_fornecedor
 *   PG_SCRAPED_CHUNKS_SCHEMA=busca_fornecedor   (tentativa; se falhar, tenta public)
 *   SCRAPED_CHUNKS_CNPJ_COLUMN=   (opcional: cnpj_basico, cnpj, etc.; senão autodeteta)
 *   Por omissão o escopo exclui linhas com nome_empresa nulo. Para incluir tudo: PROFILE_STUDY_INCLUIR_NOME_NULO=1
 *   PG_SCRAPE_MAIN_SCHEMA=busca_fornecedor — tabela scrape_main (também se tenta public)
 *
 * Uso: node scripts/profileChunkQualityStudy.mjs
 * Saída: scripts/out/profile-chunk-quality-study.json
 *
 * O relatório inclui `diagnostico_qualidade`: causas prováveis para perfis "menos completos"
 * (pouco material em chunks, erros no fluxo, flags perfil_processado, secções JSON vazias, etc.).
 * Para os 50 CNPJs "menos completos", o relatório inclui `scrape_main` (erros, páginas, status, etc.).
 */
import "dotenv/config";
import { getPool, isDbConfigured } from "../src/db.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "out");
const OUT_FILE = join(outDir, "profile-chunk-quality-study.json");

if (!isDbConfigured()) {
  console.error("Defina DB_URL no .env (connection string Supabase/Postgres).");
  process.exit(1);
}

const SCHEMA = (process.env.PG_SCHEMA || "busca_fornecedor").trim();
const COMPANY_TABLE = (process.env.PG_COMPANY_TABLE || "company_profile").trim();
const dateStr = (process.env.PROFILE_STUDY_DAYS || "2026-04-20,2026-04-21").trim();
const DAYS = dateStr.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const TZ = (process.env.PROFILE_STUDY_TIMEZONE || "America/Sao_Paulo").trim();
const DATE_COL = (process.env.PROFILE_STUDY_USE_COLUMN || "created_at").trim();
if (DATE_COL !== "created_at" && DATE_COL !== "updated_at") {
  console.error("PROFILE_STUDY_USE_COLUMN deve ser created_at ou updated_at");
  process.exit(1);
}

/** Só empresas com nome_empresa não nulo (conforme coluna em company_profile). */
const SCOPO_NOME_NOT_NULL = !["1", "true", "yes"].includes(
  String(process.env.PROFILE_STUDY_INCLUIR_NOME_NULO || "").toLowerCase()
);
const SQL_NOME_EMPRESA = SCOPO_NOME_NOT_NULL ? " AND nome_empresa IS NOT NULL" : "";

const POOL = getPool();

/**
 * @param {string} schema
 * @param {string} name
 * @returns {Promise<{ exists: boolean, columns: Array<{name:string, data_type:string}> }>}
 */
async function getTableInfo(schema, name) {
  const r = await POOL.query(
    `SELECT column_name AS name, data_type
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, name]
  );
  return { exists: (r.rows?.length ?? 0) > 0, columns: r.rows ?? [] };
}

function buildProfileQuery() {
  // timestamptz → data civil no fuso dado (ex. America/Sao_Paulo)
  return {
    text: `
WITH base AS (
  SELECT
    cnpj,
    ${DATE_COL} AS profile_ts,
    length(coalesce(full_profile::text, ''))::bigint AS profile_chars
  FROM ${SCHEMA}.${COMPANY_TABLE}
  WHERE (${DATE_COL} AT TIME ZONE $1)::date = ANY($2::date[])${SQL_NOME_EMPRESA}
),
ranked AS (
  SELECT
    cnpj,
    profile_ts,
    profile_chars,
    row_number() OVER (ORDER BY profile_chars ASC,  cnpj ASC)  AS r_asc,
    row_number() OVER (ORDER BY profile_chars DESC, cnpj DESC) AS r_desc,
    (SELECT count(*)::int FROM base) AS n_total
  FROM base
),
bottom AS (
  SELECT cnpj, profile_ts, profile_chars, r_asc, n_total, 'least_complete' AS quality_bucket
  FROM ranked
  WHERE r_asc <= 50
),
top AS (
  SELECT cnpj, profile_ts, profile_chars, r_desc, n_total, 'most_complete' AS quality_bucket
  FROM ranked
  WHERE r_desc <= 50
)
SELECT cnpj, profile_ts, profile_chars, quality_bucket, n_total
FROM (
  SELECT b.cnpj, b.profile_ts, b.profile_chars, b.quality_bucket, b.n_total FROM bottom b
  UNION ALL
  SELECT t.cnpj, t.profile_ts, t.profile_chars, t.quality_bucket, t.n_total FROM top t
) u
ORDER BY quality_bucket DESC, profile_chars DESC
`,
    values: [TZ, DAYS],
  };
}

/**
 * Soma tamanho de texto "útil" num objeto (JSON row).
 * @param {object} row
 * @param {string[]} textColumnNames
 */
function rowTextSize(row, textColumnNames) {
  let t = 0;
  for (const k of textColumnNames) {
    const v = row[k];
    if (v == null) continue;
    if (typeof v === "string") t += v.length;
    else if (typeof v === "object") t += JSON.stringify(v).length;
  }
  return t;
}

function cnpjDigits(s) {
  return String(s ?? "").replace(/\D/g, "");
}

/** Fila de ligação perfil.cnpj ↔ chunk (cnpj ou cnpj_basico de 8 dígitos, etc.) */
function matchChunkToProfileCnpj(row, joinCol, profileCnpj) {
  const r = row[joinCol] == null ? "" : String(row[joinCol]).trim();
  const p = String(profileCnpj ?? "").trim();
  if (r && p && r === p) return true;
  const rd = cnpjDigits(r);
  const pd = cnpjDigits(p);
  if (rd && pd && rd === pd) return true;
  if (rd.length === 8 && pd.length >= 8 && pd.startsWith(rd)) return true;
  if (pd.length === 8 && rd.length >= 8 && rd.startsWith(pd)) return true;
  return false;
}

/**
 * Vários formatos (com/sem máscara, 8/14) para o ANY do WHERE.
 * @param {string[]} cnpjList
 */
function expandCnpjKeysForFilter(cnpjList) {
  const s = new Set();
  for (const c of cnpjList) {
    const t = String(c).trim();
    if (t) s.add(t);
    const d = cnpjDigits(t);
    if (d) {
      s.add(d);
      if (d.length >= 8) s.add(d.slice(0, 8));
    }
  }
  return [...s].filter(Boolean);
}

/**
 * @param {object[]} rows
 * @param {string} joinCol
 * @param {string[]} profileCnpjList - CNPJs da amostra (chaves do resumo)
 * @param {string[]} textCols
 * @param {{ oneRowCanMatchManyProfiles: boolean }} opts
 */
function aggregateChunksByProfile(rows, joinCol, profileCnpjList, textCols, opts = { oneRowCanMatchManyProfiles: true }) {
  const byCnpj = new Map();
  for (const pc of profileCnpjList) {
    byCnpj.set(String(pc).trim(), { chunk_rows: 0, total_text_chars: 0 });
  }
  for (const row of rows) {
    const hit = profileCnpjList.filter((pc) => matchChunkToProfileCnpj(row, joinCol, pc));
    const list = opts.oneRowCanMatchManyProfiles ? hit : hit.slice(0, 1);
    for (const pc of list) {
      const k = String(pc).trim();
      const agg = byCnpj.get(k);
      if (agg) {
        agg.chunk_rows += 1;
        agg.total_text_chars += rowTextSize(row, textCols);
      }
    }
  }
  return { byCnpj: Object.fromEntries(byCnpj) };
}

function resolveCnpjJoinColumn(columns) {
  const fromEnv = process.env.SCRAPED_CHUNKS_CNPJ_COLUMN?.trim();
  if (fromEnv) {
    const f = columns.find((c) => c.name === fromEnv);
    if (f) return f.name;
  }
  for (const name of ["cnpj", "cnpj_basico", "CNPJ"]) {
    if (columns.find((c) => c.name === name)) return name;
  }
  return null;
}

function hasColumn(tableInfo, name) {
  return tableInfo.columns.some((c) => c.name === name);
}

/**
 * Agrega por CNPJ do perfil: tokens, erros, perfil_processado.
 * @param {object[]} rows
 * @param {string} joinCol
 * @param {string[]} profileCnpjList
 * @returns {Record<string, object>}
 */
function aggregateChunksDiagnostics(rows, joinCol, profileCnpjList) {
  const by = new Map();
  for (const pc of profileCnpjList) {
    by.set(String(pc).trim(), {
      chunk_rows: 0,
      sum_token_count: 0,
      rows_com_token: 0,
      sample_errors: [],
      rows_com_error: 0,
      perfil_true: 0,
      perfil_false: 0,
      perfil_null: 0,
      max_total_chunks: null,
    });
  }
  for (const row of rows) {
    for (const pc of profileCnpjList) {
      if (!matchChunkToProfileCnpj(row, joinCol, pc)) continue;
      const k = String(pc).trim();
      const a = by.get(k);
      if (!a) continue;
      a.chunk_rows += 1;
      const tok = row.token_count;
      if (tok != null && Number.isFinite(Number(tok))) {
        a.sum_token_count += Number(tok);
        a.rows_com_token += 1;
      }
      const err = row.error ?? row.erro;
      if (err != null && String(err).trim() !== "") {
        a.rows_com_error += 1;
        if (a.sample_errors.length < 5) a.sample_errors.push(String(err).slice(0, 300));
      }
      const pp = row.perfil_processado;
      if (pp === true) a.perfil_true += 1;
      else if (pp === false) a.perfil_false += 1;
      else a.perfil_null += 1;
      const tc = row.total_chunks;
      if (tc != null && Number.isFinite(Number(tc))) {
        const n = Number(tc);
        a.max_total_chunks = a.max_total_chunks == null ? n : Math.max(a.max_total_chunks, n);
      }
    }
  }
  return Object.fromEntries(by);
}

/**
 * @param {string} schema
 * @param {string} table
 * @param {string[]} cnpjList
 * @param {{ columns: { name: string }[] }} tableInfo
 */
async function fetchProfileEnrichment(schema, table, cnpjList, tableInfo) {
  if (cnpjList.length === 0) return {};
  const parts = ["cnpj"];
  if (hasColumn(tableInfo, "qdrant")) parts.push("qdrant");
  if (!hasColumn(tableInfo, "full_profile")) {
    const r = await POOL.query(`SELECT ${parts.join(", ")} FROM ${schema}.${table} WHERE cnpj = ANY($1::text[])`, [cnpjList]);
    return Object.fromEntries((r.rows || []).map((row) => [String(row.cnpj).trim(), row]));
  }
  const fp = "full_profile";
  const sections = ["identidade", "ofertas", "classificacao", "reputacao", "contato"];
  for (const sec of sections) {
    parts.push(
      `coalesce(length((${fp}::jsonb->'${sec}')::text), 0)::int AS len_${sec}`
    );
  }
  parts.push(`length(coalesce(${fp}::text, ''))::bigint AS profile_chars_db`);
  const sql = `SELECT ${parts.join(", ")} FROM ${schema}.${table} WHERE cnpj = ANY($1::text[])`;
  try {
    const r = await POOL.query(sql, [cnpjList]);
    return Object.fromEntries((r.rows || []).map((row) => [String(row.cnpj).trim(), row]));
  } catch {
    const r2 = await POOL.query(
      `SELECT cnpj${hasColumn(tableInfo, "qdrant") ? ", qdrant" : ""} FROM ${schema}.${table} WHERE cnpj = ANY($1::text[])`,
      [cnpjList]
    );
    return Object.fromEntries((r2.rows || []).map((row) => [String(row.cnpj).trim(), row]));
  }
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * @param {object} profileRows
 * @param {Record<string, object>} chunkDiag
 * @param {Record<string, object>} enrich
 */
function buildDiagnosticoQualidade(profileRows, chunkDiag, enrich) {
  const most = profileRows.filter((r) => r.quality_bucket === "most_complete");
  const least = profileRows.filter((r) => r.quality_bucket === "least_complete");
  const mostTokens = most
    .map((r) => chunkDiag[String(r.cnpj).trim()]?.sum_token_count)
    .filter((x) => x != null && Number.isFinite(x))
    .sort((a, b) => a - b);
  const leastTokens = least
    .map((r) => chunkDiag[String(r.cnpj).trim()]?.sum_token_count)
    .filter((x) => x != null && Number.isFinite(x))
    .sort((a, b) => a - b);
  const p10MostTokens = percentile(mostTokens, 10) ?? 0;
  const medianMostChars = median(most.map((r) => Number(r.profile_chars)));
  const medianLeastChars = median(least.map((r) => Number(r.profile_chars)));
  const ref = {
    p10_sum_tokens_mais_completos: p10MostTokens,
    mediana_profile_chars_mais_completos: medianMostChars,
    mediana_profile_chars_menos_completos: medianLeastChars,
  };
  const definicoes = {
    sem_material_fonte: "Nenhum chunk de scraped corresponde ao CNPJ (ou lista vazia de chunks).",
    erros_nos_chunks: "Pelo menos um registo em scraped_chunks com error/erro preenchido.",
    perfil_nao_processado: "Há chunks com perfil_processado = false e nenhum true; possível atraso ou falha no passo de montagem.",
    poucos_tokens: `Soma de token_count nos chunks < P10 da soma dos "mais completos" (~${p10MostTokens}).`,
    json_esparso: "Secções identidade/ofertas muito pequenas no JSON full_profile (heurística).",
    curto_vs_teto: "Perfil muito abaixo da mediana de tamanho do grupo mais completo, sem outro sinal claro.",
  };
  const contagemCausas = {};
  const detalheLeast = [];
  for (const r of least) {
    const cj = String(r.cnpj).trim();
    const d = chunkDiag[cj] || {};
    const e = enrich[cj] || {};
    const hasSec = e != null && e.len_identidade != null;
    const profileChars = Number(r.profile_chars);
    const flags = {
      sem_chunks: (d.chunk_rows ?? 0) === 0,
      erros_scraped: (d.rows_com_error ?? 0) > 0,
      so_perfil_nao_processado:
        (d.perfil_false ?? 0) > 0 && (d.perfil_true ?? 0) === 0 && (d.chunk_rows ?? 0) > 0,
      poucos_tokens: (d.sum_token_count ?? 0) < p10MostTokens && (d.chunk_rows ?? 0) > 0,
      secsoes_json_muito_pobres:
        hasSec &&
        (e.len_identidade ?? 0) < 40 &&
        (e.len_ofertas ?? 0) < 40 &&
        (e.len_classificacao ?? 0) < 20,
    };
    let causa = "outro_ou_dominada_por_tamanho_json";
    if (flags.sem_chunks) causa = "sem_material_fonte_ou_sem_match_cnpj_em_scraped_chunks";
    else if (flags.erros_scraped) causa = "erros_registados_no_fluxo_de_scraping";
    else if (flags.so_perfil_nao_processado) causa = "chunks_nao_marcados_como_perfil_processado";
    else if (flags.poucos_tokens) causa = "pouco_conteudo_tokenizado_vs_referencia_mais_completos";
    else if (flags.secsoes_json_muito_pobres) causa = "json_montado_com_secsoes_muito_pobres";
    else if (medianMostChars && profileChars < medianMostChars * 0.2) causa = "perfil_curto_relativo_ao_grupo_mais_completo";
    contagemCausas[causa] = (contagemCausas[causa] || 0) + 1;
    detalheLeast.push({
      cnpj: cj,
      profile_chars: profileChars,
      diagnostico: {
        causa_principal: causa,
        flags,
        chunks: {
          chunk_rows: d.chunk_rows ?? 0,
          sum_token_count: d.sum_token_count ?? 0,
          rows_com_error: d.rows_com_error ?? 0,
          sample_errors: d.sample_errors ?? [],
          perfil_processado: {
            true: d.perfil_true ?? 0,
            false: d.perfil_false ?? 0,
            null: d.perfil_null ?? 0,
          },
          max_total_chunks: d.max_total_chunks ?? null,
        },
        full_profile_secoes_chars: e.len_identidade != null
          ? {
              len_identidade: e.len_identidade,
              len_ofertas: e.len_ofertas,
              len_classificacao: e.len_classificacao,
              len_reputacao: e.len_reputacao,
              len_contato: e.len_contato,
            }
          : null,
        qdrant: e.qdrant !== undefined ? e.qdrant : null,
      },
    });
  }
  return {
    referencia: ref,
    definicoes,
    resumo_causas_least_complete: contagemCausas,
    nota_interpretacao:
      "Causas são heurísticas (combinação de tamanho do JSON, tokens em chunks, erros e flags). " +
      "Uma linha pode acumular vários sinais; causa_principal segue a ordem de prioridade no código.",
    detalhe_menos_completos: detalheLeast,
  };
}

function nonNullStringStatsForColumns(rows, columns) {
  const s = {};
  for (const col of columns) {
    let n = 0;
    let sumLen = 0;
    for (const r of rows) {
      const v = r[col];
      if (v == null) continue;
      n += 1;
      if (typeof v === "string") sumLen += v.length;
      else if (typeof v === "object") sumLen += JSON.stringify(v).length;
    }
    s[col] = { n_nao_nulo: n, soma_tamanho_texto_e_json: sumLen };
  }
  return s;
}

function median(numbers) {
  const s = numbers.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  if (s.length % 2) return s[mid];
  return (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param {Array<{ cnpj: string, quality_bucket: string }>} profileList
 * @param {Record<string, { chunk_rows: number, total_text_chars: number }>} byCnpj
 */
function compareBuckets(profileList, byCnpj) {
  const seen = new Map();
  for (const p of profileList) {
    const cj = String(p.cnpj).trim();
    if (!seen.has(cj)) seen.set(cj, p.quality_bucket);
  }
  const metrics = (bucket) => {
    const cnpjs = [...seen.entries()].filter(([, b]) => b === bucket).map(([c]) => c);
    const withChunks = cnpjs
      .map((c) => {
        const k = byCnpj[c];
        return k ? { cnpj: c, ...k } : { cnpj: c, chunk_rows: 0, total_text_chars: 0 };
      });
    const n = cnpjs.length;
    const chunkCounts = withChunks.map((w) => w.chunk_rows);
    const textPerProfile = withChunks.map((w) => w.total_text_chars);
    return {
      cnpjs_no_perfil: n,
      com_algum_chunk_no_scraped: withChunks.filter((w) => w.chunk_rows > 0).length,
      mediana_num_chunks: median(chunkCounts),
      mediana_tamanho_texto_chunks_somado: median(textPerProfile),
    };
  };
  return {
    most_complete: metrics("most_complete"),
    least_complete: metrics("least_complete"),
  };
}

async function findScrapedChunksTable() {
  const preferred = (process.env.PG_SCRAPED_CHUNKS_SCHEMA || "busca_fornecedor").trim();
  const trySchemas = [preferred, "public"];
  for (const sch of trySchemas) {
    const info = await getTableInfo(sch, "scraped_chunks");
    if (info.exists) return { schema: sch, ...info };
  }
  return null;
}

async function findScrapeMainTable() {
  const preferred = (process.env.PG_SCRAPE_MAIN_SCHEMA || SCHEMA || "busca_fornecedor").trim();
  const trySchemas = [preferred, "public"];
  for (const sch of trySchemas) {
    const info = await getTableInfo(sch, "scrape_main");
    if (info.exists) return { schema: sch, ...info };
  }
  return null;
}

const NUM_PG_TYPES = new Set(["integer", "bigint", "smallint", "numeric", "double precision", "real", "bigserial", "serial"]);

function isNumericPgType(dataType) {
  return NUM_PG_TYPES.has(dataType) || (dataType || "").endsWith("int");
}

function pickErrorColumnNames(columns) {
  return columns
    .filter(
      (c) =>
        /error|erro|failure|falha|exception|err|fault|aborted|abort/i.test(c.name) &&
        !/perfil_processado|erro_?count/i.test(c.name)
    )
    .map((c) => c.name);
}

function pickPageOrCountColumnNames(columns) {
  return columns
    .filter(
      (c) =>
        isNumericPgType(c.data_type) &&
        /page|pag|url|link|total|count|scrape|depth|level|visit|n_|num_|qtd|qtde|index|item|row/i.test(
          c.name
        )
    )
    .map((c) => c.name);
}

function findStatusColumnName(columns) {
  for (const name of ["status", "estado", "state", "situacao", "phase", "fase", "scraping_status", "job_status"]) {
    if (columns.find((c) => c.name === name)) return name;
  }
  const c = columns.find((x) => /status|estado|fase|phase|state|situacao/i.test(x.name) && !/http/i.test(x.name));
  return c ? c.name : null;
}

function cellLooksLikeError(value) {
  if (value == null) return false;
  if (typeof value === "boolean" || typeof value === "number") {
    if (value === 0) return false;
  }
  const s = typeof value === "string" ? value.trim() : String(value);
  if (s === "" || s === "null" || s === "undefined" || s === "false" || s === "0" || s === "ok" || s === "OK")
    return false;
  if (typeof value === "string" && s.length > 0) return true;
  if (typeof value === "object" && Object.keys(value).length) return true;
  return true;
}

function rowHasErrorLike(row, errorColNames) {
  for (const n of errorColNames) {
    if (row[n] != null && cellLooksLikeError(row[n])) return true;
  }
  return false;
}

/**
 * Estatísticas scrape_main para os CNPJ da amostra "menos completa".
 * @param {object[]} rows
 * @param {{ name: string, data_type: string }[]} columnMeta
 * @param {string} joinCol
 * @param {string[]} cnpjLeastList
 */
function buildScrapeMainReport(rows, columnMeta, joinCol, cnpjLeastList) {
  const errCols = pickErrorColumnNames(columnMeta);
  const pageCols = pickPageOrCountColumnNames(columnMeta);
  const allNumericCols = columnMeta.filter((c) => isNumericPgType(c.data_type) && c.name !== "id").map((c) => c.name);
  const statusName = findStatusColumnName(columnMeta);

  const byCnpj = new Map();
  for (const cj of cnpjLeastList) {
    byCnpj.set(String(cj).trim(), {
      linhas: 0,
      linhas_com_erro_preenchido: 0,
      primeira_amostra_erro: null,
      soma_colunas_tipo_pagina: Object.fromEntries(pageCols.map((p) => [p, 0])),
      max_colunas_tipo_pagina: Object.fromEntries(pageCols.map((p) => [p, null])),
      contagem_status: {},
    });
  }

  for (const row of rows) {
    const matches = cnpjLeastList.filter((pc) => matchChunkToProfileCnpj(row, joinCol, pc));
    for (const pc of matches) {
      const a = byCnpj.get(String(pc).trim());
      if (!a) continue;
      a.linhas += 1;
      if (rowHasErrorLike(row, errCols)) {
        a.linhas_com_erro_preenchido += 1;
        if (!a.primeira_amostra_erro) {
          const n = errCols.find((c) => row[c] != null);
          a.primeira_amostra_erro = n
            ? { coluna: n, amostra: String(row[n]).slice(0, 400) }
            : { coluna: "?", amostra: "—" };
        }
      }
      for (const p of pageCols) {
        const v = row[p];
        const n = v != null && Number.isFinite(Number(v)) ? Number(v) : null;
        if (n == null) continue;
        a.soma_colunas_tipo_pagina[p] = (a.soma_colunas_tipo_pagina[p] || 0) + n;
        const m = a.max_colunas_tipo_pagina[p];
        a.max_colunas_tipo_pagina[p] = m == null ? n : Math.max(m, n);
      }
      if (statusName) {
        const sk = row[statusName] == null ? "(null)" : String(row[statusName]);
        a.contagem_status[sk] = (a.contagem_status[sk] || 0) + 1;
      }
    }
  }

  const distribuicaoStatusGlobal = {};
  let linhasContadasNoEscopo = 0;
  let linhasComIndicioDeErro = 0;
  for (const row of rows) {
    const inScope = cnpjLeastList.some((pc) => matchChunkToProfileCnpj(row, joinCol, pc));
    if (!inScope) continue;
    linhasContadasNoEscopo += 1;
    if (rowHasErrorLike(row, errCols)) linhasComIndicioDeErro += 1;
    if (statusName) {
      const sk = row[statusName] == null ? "(null)" : String(row[statusName]);
      distribuicaoStatusGlobal[sk] = (distribuicaoStatusGlobal[sk] || 0) + 1;
    }
  }

  const resumoNumericosTodasColunas = {};
  for (const col of allNumericCols) {
    const vals = [];
    for (const row of rows) {
      if (!cnpjLeastList.some((pc) => matchChunkToProfileCnpj(row, joinCol, pc))) continue;
      const v = row[col];
      if (v != null && Number.isFinite(Number(v))) vals.push(Number(v));
    }
    if (vals.length) {
      const s = vals.reduce((a, b) => a + b, 0);
      resumoNumericosTodasColunas[col] = {
        n: vals.length,
        min: Math.min(...vals),
        max: Math.max(...vals),
        soma: s,
        media: Math.round((s / vals.length) * 1000) / 1000,
      };
    }
  }

  return {
    coluna_join: joinCol,
    coluna_status_usada: statusName,
    colunas_tratadas_como_erro: errCols,
    colunas_tratadas_como_paginas_contagem: pageCols,
    geral: {
      linhas_retornadas_query: rows.length,
      linhas_no_escopo_da_amostra: linhasContadasNoEscopo,
      linhas_com_algum_campo_de_erro: linhasComIndicioDeErro,
      fracao_com_erro:
        linhasContadasNoEscopo > 0
          ? Math.round((1000 * linhasComIndicioDeErro) / linhasContadasNoEscopo) / 1000
          : 0,
      distribuicao_status: distribuicaoStatusGlobal,
    },
    resumo_numerico_todas_colunas_escopo: resumoNumericosTodasColunas,
    por_cnpj: Object.fromEntries(byCnpj),
  };
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const countSql = `
    SELECT count(*)::int AS n
    FROM ${SCHEMA}.${COMPANY_TABLE}
    WHERE (${DATE_COL} AT TIME ZONE $1)::date = ANY($2::date[])${SQL_NOME_EMPRESA}`;
  const { rows: countRows } = await POOL.query(countSql, [TZ, DAYS]);
  const nInWindow = countRows[0]?.n ?? 0;

  const profileSql = buildProfileQuery();
  const pRes = await POOL.query(profileSql.text, profileSql.values);
  const profileRows = pRes.rows || [];

  const cnpjSet = new Set(profileRows.map((r) => String(r.cnpj).trim()).filter(Boolean));
  const cnpjList = [...cnpjSet];

  const companyTableInfo = await getTableInfo(SCHEMA, COMPANY_TABLE);
  let profileEnrich = {};
  try {
    profileEnrich = await fetchProfileEnrichment(SCHEMA, COMPANY_TABLE, cnpjList, companyTableInfo);
  } catch (e) {
    profileEnrich = { _erro_enriquecimento: e?.message || String(e) };
  }

  const scraped = await findScrapedChunksTable();
  let chunkModule = {
    found: false,
    schema: null,
    error: null,
    summary: null,
    by_cnpj: null,
  };

  if (scraped && cnpjList.length > 0) {
    const cnpjCol = resolveCnpjJoinColumn(scraped.columns);
    if (!cnpjCol) {
      chunkModule.error =
        "Nenhuma coluna cnpj/cnpj_basico em scraped_chunks; colunas: " + scraped.columns.map((c) => c.name).join(", ");
    } else {
      const textTypes = new Set([
        "text",
        "character varying",
        "varchar",
        "char",
        "json",
        "jsonb",
      ]);
      const skipName = new Set(["id"]);
      const textCols = scraped.columns
        .filter(
          (c) =>
            !skipName.has(c.name) &&
            (textTypes.has(c.data_type) || c.data_type === "jsonb")
        )
        .map((c) => c.name);
      const selectSet = new Set([cnpjCol, ...textCols]);
      for (const name of ["token_count", "total_chunks", "chunk_index", "error", "erro", "perfil_processado"]) {
        if (scraped.columns.find((c) => c.name === name)) selectSet.add(name);
      }
      const sel = textCols.length ? [...selectSet].map((c) => `"${c}"`).join(", ") : "*";
      const filterKeys = expandCnpjKeysForFilter(cnpjList);
      try {
        const q = `SELECT ${sel} FROM ${scraped.schema}.scraped_chunks WHERE "${cnpjCol}" = ANY($1::text[])`;
        const cRes = await POOL.query(q, [filterKeys]);
        const colNames =
          cRes.fields && cRes.fields.length > 0
            ? cRes.fields.map((f) => f.name)
            : cRes.rows[0]
              ? Object.keys(cRes.rows[0])
              : textCols;
        const { byCnpj } = aggregateChunksByProfile(cRes.rows, cnpjCol, cnpjList, colNames);
        const chunkDiagnostics = aggregateChunksDiagnostics(cRes.rows, cnpjCol, cnpjList);
        const cnpjOrder = cnpjList.filter((c) => (byCnpj[c]?.chunk_rows ?? 0) > 0);
        const colStats = nonNullStringStatsForColumns(cRes.rows, colNames);
        const totalChunks = cRes.rows.length;
        const cnpjWithData = cnpjOrder.length;
        const totalText = cnpjList.reduce((a, c) => a + (byCnpj[c]?.total_text_chars ?? 0), 0);
        const somaRowsPorCnpj = cnpjList.reduce((a, c) => a + (byCnpj[c]?.chunk_rows ?? 0), 0);
        const mediaChunksNosCnpjComDados = cnpjWithData
          ? cnpjOrder.reduce((a, c) => a + (byCnpj[c]?.chunk_rows ?? 0), 0) / cnpjWithData
          : 0;
        const comp = compareBuckets(
          profileRows.map((r) => ({ cnpj: r.cnpj, quality_bucket: r.quality_bucket })),
          byCnpj
        );
        let diagnosticoQualidade;
        if (typeof profileEnrich._erro_enriquecimento === "string") {
          diagnosticoQualidade = { erro: "Enriquecimento SQL: " + profileEnrich._erro_enriquecimento };
        } else {
          try {
            diagnosticoQualidade = buildDiagnosticoQualidade(profileRows, chunkDiagnostics, profileEnrich);
          } catch (e) {
            diagnosticoQualidade = { erro: "buildDiagnosticoQualidade: " + (e?.message || String(e)) };
          }
        }
        chunkModule = {
          found: true,
          schema: scraped.schema,
          cnpj_column: cnpjCol,
          cnpj_filter_values_expandidas: filterKeys.length,
          columns_used: colNames,
          nota:
            "Um registo de chunk pode contar em mais de um CNPJ da amostra se a raiz 8-dígitos coincidir; nesse caso a soma de chunk_rows por CNPJ pode exceder total_chunk_rows.",
          resumo_por_coluna_todas_linhas_chunks: colStats,
          comparacao_mais_vs_menos_completo: comp,
          summary: {
            total_chunk_rows: totalChunks,
            cnpjs_com_pelo_menos_um_chunk: cnpjWithData,
            cnpjs_solicitados: cnpjList.length,
            cnpjs_sem_nenhum_chunk: cnpjList.filter((c) => (byCnpj[c]?.chunk_rows ?? 0) === 0).length,
            soma_chunk_rows_atribuidos_aos_cnpjs: somaRowsPorCnpj,
            media_chunks_por_cnpj_com_dados: Math.round(mediaChunksNosCnpjComDados * 100) / 100,
            soma_tamanho_texto_por_cnpj_na_amostra: totalText,
          },
          by_cnpj: byCnpj,
          chunk_diagnostico_por_cnpj: chunkDiagnostics,
          diagnostico_qualidade: diagnosticoQualidade,
        };
      } catch (e) {
        chunkModule.error = e?.message || String(e);
      }
    }
  } else if (!scraped) {
    chunkModule.error = "Tabela scraped_chunks não encontrada em busca_fornecedor nem public.";
  }

  const cnpjMenores = profileRows
    .filter((r) => r.quality_bucket === "least_complete")
    .map((r) => String(r.cnpj).trim());

  let scrapeMainBlock = { escopo: "50 CNPJ com full_profile menores (least_complete)" };
  const smTable = await findScrapeMainTable();
  if (smTable && cnpjMenores.length > 0) {
    const jcol = resolveCnpjJoinColumn(smTable.columns);
    if (!jcol) {
      scrapeMainBlock = {
        ...scrapeMainBlock,
        tabela_encontrada: true,
        schema: smTable.schema,
        erro: "Nenhuma coluna cnpj / cnpj_basico; colunas: " + smTable.columns.map((c) => c.name).join(", "),
      };
    } else {
      const keys = expandCnpjKeysForFilter(cnpjMenores);
      try {
        const smRes = await POOL.query(
          `SELECT * FROM ${smTable.schema}.scrape_main WHERE "${jcol}" = ANY($1::text[])`,
          [keys]
        );
        const rep = buildScrapeMainReport(smRes.rows || [], smTable.columns, jcol, cnpjMenores);
        scrapeMainBlock = {
          ...scrapeMainBlock,
          tabela_encontrada: true,
          schema: smTable.schema,
          nome: "scrape_main",
          cnpj_coluna: jcol,
          cnpjs_solicitados: cnpjMenores.length,
          valores_filtro: keys.length,
          nota_cnpj_basico:
            "A mesma linha de scrape_main pode contar noutro CNPJ se a raiz 8 bater com outro (como em scraped_chunks).",
          relatorio: rep,
        };
      } catch (e) {
        scrapeMainBlock = {
          ...scrapeMainBlock,
          tabela_encontrada: true,
          schema: smTable.schema,
          erro: e?.message || String(e),
        };
      }
    }
  } else {
    scrapeMainBlock = {
      ...scrapeMainBlock,
      tabela_encontrada: Boolean(smTable),
      nota: smTable ? "Sem CNPJ na categoria menos completos" : "Tabela scrape_main não encontrada (schemas tentados: PG_SCRAPE_MAIN_SCHEMA / busca_fornecedor, public)",
    };
  }

  const out = {
    generated_at: new Date().toISOString(),
    filtros: {
      tabela: `${SCHEMA}.${COMPANY_TABLE}`,
      coluna_data: DATE_COL,
      fuso: TZ,
      datas_YYYYMMDD: DAYS,
      nome_empresa_nao_nulo: SCOPO_NOME_NOT_NULL,
    },
    perfis_nesta_janela: nInWindow,
    amostra_100: profileRows.map((r) => ({
      cnpj: r.cnpj,
      [DATE_COL]: r.profile_ts,
      profile_chars: Number(r.profile_chars),
      quality_bucket: r.quality_bucket,
    })),
    diagnostico_qualidade: chunkModule.diagnostico_qualidade ?? null,
    chunks_scraped: chunkModule,
    scrape_main_menos_completos: scrapeMainBlock,
  };

  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log("Ficheiro:", OUT_FILE);
  if (SCOPO_NOME_NOT_NULL) {
    console.log("Escopo: nome_empresa IS NOT NULL");
  }
  console.log("Perfis na janela (" + DATE_COL + " @ " + TZ + ", datas " + DAYS.join(", ") + "):", nInWindow);
  console.log("Linhas na amostra (até 50+50):", profileRows.length, "| CNPJs distintos:", cnpjList.length);
  if (chunkModule.summary) {
    console.log("Chunks: total linhas =", chunkModule.summary.total_chunk_rows, "| CNPJs com ≥1 chunk =", chunkModule.summary.cnpjs_com_pelo_menos_um_chunk);
  }
  if (chunkModule.comparacao_mais_vs_menos_completo) {
    const c = chunkModule.comparacao_mais_vs_menos_completo;
    console.log("Comparativo (mediana chunks / mediana tamanho texto agregado):");
    console.log("  mais completos:   ", c.most_complete);
    console.log("  menos completos:  ", c.least_complete);
  }
  const dq = chunkModule.diagnostico_qualidade;
  if (dq && dq.resumo_causas_least_complete) {
    console.log("Diagnóstico (50 menos completos) — resumo de causas prováveis:", dq.resumo_causas_least_complete);
  }
  if (dq && dq.referencia) {
    console.log("Referência (grupo mais completo): P10 soma token_count =", dq.referencia.p10_sum_tokens_mais_completos);
  }
  if (chunkModule.error) {
    console.warn("Chunks:", chunkModule.error);
  }
  if (scrapeMainBlock.tabela_encontrada && scrapeMainBlock.relatorio) {
    const g = scrapeMainBlock.relatorio.geral;
    console.log("scrape_main (50 menos completos): linhas no escopo =", g?.linhas_no_escopo_da_amostra, "| com campo de erro =", g?.linhas_com_algum_campo_de_erro);
    if (g?.distribuicao_status) console.log("  status:", g.distribuicao_status);
  } else if (scrapeMainBlock.erro) {
    console.warn("scrape_main:", scrapeMainBlock.erro);
  } else if (scrapeMainBlock.nota) {
    console.log("scrape_main:", scrapeMainBlock.nota);
  }

  await POOL.end().catch(() => {});
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
