import React, { useState, useEffect } from 'react'
import { api, esc } from '../api.js'

export default function RLHF({ toast, loadStats: parentLoadStats, initialMessageId }) {
  const [stats, setStats] = useState(null)
  const [prog, setProg] = useState(null)
  const [tab, setTab] = useState('unrated')
  const [unrated, setUnrated] = useState([])
  const [rated, setRated] = useState([])
  const [focusId, setFocusId] = useState(initialMessageId || null)
  const [regenId, setRegenId] = useState(null)
  const [verSel, setVerSel] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const [promptFor, setPromptFor] = useState(null)
  const [promptData, setPromptData] = useState(null)
  const [rules, setRules] = useState([])
  const [showRetired, setShowRetired] = useState(false)
  const [ruleEditId, setRuleEditId] = useState(null)
  const [ruleEditText, setRuleEditText] = useState('')

  const viewPrompt = async (id) => {
    if (promptFor === id) { setPromptFor(null); setPromptData(null); return }
    try {
      const data = await api(`/api/messages/${id}/prompt`)
      setPromptData(data)
      setPromptFor(id)
    } catch (e) {
      toast('Erro ao carregar prompt', 'danger')
    }
  }

  const loadLearnStats = async () => {
    try {
      const data = await api('/api/learn/stats')
      setStats(data)
      if (parentLoadStats) parentLoadStats()
    } catch (e) {
      console.warn('Erro ao carregar estatísticas de aprendizado:', e)
    }
  }

  const loadLearnProgress = async () => {
    try {
      const data = await api('/api/learn/progress')
      setProg(data)
    } catch (e) {
      console.warn('Erro ao carregar progresso do aprendizado:', e)
    }
  }

  const loadRLHF = async () => {
    try {
      const [u, r] = await Promise.all([
        api('/api/rlhf/queue?filter=unrated'),
        api('/api/rlhf/queue?filter=rated'),
      ])
      setUnrated(u || [])
      setRated(r || [])
    } catch (e) {
      console.warn('Erro ao carregar fila RLHF:', e)
    }
  }

  const loadRules = async () => {
    try {
      const [list, impact] = await Promise.all([
        api('/api/learn/rules'),
        api('/api/learn/rule-impact').catch(() => []),
      ])
      const impById = Object.fromEntries((impact || []).map(i => [i.id, i]))
      setRules((list || []).map(r => ({ ...r, impact: impById[r.id] })))
    } catch (e) {
      console.warn('Erro ao carregar regras:', e)
    }
  }

  const patchRule = async (id, body, okMsg) => {
    try {
      await api(`/api/learn/rules/${id}`, 'PATCH', body)
      if (okMsg) toast(okMsg, 'success')
      setRuleEditId(null)
      loadRules(); loadLearnStats()
    } catch (e) { toast('Erro ao atualizar regra', 'danger') }
  }

  const deleteRule = async (id) => {
    try {
      await api(`/api/learn/rules/${id}`, 'DELETE')
      toast('Regra removida', 'success')
      loadRules(); loadLearnStats()
    } catch (e) { toast('Erro ao remover regra', 'danger') }
  }

  useEffect(() => {
    loadLearnStats()
    loadLearnProgress()
    loadRLHF()
    loadRules()
  }, [])

  // Foco vindo do botão "Editar mensagem" (aba WhatsApp): abre a mensagem na aba certa,
  // com o editor e o prompt já visíveis, e rola até ela.
  useEffect(() => {
    if (!focusId) return
    const inUnrated = unrated.find(m => m.id === focusId)
    const inRated = rated.find(m => m.id === focusId)
    const found = inUnrated || inRated
    if (!found) return
    setTab(inUnrated ? 'unrated' : 'rated')
    setEditingId(found.id)
    setEditText(found.content)
    if (promptFor !== found.id) viewPrompt(found.id)
    setFocusId(null)
    setTimeout(() => {
      const el = document.getElementById(`rlhf-msg-${found.id}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
  }, [unrated, rated, focusId]) // eslint-disable-line

  const triggerAnalysis = async () => {
    setAnalyzing(true)
    try {
      const res = await api('/api/learn/analyze', 'POST', {})
      if (res.ok) {
        const total = (res.analyzed || []).reduce((sum, r) => sum + r.rules_extracted, 0)
        toast(`${total} regras de estilo aprendidas!`, 'success')
      } else {
        toast(res.message || 'Sem correções suficientes ainda. Continue avaliando!', 'info')
      }
    } catch (e) {
      toast('Erro na análise', 'danger')
    } finally {
      setAnalyzing(false)
      loadLearnStats()
      loadLearnProgress()
      loadRules()
    }
  }

  const scoreMsgRLHF = async (id, score) => {
    try {
      await api(`/api/messages/${id}/score`, 'POST', { score })
      await loadRLHF()
      loadLearnStats()
      toast(score >= 4 ? '👍 Marcada como boa' : '👎 Marcada como ruim')
    } catch (e) {
      toast('Erro ao avaliar', 'danger')
    }
  }

  const approveMsgRLHF = async (id) => {
    try {
      await api(`/api/messages/${id}/approve`, 'POST')
      toast('Aprovada!', 'success')
      loadRLHF()
      loadLearnStats()
    } catch (e) {
      toast('Erro ao aprovar', 'danger')
    }
  }

  const saveRLHFCorrection = async (id) => {
    if (!editText.trim()) {
      toast('A correção não pode ficar vazia', 'warning')
      return
    }
    try {
      await api(`/api/messages/${id}/correct`, 'POST', { correction: editText })
      toast('Correção salva para aprendizado', 'success')
      setEditingId(null)
      loadRLHF()
      loadLearnStats()
    } catch (e) {
      toast('Erro ao salvar correção', 'danger')
    }
  }

  const regenerateRLHF = async (m) => {
    setRegenId(m.id)
    try {
      const d = await api(`/api/messages/${m.id}/regenerate`, 'POST', { observation: m.score_comment || '' })
      if (d && d.error) throw new Error(d.error)
      toast(m.score_comment ? 'Regerada com a observação.' : 'Regerada numa versão diferente.', 'success')
      loadRLHF()
    } catch (e) { toast('Erro ao gerar de novo', 'danger') }
    setRegenId(null)
  }

  const startEditing = (m) => {
    setEditingId(m.id)
    setEditText(m.content)
  }

  const chIcon = {
    linkedin: <i className="bi bi-linkedin text-primary"></i>, 
    email: <i className="bi bi-envelope text-danger"></i>, 
    whatsapp: <i className="bi bi-whatsapp text-success"></i>
  }
  
  const roleLabel = {
    c_level: "C-Level", 
    manager: "Gerente", 
    engineer: "Engenheiro", 
    other: "Outro"
  }

  const totalExamples = stats ? (stats.approved_examples || []).reduce((sum, e) => sum + e.total, 0) : 0
  const patternsCount = stats ? (stats.learned_patterns || []).length : 0
  const messages = tab === 'rated' ? rated : unrated

  return (
    <div className="tab-container">
      <div id="tab-rlhf">
        
        {/*  ── Painel de Aprendizado ───────────────────────────────────────────────  */}
        <div className="card p-3 mb-3 border-primary">
          <div className="d-flex justify-content-between align-items-start mb-3">
            <div>
              <h6 className="fw-bold mb-1"><i className="bi bi-cpu me-1 text-primary"></i>Aprendizado de Máquina</h6>
              <p className="text-muted small mb-0">O sistema melhora com suas avaliações e correções. Quanto mais você usa, melhor fica a geração futura.</p>
            </div>
            <div className="d-flex gap-2">
              <button className="btn btn-outline-secondary btn-sm" onClick={loadLearnStats}>
                <i className="bi bi-arrow-clockwise"></i>
              </button>
              <button 
                className={`btn btn-sm ${stats && stats.ready_to_analyze ? 'btn-success' : 'btn-primary'}`} 
                onClick={triggerAnalysis}
                disabled={analyzing}
              >
                {analyzing ? (
                  <><span className="spinner-border spinner-border-sm me-1"></span>Analisando...</>
                ) : stats && stats.ready_to_analyze ? (
                  <><i className="bi bi-lightbulb-fill me-1"></i>Analisar Padrões ({stats.corrections_pending_analysis || 0})</>
                ) : (
                  <><i className="bi bi-lightbulb me-1"></i>Analisar Padrões</>
                )}
              </button>
            </div>
          </div>
          
          <div className="row g-2 mb-3">
            <div className="col-6 col-md-3">
              <div className="border rounded p-2 text-center">
                <div className="fw-bold fs-5 text-warning">{stats?.avg_score || '—'}</div>
                <div className="text-muted">Score Médio ★</div>
              </div>
            </div>
            <div className="col-6 col-md-3">
              <div className="border rounded p-2 text-center">
                <div className="fw-bold fs-5 text-success">{totalExamples || 0}</div>
                <div className="text-muted">Exemplos Aprovados</div>
              </div>
            </div>
            <div className="col-6 col-md-3">
              <div className="border rounded p-2 text-center">
                <div className="fw-bold fs-5 text-info">{stats?.corrections_pending_analysis || 0}</div>
                <div className="text-muted" title="Reescritas do revisor + comentários de 👎 ainda não destilados em regras">Feedbacks p/ Analisar</div>
              </div>
            </div>
            <div className="col-6 col-md-3">
              <div className="border rounded p-2 text-center">
                <div className="fw-bold fs-5 text-primary">{patternsCount || 0}</div>
                <div className="text-muted">Padrões Aprendidos</div>
              </div>
            </div>
          </div>
          
          {stats && stats.learned_patterns && stats.learned_patterns.length > 0 && (
            <div>
              <h6 className="small fw-bold text-muted mb-2"><i className="bi bi-journal-text me-1"></i>Regras de estilo extraídas das suas correções:</h6>
              <div>
                {stats.learned_patterns.map((p, i) => (
                  <div key={i} className="d-flex align-items-start gap-2 mb-2 small">
                    <span className="badge bg-light text-dark border">
                      {p.channel === 'linkedin' ? <i className="bi bi-linkedin"></i> : 
                       p.channel === 'email' ? <i className="bi bi-envelope"></i> : 
                       p.channel === 'whatsapp' ? <i className="bi bi-whatsapp"></i> : p.channel}
                    </span>
                    <span className="badge bg-light text-dark border">{roleLabel[p.role] || p.role}</span>
                    <span className="text-muted flex-grow-1">{esc(p.pattern)}</span>
                    <span className="text-muted" style={{fontSize: '.7rem'}}>{Math.round(p.confidence * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/*  ── Gestão de Regras Aprendidas (#9) ────────────────────────────────────  */}
        <div className="card p-3 mb-3">
          <div className="d-flex justify-content-between align-items-start mb-3">
            <div>
              <h6 className="fw-bold mb-1"><i className="bi bi-sliders me-1 text-primary"></i>Regras Aprendidas (memória de longo prazo)</h6>
              <p className="text-muted small mb-0">Instruções destiladas do seu feedback e injetadas em toda geração. Edite, aposente ou remova para controlar o que a IA aplica.</p>
            </div>
            <div className="d-flex gap-2 align-items-center">
              <div className="form-check form-switch mb-0">
                <input className="form-check-input" type="checkbox" id="showRetired" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />
                <label className="form-check-label small text-muted" htmlFor="showRetired">Mostrar inativas</label>
              </div>
              <button className="btn btn-outline-secondary btn-sm" onClick={loadRules}><i className="bi bi-arrow-clockwise"></i></button>
            </div>
          </div>

          {(() => {
            const visible = rules.filter(r => showRetired || r.status === 'active')
            if (!visible.length) return <p className="text-muted small mb-0">Nenhuma regra {showRetired ? '' : 'ativa '}ainda. Corrija mensagens e clique em "Analisar Padrões".</p>
            return (
              <div className="table-responsive">
                <table className="table table-sm align-middle mb-0">
                  <thead><tr className="small text-muted">
                    <th>Canal</th><th>Cargo</th><th>Regra</th><th>Escopo</th><th style={{width:70}}>Conf.</th><th style={{width:90}} title="Variação do score médio do canal depois que a regra passou a existir">Impacto</th><th>Status</th><th style={{width:120}}></th>
                  </tr></thead>
                  <tbody>
                    {visible.map(r => (
                      <tr key={r.id} className="small" style={{opacity: r.status === 'active' ? 1 : 0.55}}>
                        <td>{r.channel === 'linkedin' ? <i className="bi bi-linkedin"></i> : r.channel === 'email' ? <i className="bi bi-envelope"></i> : r.channel === 'whatsapp' ? <i className="bi bi-whatsapp"></i> : r.channel}</td>
                        <td>{roleLabel[r.role] || r.role}</td>
                        <td style={{minWidth: 240}}>
                          {ruleEditId === r.id ? (
                            <div className="d-flex gap-1">
                              <input className="form-control form-control-sm" value={ruleEditText} onChange={e => setRuleEditText(e.target.value)} />
                              <button className="btn btn-success btn-sm" onClick={() => patchRule(r.id, { pattern: ruleEditText }, 'Regra atualizada')}><i className="bi bi-check2"></i></button>
                              <button className="btn btn-link btn-sm text-decoration-none" onClick={() => setRuleEditId(null)}>×</button>
                            </div>
                          ) : esc(r.pattern)}
                        </td>
                        <td>
                          <span className={`badge ${r.scope === 'global' ? 'bg-primary' : 'bg-light text-dark border'}`} role="button"
                            title="Alternar global/canal" onClick={() => patchRule(r.id, { scope: r.scope === 'global' ? 'channel' : 'global' })}>
                            {r.scope === 'global' ? 'global' : 'canal'}
                          </span>
                        </td>
                        <td>{Math.round((r.confidence || 0) * 100)}%</td>
                        <td>
                          {r.impact && r.impact.delta != null ? (
                            <span className={r.impact.delta > 0 ? 'text-success' : r.impact.delta < 0 ? 'text-danger' : 'text-muted'}
                              title={`Antes: ${r.impact.avg_before ?? '—'} (${r.impact.n_before}) → Depois: ${r.impact.avg_after ?? '—'} (${r.impact.n_after})`}>
                              {r.impact.delta > 0 ? `▲ +${r.impact.delta}` : r.impact.delta < 0 ? `▼ ${r.impact.delta}` : '– 0'}
                            </span>
                          ) : <span className="text-muted">—</span>}
                        </td>
                        <td><span className={`badge ${r.status === 'active' ? 'bg-success' : 'bg-secondary'}`}>{r.status || 'active'}</span></td>
                        <td className="text-end">
                          <button className="btn btn-outline-secondary btn-sm me-1" title="Editar" onClick={() => { setRuleEditId(r.id); setRuleEditText(r.pattern) }}><i className="bi bi-pencil"></i></button>
                          {r.status === 'active'
                            ? <button className="btn btn-outline-warning btn-sm me-1" title="Aposentar" onClick={() => patchRule(r.id, { status: 'retired' })}><i className="bi bi-pause"></i></button>
                            : <button className="btn btn-outline-success btn-sm me-1" title="Reativar" onClick={() => patchRule(r.id, { status: 'active' })}><i className="bi bi-play"></i></button>}
                          <button className="btn btn-outline-danger btn-sm" title="Remover" onClick={() => deleteRule(r.id)}><i className="bi bi-trash"></i></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })()}
        </div>

        {/*  ── Progresso do Aprendizado (evolução temporal) ────────────────────────  */}
        <div className="card p-3 mb-3">
          <div className="d-flex justify-content-between align-items-start mb-3">
            <div>
              <h6 className="fw-bold mb-1"><i className="bi bi-graph-up-arrow me-1 text-success"></i>Progresso do Aprendizado</h6>
              <p className="text-muted small mb-0">Evolução do RLHF ao longo do tempo. A tendência mostra se a qualidade está melhorando.</p>
            </div>
            <button className="btn btn-outline-secondary btn-sm" onClick={loadLearnProgress}>
              <i className="bi bi-arrow-clockwise"></i>
            </button>
          </div>

          {(() => {
            const s = prog?.summary || {}
            const t = s.trend || 0
            const trendCls = t > 0 ? 'text-success' : t < 0 ? 'text-danger' : 'text-muted'
            const trendTxt = t > 0 ? `▲ +${t}` : t < 0 ? `▼ ${t}` : '– 0'
            const ss = prog?.score_series || { labels: [], values: [] }
            const appr = prog?.approvals || { labels: [], values: [] }
            const corr = prog?.corrections || { labels: [], values: [] }
            // Une os dias das duas séries de feedback
            const apprMap = Object.fromEntries((appr.labels || []).map((d, i) => [d, appr.values[i]]))
            const corrMap = Object.fromEntries((corr.labels || []).map((d, i) => [d, corr.values[i]]))
            const days = Array.from(new Set([...(appr.labels || []), ...(corr.labels || [])])).sort()
            const maxFb = Math.max(1, ...days.map(d => (apprMap[d] || 0) + (corrMap[d] || 0)))
            return (
              <>
                <div className="row g-2 mb-3">
                  <div className="col-6 col-md-3">
                    <div className="border rounded p-2 text-center">
                      <div className="fw-bold fs-5 text-warning">{s.avg_last7 != null ? s.avg_last7 : '—'}</div>
                      <div className="text-muted" style={{fontSize: '.75rem'}}>Score Médio (7d)</div>
                    </div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="border rounded p-2 text-center">
                      <div className={`fw-bold fs-5 ${trendCls}`}>{trendTxt}</div>
                      <div className="text-muted" style={{fontSize: '.75rem'}}>Tendência vs. 7d ant.</div>
                    </div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="border rounded p-2 text-center">
                      <div className="fw-bold fs-5 text-info">{s.total_feedback || 0}</div>
                      <div className="text-muted" style={{fontSize: '.75rem'}}>Feedbacks Totais</div>
                    </div>
                  </div>
                  <div className="col-6 col-md-3">
                    <div className="border rounded p-2 text-center">
                      <div className="fw-bold fs-5 text-primary">{s.total_patterns || 0}</div>
                      <div className="text-muted" style={{fontSize: '.75rem'}}>Padrões Aprendidos</div>
                    </div>
                  </div>
                </div>

                <div className="row g-3">
                  <div className="col-12 col-lg-6">
                    <div className="small fw-bold text-muted mb-2">Score médio ao longo do tempo</div>
                    {ss.labels.length === 0 ? (
                      <p className="text-muted small mb-0">Ainda sem dados. Avalie mensagens para ver a evolução.</p>
                    ) : ss.labels.map((d, i) => (
                      <div key={d} className="d-flex align-items-center gap-2 mb-1">
                        <span className="text-muted" style={{fontSize: '.7rem', width: 70}}>{d.slice(5)}</span>
                        <div className="progress flex-grow-1" style={{height: 14}}>
                          <div className="progress-bar bg-warning" style={{width: `${(ss.values[i] || 0) / 5 * 100}%`}}></div>
                        </div>
                        <span className="text-muted" style={{fontSize: '.7rem', width: 28}}>{ss.values[i]}</span>
                      </div>
                    ))}
                  </div>
                  <div className="col-12 col-lg-6">
                    <div className="small fw-bold text-muted mb-2">Feedbacks por dia (aprovações + correções)</div>
                    {days.length === 0 ? (
                      <p className="text-muted small mb-0">Ainda sem feedbacks registrados.</p>
                    ) : days.map(d => (
                      <div key={d} className="d-flex align-items-center gap-2 mb-1">
                        <span className="text-muted" style={{fontSize: '.7rem', width: 70}}>{d.slice(5)}</span>
                        <div className="progress flex-grow-1" style={{height: 14}}>
                          <div className="progress-bar bg-success" style={{width: `${(apprMap[d] || 0) / maxFb * 100}%`}} title={`${apprMap[d] || 0} aprovações`}></div>
                          <div className="progress-bar bg-info" style={{width: `${(corrMap[d] || 0) / maxFb * 100}%`}} title={`${corrMap[d] || 0} correções`}></div>
                        </div>
                        <span className="text-muted" style={{fontSize: '.7rem', width: 28}}>{(apprMap[d] || 0) + (corrMap[d] || 0)}</span>
                      </div>
                    ))}
                    <div className="d-flex gap-3 mt-2">
                      <span className="small text-muted"><span className="badge bg-success">&nbsp;</span> Aprovações</span>
                      <span className="small text-muted"><span className="badge bg-info">&nbsp;</span> Correções</span>
                    </div>
                  </div>
                </div>
              </>
            )
          })()}
        </div>

        {/*  ── Curadoria de Mensagens ──────────────────────────────────────────────  */}
        <div className="card p-3">
          <div className="d-flex justify-content-between mb-3">
            <h6 className="fw-bold mb-0"><i className="bi bi-stars me-1"></i>Curadoria de Mensagens</h6>
            <button className="btn btn-outline-secondary btn-sm" onClick={loadRLHF}>
              <i className="bi bi-arrow-clockwise"></i>
            </button>
          </div>

          <ul className="nav nav-tabs mb-3">
            <li className="nav-item">
              <button className={`nav-link ${tab === 'unrated' ? 'active' : ''}`} onClick={() => setTab('unrated')}>
                Não avaliadas <span className="badge bg-secondary ms-1">{unrated.length}</span>
              </button>
            </li>
            <li className="nav-item">
              <button className={`nav-link ${tab === 'rated' ? 'active' : ''}`} onClick={() => setTab('rated')}>
                Já avaliadas <span className="badge bg-secondary ms-1">{rated.length}</span>
              </button>
            </li>
          </ul>

          <div>
            {messages.length === 0 ? (
              <p className="text-muted">{tab === 'unrated' ? 'Nenhuma mensagem pendente de avaliação.' : 'Nenhuma mensagem avaliada ainda.'}</p>
            ) : (
              messages.map(m => (
                <div key={m.id} id={`rlhf-msg-${m.id}`} className={`border rounded mb-3 p-3 ${editingId === m.id ? 'border-primary' : ''}`}>
                  <div className="d-flex justify-content-between mb-2 flex-wrap gap-2">
                    <span>
                      {chIcon[m.channel] || ''} <strong>{esc(m.company_name || '—')}</strong> — {esc(m.contact_name || '—')} ({m.contact_role || '—'})
                      {m.created_at && <span className="text-muted ms-2" style={{ fontSize: '.75rem' }}><i className="bi bi-clock me-1"></i>{new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>}
                    </span>
                    <div className="d-flex gap-1">
                      <button className={`btn btn-sm ${m.score >= 4 ? 'btn-success' : 'btn-outline-success'}`} onClick={() => scoreMsgRLHF(m.id, 5)} title="Marcar como boa">
                        <i className="bi bi-hand-thumbs-up"></i>
                      </button>
                      <button className={`btn btn-sm ${m.score != null && m.score <= 2 ? 'btn-danger' : 'btn-outline-danger'}`} onClick={() => scoreMsgRLHF(m.id, 1)} title="Marcar como ruim">
                        <i className="bi bi-hand-thumbs-down"></i>
                      </button>
                    </div>
                  </div>
                  
                  {editingId !== m.id && (
                    <div className="msg-box mb-2 p-2 border rounded bg-light" style={{whiteSpace: 'pre-wrap', fontSize: '.85rem'}}>
                      {esc(m.content)}
                    </div>
                  )}

                  {editingId === m.id && (
                    <div className="mb-2">
                      <textarea 
                        className="form-control form-control-sm mb-1" 
                        rows="4" 
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                      />
                      <button className="btn btn-sm btn-success me-1" onClick={() => saveRLHFCorrection(m.id)}>Salvar Correção</button>
                      <button className="btn btn-sm btn-link text-decoration-none" onClick={() => setEditingId(null)}>Cancelar</button>
                    </div>
                  )}
                  
                  {editingId !== m.id && (
                    <div className="d-flex gap-2 mt-1">
                      <button className="btn btn-success btn-sm" onClick={() => approveMsgRLHF(m.id)}>
                        <i className="bi bi-check2 me-1"></i>Aprovar
                      </button>
                      <button className="btn btn-outline-success btn-sm" onClick={() => regenerateRLHF(m)} disabled={regenId === m.id} title="Gera a mensagem de novo usando a observação (se houver) e o que a IA aprendeu">
                        {regenId === m.id ? <><span className="spinner-border spinner-border-sm me-1"></span>Gerando…</> : <><i className="bi bi-arrow-repeat me-1"></i>Gerar de novo</>}
                      </button>
                      <button className="btn btn-outline-secondary btn-sm" onClick={() => startEditing(m)}>
                        <i className="bi bi-pencil me-1"></i>Editar & Corrigir
                      </button>
                      <button className="btn btn-outline-info btn-sm" onClick={() => viewPrompt(m.id)}>
                        <i className="bi bi-code-square me-1"></i>{promptFor === m.id ? 'Ocultar prompt' : 'Ver prompt'}
                      </button>
                    </div>
                  )}

                  {promptFor === m.id && promptData && (
                    <div className="mt-2">
                      {promptData.reconstructed && (
                        <div className="small text-muted mb-1">
                          <i className="bi bi-info-circle me-1"></i>Mensagem antiga: prompt reconstruído com as observações atuais.
                        </div>
                      )}
                      <pre className="p-2 border rounded bg-dark text-light" style={{whiteSpace: 'pre-wrap', fontSize: '.75rem', maxHeight: 320, overflow: 'auto'}}>
                        {promptData.prompt_used}
                      </pre>
                    </div>
                  )}

                  {(() => {
                    let vers = []
                    try { vers = JSON.parse(m.versions || '[]') } catch {}
                    if (!vers.length) return null
                    const total = vers.length + 1
                    const selKey = verSel && verSel.startsWith(m.id + ':') ? verSel.split(':')[1] : null
                    const selVer = selKey === null ? null
                      : (selKey === 'atual' ? { content: m.content, prompt_used: m.prompt_used } : vers[Number(selKey)])
                    return (
                      <div className="mt-2">
                        <div className="small text-muted mb-1">
                          <i className="bi bi-clock-history me-1"></i>Versões desta mensagem (clique para ver o texto e o prompt de cada uma):
                        </div>
                        <div className="d-flex gap-1 flex-wrap mb-1">
                          {vers.map((v, i) => (
                            <button key={i} className={`btn btn-sm ${selKey === String(i) ? 'btn-secondary' : 'btn-outline-secondary'}`} style={{fontSize: '.7rem'}} onClick={() => setVerSel(selKey === String(i) ? null : `${m.id}:${i}`)}>
                              v{i + 1}
                            </button>
                          ))}
                          <button className={`btn btn-sm ${selKey === 'atual' ? 'btn-primary' : 'btn-outline-primary'}`} style={{fontSize: '.7rem'}} onClick={() => setVerSel(selKey === 'atual' ? null : `${m.id}:atual`)}>
                            v{total} (atual)
                          </button>
                        </div>
                        {selVer && (
                          <div className="border rounded p-2" style={{fontSize: '.78rem'}}>
                            <div className="fw-semibold small mb-1">Mensagem (v{selKey === 'atual' ? total : Number(selKey) + 1}):</div>
                            <div className="p-2 mb-2 rounded bg-light" style={{whiteSpace: 'pre-wrap'}}>{esc(selVer.content || '')}</div>
                            <div className="fw-semibold small mb-1">Prompt desta versão:</div>
                            <pre className="p-2 border rounded bg-dark text-light" style={{whiteSpace: 'pre-wrap', fontSize: '.72rem', maxHeight: 280, overflow: 'auto'}}>{selVer.prompt_used || '(sem prompt salvo desta versão)'}</pre>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
