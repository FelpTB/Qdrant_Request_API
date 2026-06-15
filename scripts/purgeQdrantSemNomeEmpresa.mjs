/**
 * 1) Lista no PostgreSQL (Supabase) os CNPJ em busca_fornecedor.<tabela> com
 *    nome_empresa IS NULL e qdrant = true.
 * 2) Remove no Qdrant (coleção COLLECTION_NAME) os pontos com esses CNPJ (id = pointIdFromCnpj, igual ao pipeline).
 * 3) Por omissão: --dry-run (só lista; não apaga). Com --apply: apaga e opcionalmente atualiza o PG.
 *
 * Uso:
 *   node scripts/purgeQdrantSemNomeEmpresa.mjs
 *   node scripts/purgeQdrantSemNomeEmpresa.mjs --apply
 *   node scripts/purgeQdrantSemNomeEmpresa.mjs --apply --no-update-pg   (só Qdrant)
 *
 * .env: DB_URL, CLUSTER_ENDPOINT, QDRANT_KEY, COLLECTION_NAME, opcional PG_SCHEMA, PG_COMPANY_TABLE
 */
import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";
import { getPool, isDbConfigured } from "../src/db.js";
import { pointIdFromCnpj } from "../src/pointIdFromCnpj.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "out");
const outJson = (name) => join(outDir, name);

const SCHEMA = (process.env.PG_SCHEMA || "busca_fornecedor").trim();
const COMPANY_TABLE = (process.env.PG_COMPANY_TABLE || "company_profile").trim();

const url = (process.env.CLUSTER_ENDPOINT || "").trim().replace(/^["']|["']$/g, "");
const apiKey = (process.env.QDRANT_KEY || "")
  .trim()
  .replace(/^["']|["']$/g, "");
const collection = process.env.COLLECTION_NAME;

const args = new Set(process.argv.slice(2).map((a) => a.toLowerCase()));
const apply = args.has("--apply");
const noUpdatePg = args.has("--no-update-pg");

if (!isDbConfigured()) {
  console.error("DB_URL é obrigatório no .env (Supabase/Postgres).");
  process.exit(1);
}
if (!url || !apiKey || !collection) {
  console.error("CLUSTER_ENDPOINT, QDRANT_KEY e COLLECTION_NAME são obrigatórios no .env.");
  process.exit(1);
}

function qdrantClient() {
  const explicit = process.env.QDRANT_API_PORT;
  if (explicit) {
    const n = parseInt(explicit, 10);
    if (Number.isFinite(n)) {
      return new QdrantClient({
        url,
        port: n,
        apiKey,
        checkCompatibility: false,
        timeout: (Number(process.env.SEARCH_TIMEOUT_SECONDS) || 300) * 1000,
      });
    }
  }
  return new QdrantClient({
    url,
    apiKey,
    checkCompatibility: false,
    timeout: (Number(process.env.SEARCH_TIMEOUT_SECONDS) || 300) * 1000,
  });
}

const SQL = `
  SELECT cnpj
  FROM ${SCHEMA}.${COMPANY_TABLE}
  WHERE nome_empresa IS NULL
    AND qdrant = true
`;

const DELETE_BATCH = Math.min(500, Math.max(20, parseInt(process.env.PURGE_QDRANT_DELETE_BATCH, 10) || 200));

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const pool = getPool();
  const { rows } = await pool.query(SQL);
  const cnpjs = rows
    .map((r) => (r.cnpj == null ? "" : String(r.cnpj).trim()))
    .filter(Boolean);
  const unique = [...new Set(cnpjs)];

  const report = {
    generated_at: new Date().toISOString(),
    schema: SCHEMA,
    table: COMPANY_TABLE,
    collection,
    sql_filter: "nome_empresa IS NULL AND qdrant = true",
    count_rows: unique.length,
    cnpjs: unique,
  };

  writeFileSync(outJson("purge-sem-nome-cnpjs.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("Origem: %s.%s", SCHEMA, COMPANY_TABLE);
  console.log("CNPJs encontrados (distintos):", unique.length);
  console.log("Lista: scripts/out/purge-sem-nome-cnpjs.json");
  if (unique.length > 0) {
    console.log("Amostra:", unique.slice(0, 5).join(", ") + (unique.length > 5 ? "…" : ""));
  }

  if (unique.length === 0) {
    console.log("Nada a remover. Saída.");
    await pool.end().catch(() => {});
    return;
  }

  const idByCnpj = new Map(unique.map((c) => [c, pointIdFromCnpj(c)]));
  const ids = unique.map((c) => idByCnpj.get(c));

  if (!apply) {
    console.log("\n[DRY-RUN] Nada foi apagado. Executa de novo com --apply para remover no Qdrant" + (noUpdatePg ? "" : " e pôr qdrant = false no PG") + ".");
    await pool.end().catch(() => {});
    return;
  }

  const client = qdrantClient();
  let deletedBatches = 0;
  for (const group of chunk(ids, DELETE_BATCH)) {
    await client.delete(collection, {
      wait: true,
      points: group,
    });
    deletedBatches += 1;
    process.stdout.write(`Qdrant delete: lote ${deletedBatches} (${group.length} ids)\n`);
  }

  let updatedPg = 0;
  if (!noUpdatePg) {
    const upd = await pool.query(
      `UPDATE ${SCHEMA}.${COMPANY_TABLE}
         SET qdrant = false
       WHERE cnpj = ANY($1::text[])
         AND nome_empresa IS NULL
         AND qdrant = true`,
      [unique]
    );
    updatedPg = upd.rowCount ?? 0;
    console.log("PostgreSQL: qdrant = false em linhas afectadas:", updatedPg);
  } else {
    console.log("PostgreSQL: --no-update-pg: não foi feito UPDATE.");
  }

  await pool.end().catch(() => {});
  console.log("Concluído. Pontos apagados no Qdrant por", ids.length, "ids (1 por CNPJ).");
}

main().catch((e) => {
  console.error(e?.data?.status?.error || e?.message || e);
  process.exit(1);
});
