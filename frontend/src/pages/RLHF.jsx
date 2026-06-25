import React, { useState, useEffect } from 'react'
import { api, esc } from '../api.js'

export default function RLHF({ toast, loadStats: parentLoadStats }) {
  const [stats, setStats] = useState(null)
  const [messages, setMessages] = useState([])
  const [analyzing, setAnalyzing] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')

  const loadLearnStats = async () => {
    try {
      const data = await api('/api/learn/stats')
      setStats(data)
      if (parentLoadStats) parentLoadStats()
    } catch (e) {
      console.warn('Erro ao carregar estatísticas de aprendizado:', e)
    }
  }

  const loadRLHF = async () => {
    try {
      const data = await api('/api/rlhf/queue')
      setMessages(data || [])
    } catch (e) {
      console.warn('Erro ao carregar fila RLHF:', e)
    }
  }

  useEffect(() => {
    loadLearnStats()
    loadRLHF()
  }, [])

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
    }
  }

  const scoreMsgRLHF = async (id, score) => {
    try {
      await api(`/api/messages/${id}/score`, 'POST', { score })
      setMessages(msgs => msgs.map(m => m.id === id ? { ...m, score } : m))
      toast(`Score ${score}★`)
    } catch (e) {
      toast('Erro ao dar score', 'danger')
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
                <div className="text-muted">Correções p/ Analisar</div>
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

        {/*  ── Fila de Curadoria ───────────────────────────────────────────────────  */}
        <div className="card p-3">
          <div className="d-flex justify-content-between mb-3">
            <h6 className="fw-bold mb-0"><i className="bi bi-stars me-1"></i>Fila de Curadoria — Mensagens aguardando revisão humana</h6>
            <button className="btn btn-outline-secondary btn-sm" onClick={loadRLHF}>
              <i className="bi bi-arrow-clockwise"></i>
            </button>
          </div>
          
          <div>
            {messages.length === 0 ? (
              <p className="text-muted">Nenhuma mensagem aguardando revisão.</p>
            ) : (
              messages.map(m => (
                <div key={m.id} className="border rounded mb-3 p-3">
                  <div className="d-flex justify-content-between mb-2 flex-wrap gap-2">
                    <span>
                      {chIcon[m.channel] || ''} <strong>{esc(m.company_name || '—')}</strong> — {esc(m.contact_name || '—')} ({m.contact_role || '—'}) — Dia {m.day}
                    </span>
                    <div className="d-flex gap-1">
                      {[1, 2, 3, 4, 5].map(n => (
                        <button 
                          key={n}
                          className={`btn btn-sm ${m.score === n ? 'btn-warning' : 'btn-outline-warning'}`} 
                          onClick={() => scoreMsgRLHF(m.id, n)}
                        >
                          {n}★
                        </button>
                      ))}
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
                      <button className="btn btn-outline-secondary btn-sm" onClick={() => startEditing(m)}>
                        <i className="bi bi-pencil me-1"></i>Editar & Corrigir
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
