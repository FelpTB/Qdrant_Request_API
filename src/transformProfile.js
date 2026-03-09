/**
 * Normaliza valor para string (espelho do Code n8n).
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .flatMap((v) => {
        if (v == null) return [];
        if (typeof v === "string") return v;
        if (typeof v === "object") return Object.values(v);
        return [];
      })
      .flat()
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (typeof value === "object") {
    return Object.values(value)
      .flat()
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Filtro Filter2 (n8n): pelo menos um de produto, servico, descricao, publico, cliente não vazio.
 * @param {Record<string, string>} p
 * @returns {boolean}
 */
function hasAnyMainField(p) {
  return [p.produto, p.servico, p.descricao, p.publico, p.cliente].some(
    (v) => v != null && String(v).trim() !== ""
  );
}

/**
 * Filtro Filter3 (n8n): modelo_negocio não vazio.
 * @param {Record<string, string>} p
 * @returns {boolean}
 */
function hasModeloNegocio(p) {
  const v = p.modelo_negocio;
  return v != null && String(v).trim() !== "";
}

/**
 * Transforma uma linha do banco (full_profile + metadados) em objeto para embedding + payload.
 * Não aplica filtros; apenas a transformação.
 *
 * @param {object} row - linha do SELECT (cnpj, full_profile, created_at, updated_at, municipio, uf)
 * @returns {{ cnpj: string, produto: string, servico: string, descricao: string, publico: string, cliente: string, payload: object, bm25Text: string }}
 */
export function transformRow(row) {
  const fp = row.full_profile || {};
  const identidade = fp.identidade || {};
  const ofertas = fp.ofertas || {};
  const classificacao = fp.classificacao || {};
  const reputacao = fp.reputacao || {};
  const contato = fp.contato || {};

  const produtos = clean(ofertas.produtos);
  const servicos = clean(ofertas.servicos);
  const descricao = clean(identidade.descricao);
  const publico = clean(classificacao.publico_alvo);
  const clientes = clean(reputacao.lista_clientes);
  const certificacoes = clean(reputacao.certificacoes);
  const premios = clean(reputacao.premios);
  const parcerias = clean(reputacao.parcerias);
  const estudosCaso = clean(reputacao.estudos_caso);
  const emails = clean(contato.emails);
  const telefones = clean(contato.telefones);
  const site = clean(contato.url_site);
  const linkedin = clean(contato.url_linkedin);
  const endereco = clean(contato.endereco_matriz);
  const nomeEmpresa = clean(identidade.nome_empresa);
  const municipio = clean(identidade.municipio || row.municipio);
  const uf = clean(identidade.uf || row.uf);
  const industria = clean(classificacao.industria);
  const modeloNegocio = clean(classificacao.modelo_negocio);
  const cobertura = clean(classificacao.cobertura_geografica);

  const payload = {
    modelo_negocio: modeloNegocio,
    nome_empresa: nomeEmpresa,
    cnpj: clean(identidade.cnpj) || row.cnpj,
    cidade: municipio,
    telefone: telefones,
    site,
    endereco,
    email: emails,
    produto: produtos,
    servico: servicos,
    descricao,
    publico,
    cliente: clientes,
    uf,
    certificacoes,
    premios,
    parcerias,
    estudos_caso: estudosCaso,
    industria,
    cobertura_geografica: cobertura,
    linkedin,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  const produto = produtos || " ";
  const servico = servicos || " ";
  const desc = descricao || " ";
  const pub = publico || " ";
  const cliente = clientes || " ";

  const bm25Text = [produto, servico, desc, pub, cliente].join(" ").trim() || " ";

  return {
    cnpj: payload.cnpj,
    produto,
    servico,
    descricao: desc,
    publico: pub,
    cliente,
    payload,
    bm25Text,
  };
}

/**
 * Aplica transformação a todas as linhas e filtra (Filter2 + Filter3).
 *
 * @param {Array<object>} rows - resultado de fetchCompanyProfiles
 * @returns {{ items: Array<{ cnpj: string, produto: string, servico: string, descricao: string, publico: string, cliente: string, payload: object, bm25Text: string }>, fetched: number, after_transform: number }}
 */
export function transformAndFilter(rows) {
  const fetched = rows.length;
  const items = [];
  for (const row of rows) {
    const item = transformRow(row);
    const p = item.payload;
    if (!hasAnyMainField(p)) continue;
    if (!hasModeloNegocio(p)) continue;
    items.push(item);
  }
  return { items, fetched, after_transform: items.length };
}
