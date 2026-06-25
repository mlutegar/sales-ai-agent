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
    new: '#6c757d', researched: '#0dcaf0', sequence_created: '#0d6efd',
    contacted: '#0d6efd', hot_lead: '#dc3545', meeting_set: '#198754',
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
              <div className="d-flex gap-2 flex-wrap align-items-center">
                {statusOrder.map((s, idx) => {
                  const count = statusCounts[s] || 0
                  return (
                    <React.Fragment key={s}>
                      <div className="funnel-card" style={{ background: statusColors[s] || '#6c757d' }}>
                        <div className="funnel-num">{count}</div>
                        <div className="funnel-label">{STATUS_LABEL[s] || s}</div>
                      </div>
                      {idx < statusOrder.length - 1 && (
                        <div className="text-muted fs-4">→</div>
                      )}
                    </React.Fragment>
                  )
                })}
              </div>
            </div>
          </div>
          
          <div className="col-md-6">
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
          
          <div className="col-md-3">
            <div className="card p-3 text-center h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-star me-1"></i>Score Médio de Interesse</h6>
              <div className="display-3 fw-bold text-warning flex-grow-1 d-flex align-items-center justify-content-center">
                {avgScore}
              </div>
              <div className="text-muted small mt-2">de 10</div>
            </div>
          </div>
          
          <div className="col-md-3">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-trophy me-1"></i>Top 5 por Interesse</h6>
              <div>
                {top5.length === 0 ? (
                  <p className="text-muted small">Nenhuma empresa com score.</p>
                ) : (
                  top5.map((c, i) => (
                    <div key={c.id} className="d-flex justify-content-between align-items-center mb-1 small">
                      <span className="text-truncate" style={{maxWidth: '120px'}} title={c.name}>
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
