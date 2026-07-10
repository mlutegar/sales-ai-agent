import React, { useState, useEffect } from 'react'
import { api, esc, STATUS_LABEL } from '../api.js'

export default function Dashboard({ toast }) {
  const [companies, setCompanies] = useState([])

  const loadDashboard = async () => {
    try {
      const data = await api('/api/companies')
      setCompanies(data || [])
    } catch (e) {
      toast('Erro ao carregar dados do dashboard', 'danger')
    }
  }

  useEffect(() => {
    loadDashboard()
  }, [])

  // Funil de status
  const statusOrder = ['new', 'researched', 'sequence_created', 'contacted', 'hot_lead', 'meeting_set']
  const statusColors = {
    new: '#667085', researched: '#0e7490', sequence_created: '#1d4ed8',
    contacted: '#1d4ed8', hot_lead: '#b42318', meeting_set: '#17825b',
  }
  const statusCounts = {}
  companies.forEach(c => { statusCounts[c.status] = (statusCounts[c.status] || 0) + 1 })

  // Distribuição por setor
  const sectorCounts = {}
  companies.forEach(c => {
    const s = c.sector || 'Sem setor'
    sectorCounts[s] = (sectorCounts[s] || 0) + 1
  })
  const totalSectors = companies.length || 1
  const sectors = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])

  // Score médio
  const scoredCompanies = companies.filter(c => c.interest_score > 0)
  const avgScore = scoredCompanies.length
    ? (scoredCompanies.reduce((sum, c) => sum + c.interest_score, 0) / scoredCompanies.length).toFixed(1)
    : '—'

  // Abordagens disparadas (cold/warm/frozen) — soma por empresa
  const callTotals = companies.reduce((acc, c) => {
    acc.cold += c.cold_calls || 0
    acc.warm += c.warm_calls || 0
    acc.frozen += c.frozen_calls || 0
    return acc
  }, { cold: 0, warm: 0, frozen: 0 })
  const callTotalAll = callTotals.cold + callTotals.warm + callTotals.frozen

  // Top 5
  const top5 = [...companies]
    .filter(c => c.interest_score > 0)
    .sort((a, b) => b.interest_score - a.interest_score)
    .slice(0, 5)

  return (
    <div className="tab-container">
      <div id="tab-dashboard">
        <div className="row g-3">
          
          {/* Funil de status */}
          <div className="col-12">
            <div className="card p-3">
              <h6 className="fw-bold mb-3"><i className="bi bi-filter me-1"></i>Funil de Status</h6>
              <div className="d-flex gap-2 flex-wrap align-items-stretch">
                {statusOrder.map((s, idx) => {
                  const count = statusCounts[s] || 0
                  const color = statusColors[s] || '#6c757d'
                  const active = count > 0
                  return (
                    <React.Fragment key={s}>
                      <div style={{
                        flex: '1 1 0', minWidth: 92, textAlign: 'center', borderRadius: 8,
                        padding: '14px 8px', background: active ? color : '#f9fafb',
                        color: active ? '#fff' : '#98a2b3', border: active ? 'none' : '1px solid #eef0f3',
                        boxShadow: active ? '0 1px 2px rgba(16,24,40,.1)' : 'none',
                      }}>
                        <div style={{ fontSize: '1.7rem', fontWeight: 700, lineHeight: 1 }}>{count}</div>
                        <div style={{ fontSize: '.72rem', marginTop: 5 }}>{STATUS_LABEL[s] || s}</div>
                      </div>
                      {idx < statusOrder.length - 1 && (
                        <div className="d-flex align-items-center text-muted">→</div>
                      )}
                    </React.Fragment>
                  )
                })}
              </div>
              {((statusCounts.needs_followup || 0) + (statusCounts.rejected || 0) + (statusCounts.opted_out || 0)) > 0 && (
                <div className="d-flex gap-3 mt-3 pt-2 border-top small text-muted flex-wrap">
                  <span className="fw-semibold">Fora do funil:</span>
                  {statusCounts.needs_followup > 0 && <span><span className="badge bg-warning text-dark me-1">{statusCounts.needs_followup}</span>Aguard. follow-up</span>}
                  {statusCounts.rejected > 0 && <span><span className="badge bg-secondary me-1">{statusCounts.rejected}</span>Rejeitados</span>}
                  {statusCounts.opted_out > 0 && <span><span className="badge bg-dark me-1">{statusCounts.opted_out}</span>Opt-out</span>}
                </div>
              )}
            </div>
          </div>
          
          {/* Abordagens disparadas por tipo (cold/warm/frozen) */}
          <div className="col-12">
            <div className="card p-3">
              <h6 className="fw-bold mb-3"><i className="bi bi-telephone-outbound me-1"></i>Abordagens disparadas por tipo</h6>
              <div className="d-flex gap-2 flex-wrap">
                {[
                  { key: 'cold', label: '❄️ Cold', color: '#0e7490' },
                  { key: 'warm', label: '🔥 Warm', color: '#b45309' },
                  { key: 'frozen', label: '🧊 Frozen', color: '#1d4ed8' },
                ].map(({ key, label, color }) => (
                  <div key={key} style={{
                    flex: '1 1 0', minWidth: 110, textAlign: 'center', borderRadius: 8,
                    padding: '14px 8px', background: callTotals[key] > 0 ? color : '#f9fafb',
                    color: callTotals[key] > 0 ? '#fff' : '#98a2b3',
                    border: callTotals[key] > 0 ? 'none' : '1px solid #eef0f3',
                  }}>
                    <div style={{ fontSize: '1.7rem', fontWeight: 700, lineHeight: 1 }}>{callTotals[key]}</div>
                    <div style={{ fontSize: '.72rem', marginTop: 5 }}>{label}</div>
                  </div>
                ))}
                <div style={{
                  flex: '1 1 0', minWidth: 110, textAlign: 'center', borderRadius: 8,
                  padding: '14px 8px', background: '#111827', color: '#fff',
                }}>
                  <div style={{ fontSize: '1.7rem', fontWeight: 700, lineHeight: 1 }}>{callTotalAll}</div>
                  <div style={{ fontSize: '.72rem', marginTop: 5 }}>Total</div>
                </div>
              </div>
            </div>
          </div>

          <div className="col-12 col-md-6">
            <div className="card p-3">
              <h6 className="fw-bold mb-3"><i className="bi bi-pie-chart me-1"></i>Distribuição por Setor</h6>
              <div>
                {sectors.length === 0 ? (
                  <p className="text-muted small">Nenhum dado.</p>
                ) : (
                  sectors.map(([name, count]) => {
                    const pct = Math.round((count / totalSectors) * 100)
                    return (
                      <div key={name} className="mb-2">
                        <div className="d-flex justify-content-between small mb-1">
                          <span>{esc(name)}</span><span><strong>{count}</strong> ({pct}%)</span>
                        </div>
                        <div className="progress" style={{ height: '8px' }}>
                          <div className="progress-bar bg-primary" style={{ width: `${pct}%` }}></div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
          
          <div className="col-6 col-md-3">
            <div className="card p-3 text-center h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-star me-1"></i>Score Médio de Interesse</h6>
              <div className="display-3 fw-bold text-warning flex-grow-1 d-flex align-items-center justify-content-center">
                {avgScore}
              </div>
              <div className="text-muted small mt-2">de 10</div>
            </div>
          </div>
          
          <div className="col-6 col-md-3">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-trophy me-1"></i>Top 5 por Interesse</h6>
              <div>
                {top5.length === 0 ? (
                  <p className="text-muted small">Nenhuma empresa com score.</p>
                ) : (
                  top5.map((c, i) => (
                    <div key={c.id} className="d-flex justify-content-between align-items-center mb-1 small">
                      <span className="text-truncate top5-name" style={{maxWidth: '120px'}} title={c.name}>
                        <span className="text-muted me-1">{i + 1}.</span>
                        {esc(c.name)}
                      </span>
                      <span className="badge bg-warning text-dark flex-shrink-0">{c.interest_score}/10</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  )
}
