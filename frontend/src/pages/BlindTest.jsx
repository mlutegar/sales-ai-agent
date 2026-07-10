import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../api.js'

// Teste cego anti-detecção de bot (blind Turing test).
// Testadores que não conhecem o projeto veem mensagens reais x geradas pela
// automação e adivinham qual é qual. Sucesso = acerto agregado < 50%.
const REASON_TAGS = ['muito formal', 'rápido/robótico', 'genérico', 'jargão de marketing', 'sem erros humanos', 'estrutura de bot']

export default function BlindTest({ toast }) {
  const [tab, setTab] = useState('run')            // 'run' | 'seed' | 'results'
  const [tester, setTester] = useState('')
  const [started, setStarted] = useState(false)
  const [items, setItems] = useState([])
  const [idx, setIdx] = useState(0)
  const [score, setScore] = useState({ hits: 0, total: 0 })
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')

  const [realText, setRealText] = useState('')
  const [autoText, setAutoText] = useState('')
  const [scenario, setScenario] = useState('')
  const [reset, setReset] = useState(true)

  const [results, setResults] = useState(null)

  const loadResults = useCallback(async () => {
    try { setResults(await api('/api/blindtest/results')) } catch (e) { toast?.(e.message, 'error') }
  }, [toast])

  useEffect(() => { if (tab === 'results') loadResults() }, [tab, loadResults])

  const start = async () => {
    if (!tester.trim()) return toast?.('Informe o nome do testador', 'error')
    try {
      const r = await api('/api/blindtest/items')
      if (!r.items?.length) return toast?.('Nenhum item semeado ainda (aba "Semear")', 'error')
      setItems(r.items); setIdx(0); setScore({ hits: 0, total: 0 }); setReason(''); setStarted(true)
    } catch (e) { toast?.(e.message, 'error') }
  }

  const guess = async (g) => {
    const item = items[idx]
    if (!item || busy) return
    setBusy(true)
    try {
      const r = await api('/api/blindtest/guess', 'POST', { item_id: item.id, tester_name: tester.trim(), guess: g, reason: g === 'auto' ? reason : '' })
      setScore(s => ({ hits: s.hits + (r.correct ? 1 : 0), total: s.total + 1 }))
      setReason('')
      if (idx + 1 >= items.length) { setStarted(false); toast?.('Rodada concluída! Veja os resultados.', 'success'); setTab('results') }
      else setIdx(idx + 1)
    } catch (e) { toast?.(e.message, 'error') } finally { setBusy(false) }
  }

  const seed = async () => {
    const real = realText.split('\n---\n').map(t => t.trim()).filter(Boolean)
    const auto = autoText.split('\n---\n').map(t => t.trim()).filter(Boolean)
    if (!real.length && !auto.length) return toast?.('Cole ao menos uma mensagem', 'error')
    try {
      const r = await api('/api/blindtest/seed', 'POST', { real, auto, scenario: scenario.trim(), reset })
      toast?.(`${r.inserted} mensagens semeadas`, 'success')
      setRealText(''); setAutoText('')
    } catch (e) { toast?.(e.message, 'error') }
  }

  const harvest = async () => {
    try {
      const r = await api('/api/blindtest/harvest', 'POST', {})
      toast?.(`${r.harvested} regra(s) aprendida(s) a partir de ${r.candidates} mensagem(ns) mais detectada(s)`, 'success')
    } catch (e) { toast?.(e.message, 'error') }
  }

  const pct = (h, t) => t ? Math.round((h / t) * 100) : 0
  const cur = items[idx]

  return (
    <div className="py-3" style={{ maxWidth: 860 }}>
      <h4 className="mb-1"><i className="bi bi-incognito me-2" />Teste cego anti-bot</h4>
      <p className="text-muted small">Meta de sucesso: taxa de acerto agregada <strong>abaixo de 50%</strong> (mensagens da automação indistinguíveis das reais).</p>

      <ul className="nav nav-pills mb-3">
        {[['run', 'Rodar teste'], ['seed', 'Semear mensagens'], ['results', 'Resultados']].map(([k, label]) => (
          <li className="nav-item" key={k}>
            <button className={`nav-link${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          </li>
        ))}
      </ul>

      {tab === 'run' && !started && (
        <div className="card card-body">
          <label className="form-label">Nome do testador (quem não conhece o projeto)</label>
          <input className="form-control mb-3" value={tester} onChange={e => setTester(e.target.value)} placeholder="ex.: Ana" />
          <button className="btn btn-primary" onClick={start}>Começar rodada</button>
        </div>
      )}

      {tab === 'run' && started && cur && (
        <div className="card card-body">
          <div className="d-flex justify-content-between text-muted small mb-2">
            <span>Mensagem {idx + 1} de {items.length}</span>
            <span>Acertos: {score.hits}/{score.total}</span>
          </div>
          {cur.scenario ? <div className="small text-muted mb-1"><i className="bi bi-tag me-1" />Cenário: {cur.scenario}</div> : null}
          <div className="border rounded p-3 mb-3" style={{ background: '#e6ffda', whiteSpace: 'pre-wrap', minHeight: 90 }}>{cur.text}</div>
          <p className="text-center text-muted small mb-2">Essa mensagem foi escrita por uma pessoa real ou gerada pela automação?</p>
          <div className="d-flex flex-wrap gap-1 justify-content-center mb-2">
            {REASON_TAGS.map(t => (
              <button key={t} type="button" className={`btn btn-sm ${reason === t ? 'btn-secondary' : 'btn-outline-secondary'}`} onClick={() => setReason(reason === t ? '' : t)}>{t}</button>
            ))}
          </div>
          <p className="text-center text-muted" style={{ fontSize: '.75rem' }}>Marque um motivo (opcional) se achar que é automação.</p>
          <div className="d-flex gap-2 justify-content-center">
            <button className="btn btn-outline-success" disabled={busy} onClick={() => guess('real')}><i className="bi bi-person me-1" />Pessoa real</button>
            <button className="btn btn-outline-danger" disabled={busy} onClick={() => guess('auto')}><i className="bi bi-robot me-1" />Automação</button>
          </div>
        </div>
      )}

      {tab === 'seed' && (
        <div className="card card-body">
          <p className="small text-muted">Cole as mensagens separadas por uma linha com <code>---</code>. Elas serão embaralhadas e apresentadas sem revelar a origem. Para um teste mais justo, semeie <strong>um cenário por vez</strong> (mensagens reais e da automação sobre o mesmo assunto).</p>
          <label className="form-label">Cenário (opcional, mas recomendado)</label>
          <input className="form-control mb-3" value={scenario} onChange={e => setScenario(e.target.value)} placeholder="ex.: primeira abordagem para gerente de RH" />
          <label className="form-label">Mensagens REAIS (escritas por humanos)</label>
          <textarea className="form-control mb-3" rows={6} value={realText} onChange={e => setRealText(e.target.value)} placeholder={'oi joão, tudo certo?\n---\nvi que vocês abriram vaga...'} />
          <label className="form-label">Mensagens da AUTOMAÇÃO (geradas)</label>
          <textarea className="form-control mb-3" rows={6} value={autoText} onChange={e => setAutoText(e.target.value)} placeholder={'mensagem gerada 1\n---\nmensagem gerada 2'} />
          <div className="form-check mb-3">
            <input className="form-check-input" type="checkbox" id="reset" checked={reset} onChange={e => setReset(e.target.checked)} />
            <label className="form-check-label" htmlFor="reset">Zerar itens e palpites anteriores</label>
          </div>
          <button className="btn btn-primary" onClick={seed}>Semear</button>
        </div>
      )}

      {tab === 'results' && (
        <div className="card card-body">
          {!results ? <div className="text-muted">Carregando…</div> : (
            <>
              <div className={`alert ${results.success ? 'alert-success' : results.total ? 'alert-warning' : 'alert-secondary'}`}>
                {results.total === 0 ? 'Ainda não há palpites registrados.' : (
                  <>
                    Taxa de acerto agregada: <strong>{pct(results.hits, results.total)}%</strong> ({results.hits}/{results.total}).{' '}
                    {results.success
                      ? '✅ Sucesso — abaixo de 50%, a automação está indistinguível das mensagens reais.'
                      : '⚠️ Acima de 50% — os testadores ainda identificam a automação. Ajuste os critérios de humanização.'}
                  </>
                )}
              </div>

              {results.testers?.length > 0 && (
                <table className="table table-sm">
                  <thead><tr><th>Testador</th><th className="text-end">Acertos</th><th className="text-end">Taxa</th></tr></thead>
                  <tbody>
                    {results.testers.map(t => (
                      <tr key={t.tester_name}>
                        <td>{t.tester_name}</td>
                        <td className="text-end">{t.hits}/{t.total}</td>
                        <td className="text-end">{pct(t.hits, t.total)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {results.reasons?.length > 0 && (
                <div className="mb-3">
                  <div className="small text-muted mb-1">Por que acharam que era automação:</div>
                  <div className="d-flex flex-wrap gap-2">
                    {results.reasons.map(r => (
                      <span key={r.reason} className="badge bg-light text-dark border">{r.reason} <strong>×{r.n}</strong></span>
                    ))}
                  </div>
                </div>
              )}

              <div className="d-flex gap-2">
                <button className="btn btn-sm btn-outline-secondary" onClick={loadResults}>Atualizar</button>
                <button className="btn btn-sm btn-outline-primary" onClick={harvest} title="Transforma as mensagens mais detectadas em regras aprendidas (RLHF)">
                  <i className="bi bi-mortarboard me-1" />Aprender com as falhas
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
