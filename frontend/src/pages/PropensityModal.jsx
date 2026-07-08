import { useState } from 'react';

const API = '';

function scoreClass(s) {
  if (s >= 70) return 'bg-success';
  if (s >= 40) return 'bg-warning text-dark';
  return 'bg-secondary';
}

// Modal de geração em lote.
//   mode = 'propensity' -> pede produto, rankeia os leads por propensão de compra,
//          deixa selecionar um subconjunto e gera mensagens usando a dor sugerida.
//   mode = 'direct'     -> pede produto e gera mensagens para todos os selecionados.
export default function PropensityModal({ mode = 'propensity', companyIds = [], toast, onClose, onDone }) {
  const [product, setProduct] = useState('');
  const [phase, setPhase] = useState('input'); // input | ranking | generating | done
  const [rankings, setRankings] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [result, setResult] = useState(null);

  const isProp = mode === 'propensity';

  async function analyze() {
    if (!product.trim()) { toast('Informe o produto que você quer vender.', 'warning'); return; }
    setPhase('loading');
    try {
      const res = await fetch(`${API}/api/companies/propensity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_ids: companyIds, product: product.trim() }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      const rk = d.rankings || [];
      setRankings(rk);
      setPicked(new Set(rk.map((r) => r.company_id))); // começa com todos marcados
      setPhase('ranking');
    } catch (e) {
      toast(e.message || 'Erro ao analisar propensão.', 'danger');
      setPhase('input');
    }
  }

  function togglePick(id) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function generate(targets) {
    setPhase('generating');
    try {
      const res = await fetch(`${API}/api/companies/bulk-sequence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_value: product.trim(), targets }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setResult(d);
      setPhase('done');
      if (onDone) onDone();
    } catch (e) {
      toast(e.message || 'Erro ao gerar mensagens.', 'danger');
      setPhase(isProp ? 'ranking' : 'input');
    }
  }

  // Propensão: gera para o subconjunto marcado, usando a 1ª dor sugerida de cada lead
  function generateFromRanking() {
    const targets = rankings
      .filter((r) => picked.has(r.company_id))
      .map((r) => ({ company_id: r.company_id, pain_point: (r.pain_points || [])[0] || '' }));
    if (!targets.length) { toast('Marque pelo menos um cliente.', 'warning'); return; }
    generate(targets);
  }

  // Direto: gera para todos os selecionados, sem dor específica
  function generateDirect() {
    if (!product.trim()) { toast('Informe o produto.', 'warning'); return; }
    generate(companyIds.map((id) => ({ company_id: id })));
  }

  const title = isProp ? 'Analisar propensão & gerar em lote' : 'Gerar mensagens por produto';

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 2000, overflowY: 'auto' }}
      onClick={onClose}
    >
      <div
        className="card shadow"
        style={{ maxWidth: 720, margin: '40px auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header d-flex justify-content-between align-items-center">
          <h6 className="mb-0 fw-bold">
            <i className={`bi ${isProp ? 'bi-graph-up-arrow' : 'bi-envelope-paper'} me-2`}></i>{title}
          </h6>
          <button className="btn-close" onClick={onClose}></button>
        </div>

        <div className="card-body" style={{ overflowY: 'auto' }}>
          <p className="small text-muted">
            {companyIds.length} cliente(s) selecionado(s).{' '}
            {isProp
              ? 'O sistema vai ordenar por propensão de compra do produto e sugerir a dor de cada um. Você escolhe quais receberão as mensagens.'
              : 'As mensagens personalizadas serão geradas para todos os selecionados.'}
          </p>

          {/* Passo 1 — produto */}
          {(phase === 'input' || phase === 'loading') && (
            <>
              <label className="form-label small fw-semibold">Qual produto você quer vender?</label>
              <input
                className="form-control mb-3"
                placeholder="ex: infraestrutura cloud, automação de vendas com IA..."
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                disabled={phase === 'loading'}
                autoFocus
              />
              {isProp ? (
                <button className="btn btn-warning fw-semibold w-100" onClick={analyze} disabled={phase === 'loading'}>
                  {phase === 'loading'
                    ? <><span className="spinner-border spinner-border-sm me-2"></span>Analisando propensão...</>
                    : <><i className="bi bi-graph-up-arrow me-1"></i>Analisar propensão</>}
                </button>
              ) : (
                <button className="btn btn-success fw-semibold w-100" onClick={generateDirect} disabled={phase === 'loading'}>
                  <i className="bi bi-envelope-paper me-1"></i>Gerar mensagens para {companyIds.length} cliente(s)
                </button>
              )}
            </>
          )}

          {/* Passo 2 — ranking (só propensão) */}
          {phase === 'ranking' && (
            <>
              <div className="d-flex justify-content-between align-items-center mb-2">
                <span className="small fw-semibold">Ordenados por propensão a comprar “{product}”:</span>
                <span className="small text-muted">{picked.size} de {rankings.length} marcados</span>
              </div>
              <div className="d-flex flex-column gap-2">
                {rankings.map((r) => (
                  <div key={r.company_id} className={`border rounded p-2 ${picked.has(r.company_id) ? 'border-warning bg-light' : ''}`}>
                    <div className="d-flex align-items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.has(r.company_id)}
                        onChange={() => togglePick(r.company_id)}
                      />
                      <div className="flex-grow-1">
                        <div className="d-flex align-items-center gap-2">
                          <span className={`badge ${scoreClass(r.propensity_score)}`}>{r.propensity_score}</span>
                          <strong>{r.company_name}</strong>
                          {r.contact_name && <span className="text-muted small"><i className="bi bi-person me-1"></i>{r.contact_name}</span>}
                          {r.sector && r.sector !== 'nao informado' && <span className="text-muted small">· {r.sector}</span>}
                        </div>
                        {r.reason && <div className="small text-muted mt-1">{r.reason}</div>}
                        {(r.pain_points || []).length > 0 && (
                          <div className="small mt-1">
                            <span className="text-danger"><i className="bi bi-bullseye me-1"></i>Dor sugerida:</span>{' '}
                            {(r.pain_points || [])[0]}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn btn-success fw-semibold w-100 mt-3" onClick={generateFromRanking}>
                <i className="bi bi-envelope-paper me-1"></i>Gerar mensagens para {picked.size} selecionado(s)
              </button>
            </>
          )}

          {/* Gerando */}
          {phase === 'generating' && (
            <div className="text-center py-4">
              <span className="spinner-border text-primary me-2"></span>
              Gerando mensagens personalizadas... isso pode levar alguns segundos por cliente.
            </div>
          )}

          {/* Resultado */}
          {phase === 'done' && result && (
            <div>
              <div className="alert alert-success">
                <i className="bi bi-check-circle me-1"></i>
                {(result.results || []).length} cliente(s) com sequência gerada.
                {(result.errors || []).length > 0 && ` ${result.errors.length} com erro.`}
              </div>
              <p className="small text-muted mb-2">As mensagens ficaram em “Sequência criada” e aguardam sua aprovação em cada empresa.</p>
              {(result.errors || []).length > 0 && (
                <ul className="small text-danger">
                  {result.errors.map((e, i) => <li key={i}>Empresa #{e.company_id}: {e.error}</li>)}
                </ul>
              )}
              <button className="btn btn-primary w-100" onClick={onClose}>Fechar</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
