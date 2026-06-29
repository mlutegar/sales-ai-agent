import React, { useState, useEffect } from 'react'
import { api, esc, ROLE_LABEL } from '../api.js'

export default function FollowUps({ toast, loadStats, dataVersion }) {
  const [days, setDays] = useState('7')
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(false)
  const [generatingFor, setGeneratingFor] = useState(null)
  
  // States para cada linha da tabela
  const [channels, setChannels] = useState({})

  const loadFollowupPending = async () => {
    setLoading(true)
    try {
      const data = await api(`/api/followup/pending?days=${days}`)
      setPending(data || [])
    } catch (e) {
      toast('Erro ao carregar follow-ups', 'danger')
    } finally {
      setLoading(false)
    }
  }

  // Recarrega ao trocar o filtro de dias e sempre que houver uma mutação global
  // (ex.: empresa/contato excluído em outra aba) via dataVersion.
  useEffect(() => {
    loadFollowupPending()
  }, [days, dataVersion])

  // Recarrega quando o usuário volta o foco para a janela/aba do navegador.
  useEffect(() => {
    const onFocus = () => loadFollowupPending()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [days])

  const genFollowup = async (id) => {
    const ch = channels[id] || 'email'
    setGeneratingFor(id)
    try {
      const res = await api(`/api/followup/${id}/generate`, 'POST', { channel: ch })
      toast('Follow-up gerado! Verifique na aba RLHF.', 'success')
      loadFollowupPending()
      if (loadStats) loadStats()
    } catch (e) {
      toast('Erro ao gerar follow-up', 'danger')
    } finally {
      setGeneratingFor(null)
    }
  }

  const handleChannelChange = (id, value) => {
    setChannels(prev => ({ ...prev, [id]: value }))
  }

  return (
    <div className="tab-container">
      <div id="tab-followup">
        <div className="card p-3">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h6 className="fw-bold mb-0"><i className="bi bi-clock-history me-1 text-warning"></i>Follow-ups Pendentes</h6>
            <div className="d-flex gap-2 align-items-center">
              <select 
                className="form-select form-select-sm" 
                value={days}
                onChange={(e) => setDays(e.target.value)}
              >
                <option value="3">3+ dias sem contato</option>
                <option value="7">7+ dias sem contato</option>
                <option value="14">14+ dias sem contato</option>
                <option value="30">30+ dias sem contato</option>
              </select>
              <button className="btn btn-outline-secondary btn-sm" onClick={loadFollowupPending}>
                <i className="bi bi-arrow-clockwise"></i>
              </button>
            </div>
          </div>
          
          <div>
            {loading ? (
              <p className="text-muted small">Carregando...</p>
            ) : pending.length === 0 ? (
              <p className="text-muted small text-center py-3">
                <i className="bi bi-check-circle text-success me-1"></i>Nenhum follow-up pendente.
              </p>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm table-hover align-middle">
                  <thead className="table-light">
                    <tr>
                      <th>Lead</th>
                      <th>Empresa</th>
                      <th>Setor</th>
                      <th>Dias sem resp.</th>
                      <th>Canal</th>
                      <th>Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map(r => (
                      <tr key={r.id}>
                        <td>
                          {esc(r.name)}{' '}
                          <span className="badge bg-secondary">{ROLE_LABEL[r.role] || r.role}</span>
                        </td>
                        <td>{esc(r.company || '')}</td>
                        <td>{esc(r.sector || '')}</td>
                        <td>
                          <span className={`badge ${r.days_since >= 7 ? 'bg-danger' : 'bg-warning text-dark'}`}>
                            {r.days_since} dias
                          </span>
                        </td>
                        <td>
                          <select 
                            className="form-select form-select-sm" 
                            style={{width: '110px'}}
                            value={channels[r.id] || 'email'}
                            onChange={(e) => handleChannelChange(r.id, e.target.value)}
                          >
                            <option value="email">Email</option>
                            <option value="linkedin">LinkedIn</option>
                            <option value="whatsapp">WhatsApp</option>
                          </select>
                        </td>
                        <td>
                          <button 
                            className="btn btn-warning btn-sm" 
                            onClick={() => genFollowup(r.id)}
                            disabled={generatingFor === r.id}
                          >
                            {generatingFor === r.id ? (
                              <span className="spinner-border spinner-border-sm"></span>
                            ) : (
                              <><i className="bi bi-send me-1"></i>Gerar</>
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
