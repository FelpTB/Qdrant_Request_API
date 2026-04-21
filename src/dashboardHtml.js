/**
 * Retorna HTML do dashboard do pipeline (métricas em tempo real via SSE).
 * @returns {string}
 */
export function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pipeline de Vetorização</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 1rem; background: #1a1a2e; color: #eee; }
    h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    .card { background: #16213e; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .card h2 { margin: 0 0 0.5rem; font-size: 1rem; color: #a0a0a0; }
    .status { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: 600; }
    .status.idle { background: #333; color: #999; }
    .status.running { background: #2d5a27; color: #8f8; }
    .status.completed { background: #1e3a5f; color: #6cf; }
    .status.failed { background: #5a2d2d; color: #f88; }
    .row { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 0.5rem; }
    .metric { background: #0f0f1a; padding: 0.5rem 0.75rem; border-radius: 4px; min-width: 120px; }
    .metric span { display: block; font-size: 0.75rem; color: #888; }
    .metric strong { font-size: 1.1rem; }
    .form-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
    input[type="number"] { width: 100px; padding: 0.5rem; border: 1px solid #444; border-radius: 4px; background: #222; color: #eee; }
    button { padding: 0.5rem 1rem; border-radius: 4px; border: none; background: #3a6ea5; color: #fff; cursor: pointer; font-weight: 600; }
    button:hover { background: #4a7eb5; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #f88; font-size: 0.9rem; margin-top: 0.25rem; }
    #time { font-size: 1.25rem; }
  </style>
</head>
<body>
  <h1>Pipeline de Vetorização</h1>

  <div class="card">
    <h2>Controles</h2>
    <p style="margin:0 0 0.5rem;font-size:0.9rem;color:#aaa">Informe quantos perfis <strong>não vetorizados</strong> deseja processar nesta execução. O servidor lê o PostgreSQL em lotes (variável <code>PIPELINE_DB_QUERY_MAX</code>) até atingir o limite ou acabar a fila.</p>
    <div class="form-row">
      <label>Limite de registros:</label>
      <input type="number" id="limit" value="100" min="1" max="2000000" step="1">
      <button id="btnRun">Iniciar pipeline</button>
    </div>
    <div id="runError" class="error"></div>
  </div>

  <div class="card">
    <h2>Status</h2>
    <p>Status: <span id="status" class="status idle">idle</span></p>
    <p>Meta desta execução: <strong id="goalLimit">—</strong> registros</p>
    <p>Tempo de processo: <strong id="time">—</strong></p>
  </div>

  <div class="card">
    <h2>Fetch (Supabase)</h2>
    <div class="row">
      <div class="metric"><span>Total</span><strong id="fTotal">0</strong></div>
      <div class="metric"><span>Sucesso</span><strong id="fSuccess">0</strong></div>
      <div class="metric"><span>Duração (ms)</span><strong id="fDuration">0</strong></div>
      <div class="metric"><span>Erro</span><strong id="fError">—</strong></div>
    </div>
  </div>

  <div class="card">
    <h2>Transformação</h2>
    <div class="row">
      <div class="metric"><span>Lidos</span><strong id="tFetched">0</strong></div>
      <div class="metric"><span>Após filtros</span><strong id="tAfter">0</strong></div>
    </div>
  </div>

  <div class="card">
    <h2>Embeddings (OpenAI)</h2>
    <div class="row">
      <div class="metric"><span>Total</span><strong id="eTotal">0</strong></div>
      <div class="metric"><span>Sucesso</span><strong id="eSuccess">0</strong></div>
      <div class="metric"><span>Erros</span><strong id="eError">0</strong></div>
      <div class="metric"><span>Duração (ms)</span><strong id="eDuration">0</strong></div>
      <div class="metric"><span>Batches</span><strong id="eBatches">0</strong></div>
      <div class="metric"><span>Último erro</span><strong id="eLastError">—</strong></div>
    </div>
  </div>

  <div class="card">
    <h2>Upsert (Qdrant)</h2>
    <div class="row">
      <div class="metric"><span>Total</span><strong id="uTotal">0</strong></div>
      <div class="metric"><span>Sucesso</span><strong id="uSuccess">0</strong></div>
      <div class="metric"><span>Duração (ms)</span><strong id="uDuration">0</strong></div>
      <div class="metric"><span>Batches</span><strong id="uBatches">0</strong></div>
      <div class="metric"><span>Último erro</span><strong id="uLastError">—</strong></div>
    </div>
  </div>

  <div class="card">
    <h2>Mark vectorized (Banco)</h2>
    <div class="row">
      <div class="metric"><span>Atualizados</span><strong id="mUpdated">0</strong></div>
      <div class="metric"><span>Chunks</span><strong id="mChunks">0</strong></div>
      <div class="metric"><span>Duração (ms)</span><strong id="mDuration">0</strong></div>
      <div class="metric"><span>Último erro</span><strong id="mLastError">—</strong></div>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const timeEl = document.getElementById('time');
    const limitEl = document.getElementById('limit');
    const btnRun = document.getElementById('btnRun');
    const runError = document.getElementById('runError');

    function setStatus(s) {
      statusEl.textContent = s;
      statusEl.className = 'status ' + s;
      btnRun.disabled = s === 'running';
    }

    function formatMs(ms) {
      if (ms == null || ms === 0) return '—';
      if (ms < 1000) return ms + ' ms';
      return (ms / 1000).toFixed(1) + ' s';
    }

    function render(state) {
      setStatus(state.status || 'idle');
      const lim = state.limit;
      document.getElementById('goalLimit').textContent =
        lim != null && lim !== '' ? String(lim) : '—';
      const start = state.startedAt;
      const end = state.finishedAt || Date.now();
      if (start) {
        const ms = end - start;
        timeEl.textContent = formatMs(ms);
      } else {
        timeEl.textContent = '—';
      }

      const f = state.fetch || {};
      document.getElementById('fTotal').textContent = f.total ?? 0;
      document.getElementById('fSuccess').textContent = f.success ?? 0;
      document.getElementById('fDuration').textContent = f.duration_ms ?? 0;
      document.getElementById('fError').textContent = f.lastError || '—';

      const t = state.transform || {};
      document.getElementById('tFetched').textContent = t.fetched ?? 0;
      document.getElementById('tAfter').textContent = t.after_transform ?? 0;

      const e = state.embed || {};
      document.getElementById('eTotal').textContent = e.total ?? 0;
      document.getElementById('eSuccess').textContent = e.success ?? 0;
      document.getElementById('eError').textContent = e.error ?? 0;
      document.getElementById('eDuration').textContent = e.duration_ms ?? 0;
      document.getElementById('eBatches').textContent = e.batches ?? 0;
      document.getElementById('eLastError').textContent = e.lastError || '—';

      const u = state.upsert || {};
      document.getElementById('uTotal').textContent = u.total ?? 0;
      document.getElementById('uSuccess').textContent = u.success ?? 0;
      document.getElementById('uDuration').textContent = u.duration_ms ?? 0;
      document.getElementById('uBatches').textContent = u.batches ?? 0;
      document.getElementById('uLastError').textContent = u.lastError || '—';

      const m = state.mark || {};
      document.getElementById('mUpdated').textContent = m.updated ?? 0;
      document.getElementById('mChunks').textContent = m.chunks ?? 0;
      document.getElementById('mDuration').textContent = m.duration_ms ?? 0;
      document.getElementById('mLastError').textContent = m.lastError || '—';
    }

    let es = null;
    function connectStream() {
      if (es) es.close();
      const base = window.location.origin;
      es = new EventSource(base + '/pipeline/stream');
      es.onmessage = function (ev) {
        try {
          const state = JSON.parse(ev.data);
          render(state);
          if (state.status !== 'running') es.close();
        } catch (_) {}
      };
      es.onerror = function () { es.close(); };
    }

    btnRun.addEventListener('click', function () {
      runError.textContent = '';
      const limit = parseInt(limitEl.value, 10);
      if (!Number.isInteger(limit) || limit < 1) {
        runError.textContent = 'Informe um limite válido (inteiro >= 1).';
        return;
      }
      fetch(window.location.origin + '/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
      })
        .then(function (r) {
          if (r.status === 409) {
            runError.textContent = 'Pipeline já está em execução.';
            return;
          }
          if (!r.ok) return r.json().then(function (d) { runError.textContent = d.error || 'Erro ao iniciar'; });
          connectStream();
        })
        .catch(function () { runError.textContent = 'Erro de rede.'; });
    });

    fetch(window.location.origin + '/pipeline/status')
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {});
  </script>
</body>
</html>`;
}
