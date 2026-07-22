/**
 * Interface X-Ray: agente IA planeja args da tool MCP search_text e executa a busca.
 */
export function getSearchXrayHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Busca X-Ray · Agente MCP</title>
  <style>
    :root {
      --bg: #12141a;
      --panel: #1a1e28;
      --panel-2: #222833;
      --border: #2e3545;
      --text: #e8eaef;
      --muted: #8b93a7;
      --accent: #3d8bfd;
      --accent-2: #2a5fad;
      --ok: #3dd68c;
      --warn: #f5a524;
      --err: #f31260;
      --mono: "Cascadia Code", "Fira Code", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding: 1rem 1.25rem;
      background: linear-gradient(180deg, #1a2030 0%, var(--bg) 100%);
    }
    header h1 { margin: 0; font-size: 1.25rem; }
    header p { margin: 0.35rem 0 0; color: var(--muted); font-size: 0.9rem; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 1rem 1.25rem 2.5rem; }
    .search-bar {
      display: flex; gap: 0.6rem; flex-wrap: wrap;
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 10px; padding: 0.85rem;
    }
    .search-bar input[type="text"] {
      flex: 1 1 280px; min-width: 200px;
      padding: 0.75rem 0.9rem; border-radius: 8px;
      border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
      font-size: 1rem;
    }
    .search-bar input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); border-color: var(--accent); }
    button {
      padding: 0.7rem 1.1rem; border: none; border-radius: 8px;
      background: var(--accent); color: #fff; font-weight: 650; cursor: pointer;
    }
    button:hover { background: var(--accent-2); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .hint { color: var(--muted); font-size: 0.82rem; margin: 0.45rem 0 0; }
    .error { color: var(--err); font-size: 0.9rem; margin-top: 0.5rem; }
    .grid { display: grid; gap: 1rem; margin-top: 1rem; }
    @media (min-width: 900px) { .grid.two { grid-template-columns: 1fr 1fr; align-items: start; } }
    .card {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 10px; padding: 1rem;
    }
    .card h2 {
      margin: 0 0 0.75rem; font-size: 0.78rem; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--muted); font-weight: 700;
    }
    .badge {
      display: inline-flex; align-items: center; gap: 0.3rem;
      padding: 0.15rem 0.45rem; border-radius: 999px;
      font-size: 0.72rem; font-weight: 650; background: var(--panel-2); color: var(--muted);
      border: 1px solid var(--border);
    }
    .badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
    .badge.err { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, var(--border)); }
    .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--border)); }
    .meta { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.75rem; }
    .reasoning {
      background: var(--panel-2); border: 1px solid var(--border);
      border-radius: 8px; padding: 0.75rem; font-size: 0.92rem;
      white-space: pre-wrap;
    }
    .xray {
      font-family: var(--mono); font-size: 0.74rem;
      background: #0d1017; border: 1px solid var(--border);
      border-radius: 8px; padding: 0.75rem; overflow: auto; max-height: 480px;
      white-space: pre-wrap; word-break: break-word; color: #c9d1d9; margin: 0;
    }
    .tabs { display: flex; gap: 0.35rem; margin-bottom: 0.55rem; flex-wrap: wrap; }
    .tabs button {
      padding: 0.35rem 0.65rem; font-size: 0.78rem; font-weight: 600;
      background: var(--panel-2); color: var(--muted); border: 1px solid var(--border);
    }
    .tabs button.active {
      color: #fff; border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 25%, var(--panel-2));
    }
    .chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.65rem; }
    .chip {
      font-family: var(--mono); font-size: 0.72rem;
      background: #0d1017; border: 1px solid var(--border);
      border-radius: 6px; padding: 0.25rem 0.45rem; color: var(--muted);
    }
    .chip b { color: var(--text); }
    .result {
      border: 1px solid var(--border); border-radius: 8px;
      padding: 0.75rem; margin-bottom: 0.65rem; background: var(--panel-2);
    }
    .result .top {
      display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline;
    }
    .result h3 { margin: 0; font-size: 1rem; }
    .result .score { color: var(--accent); font-family: var(--mono); font-size: 0.85rem; }
    .scores { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.5rem 0; }
    .scores span {
      font-family: var(--mono); font-size: 0.7rem;
      background: #0d1017; border: 1px solid var(--border);
      border-radius: 4px; padding: 0.15rem 0.35rem; color: var(--muted);
    }
    .payload { font-size: 0.82rem; color: var(--muted); display: grid; gap: 0.2rem; }
    .payload b { color: var(--text); font-weight: 600; }
    .opts { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 0.55rem; }
    .opts label { font-size: 0.85rem; color: var(--muted); display: flex; gap: 0.35rem; align-items: center; }
    .opts input[type="number"] {
      width: 72px; padding: 0.3rem 0.4rem; border-radius: 6px;
      border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
    }
    .step {
      display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem;
      font-size: 0.82rem; color: var(--muted);
    }
    .step.on { color: var(--ok); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
    .step.on .dot { background: var(--ok); }
  </style>
</head>
<body>
  <header>
    <div class="wrap" style="padding-top:0;padding-bottom:0">
      <h1>Busca X-Ray · Agente MCP</h1>
      <p>O agente interpreta sua query, monta pesos / queries densas / BM25 como argumentos da tool <code>search_text</code> e executa a busca. O painel mostra o tool call MCP completo.</p>
    </div>
  </header>

  <div class="wrap">
    <form id="form" class="search-bar">
      <input type="text" id="query" placeholder="Ex.: preciso de instalação de energia solar em SP para condomínios" required autocomplete="off">
      <button type="submit" id="btn">Buscar com agente</button>
    </form>
    <div class="opts">
      <label>final_limit <input type="number" id="final_limit" min="1" max="50" value="10"></label>
      <span class="hint" id="configHint">Carregando /config…</span>
    </div>
    <div id="formError" class="error"></div>

    <div class="grid two" style="margin-top:1rem">
      <section class="card">
        <h2>Pipeline do agente</h2>
        <div class="step" id="s1"><span class="dot"></span> 1. Pedido do usuário</div>
        <div class="step" id="s2"><span class="dot"></span> 2. Agente planeja tool MCP search_text</div>
        <div class="step" id="s3"><span class="dot"></span> 3. Executa busca (mesma lógica da tool)</div>
        <div class="step" id="s4"><span class="dot"></span> 4. Resultados</div>
        <h2 style="margin-top:1rem">Raciocínio da IA</h2>
        <div class="reasoning" id="reasoning">Aguardando…</div>
        <div class="chips" id="paramChips"></div>
      </section>

      <section class="card">
        <h2>X-Ray · tool call MCP</h2>
        <div class="tabs">
          <button type="button" class="active" data-tab="tool">mcp_tool_call</button>
          <button type="button" data-tab="weights">weights</button>
          <button type="button" data-tab="queries">queries</button>
          <button type="button" data-tab="meta">agent meta</button>
        </div>
        <pre class="xray" id="xray">Aguardando busca…</pre>
        <div class="meta" id="statusMeta"></div>
      </section>
    </div>

    <section class="card" style="margin-top:1rem">
      <h2>Resultados <span id="resultsCount" class="badge">0</span></h2>
      <div id="results"></div>
    </section>
  </div>

  <script>
    const state = { config: null, last: null, tab: "tool" };
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));

    function setSteps(n) {
      for (let i = 1; i <= 4; i++) {
        $("s" + i).classList.toggle("on", i <= n);
      }
    }

    function renderChips(args) {
      if (!args) { $("paramChips").innerHTML = ""; return; }
      const chips = [];
      if (args.weights) {
        for (const [k, v] of Object.entries(args.weights)) {
          chips.push("<span class='chip'><b>" + esc(k) + "</b> " + Number(v).toFixed(3) + "</span>");
        }
      }
      if (args.bm25_query) chips.push("<span class='chip'><b>bm25</b> " + esc(args.bm25_query) + "</span>");
      if (args.filter) chips.push("<span class='chip'><b>filter</b> " + esc(JSON.stringify(args.filter)) + "</span>");
      if (args.filter_not) chips.push("<span class='chip'><b>filter_not</b> " + esc(JSON.stringify(args.filter_not)) + "</span>");
      if (args.rerank) chips.push("<span class='chip'><b>rerank</b> on</span>");
      $("paramChips").innerHTML = chips.join("");
    }

    function renderXray() {
      const d = state.last;
      if (!d) { $("xray").textContent = "Aguardando busca…"; return; }
      const args = d.mcp_tool_call?.arguments || {};
      const map = {
        tool: d.mcp_tool_call,
        weights: args.weights || {},
        queries: {
          query: args.query,
          queries: args.queries || null,
          bm25_query: args.bm25_query ?? null,
          bm25: args.bm25,
        },
        meta: {
          model: d.model,
          duration_ms: d.duration_ms,
          search_duration_ms: d.search_duration_ms,
          tokens_used: d.tokens_used,
          user_query: d.user_query,
          embedding_model: d.search?.embedding_model,
          embedding_dims: d.search?.embedding_dims,
          query_texts: d.search?.query_texts,
        },
      };
      $("xray").textContent = JSON.stringify(map[state.tab] ?? map.tool, null, 2);
    }

    function renderResults(payload) {
      const results = payload?.results || [];
      $("resultsCount").textContent = String(results.length);
      if (!results.length) {
        $("results").innerHTML = "<p class='hint'>Nenhum resultado.</p>";
        return;
      }
      $("results").innerHTML = results.map((r) => {
        const scores = Object.entries(r.scores || {})
          .map(([k, v]) => "<span>" + esc(k) + ": " + Number(v).toFixed(4) + "</span>")
          .join("");
        const p = r.payload || {};
        return (
          '<article class="result">' +
            '<div class="top">' +
              '<h3>' + esc(r.posicao) + ". " + esc(p.nome_empresa || r.id) + '</h3>' +
              '<div class="score">final ' + Number(r.score_final ?? 0).toFixed(4) + '</div>' +
            '</div>' +
            '<div class="scores">' + scores + '</div>' +
            '<div class="payload">' +
              '<div><b>CNPJ</b> ' + esc(p.cnpj || "—") + ' · <b>UF</b> ' + esc(p.uf || "—") + ' · <b>Cidade</b> ' + esc(p.cidade || "—") + '</div>' +
              '<div><b>Modelo</b> ' + esc(p.modelo_negocio || "—") + '</div>' +
              '<div><b>Descrição</b> ' + esc((p.descricao || "").slice(0, 240)) + ((p.descricao || "").length > 240 ? "…" : "") + '</div>' +
            '</div>' +
          '</article>'
        );
      }).join("");
    }

    async function loadConfig() {
      const res = await fetch("/config");
      if (!res.ok) throw new Error("Falha ao carregar /config");
      state.config = await res.json();
      $("configHint").textContent =
        "dims: " + (state.config.dimension_keys || []).join(", ") +
        (state.config.bm25?.vector_name ? " · BM25 on" : " · BM25 off");
    }

    async function run(e) {
      e.preventDefault();
      $("formError").textContent = "";
      $("statusMeta").innerHTML = "";
      const btn = $("btn");
      btn.disabled = true;
      btn.textContent = "Agente pensando…";
      setSteps(1);
      $("reasoning").textContent = "Planejando parâmetros da tool search_text…";
      try {
        const body = {
          query: $("query").value.trim(),
          final_limit: Number($("final_limit").value) || 10,
        };
        setSteps(2);
        const res = await fetch("/search/xray/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));

        state.last = data;
        setSteps(4);
        $("reasoning").textContent = data.reasoning || "(sem reasoning)";
        renderChips(data.mcp_tool_call?.arguments);
        state.tab = "tool";
        document.querySelectorAll(".tabs button").forEach((b) => {
          b.classList.toggle("active", b.dataset.tab === "tool");
        });
        renderXray();
        renderResults(data.search);
        $("statusMeta").innerHTML =
          '<span class="badge ok">tool search_text</span>' +
          '<span class="badge">' + esc(data.model) + '</span>' +
          '<span class="badge">agent ' + esc(data.duration_ms) + ' ms</span>' +
          '<span class="badge">search ' + esc(data.search_duration_ms) + ' ms</span>' +
          '<span class="badge">' + (data.search?.results?.length || 0) + ' results</span>';
      } catch (err) {
        setSteps(1);
        $("formError").textContent = err.message || String(err);
        $("statusMeta").innerHTML = '<span class="badge err">erro</span>';
      } finally {
        btn.disabled = false;
        btn.textContent = "Buscar com agente";
      }
    }

    document.querySelectorAll(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tab = btn.dataset.tab;
        document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
        renderXray();
      });
    });
    $("form").addEventListener("submit", run);
    loadConfig().catch((err) => {
      $("configHint").textContent = "Erro: " + err.message;
      $("formError").textContent = err.message;
    });
  </script>
</body>
</html>`;
}
