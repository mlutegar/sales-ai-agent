import React from 'react'
import { formatCurrency } from '../api.js'

export default function StatCards({ stats }) {
  if (!stats) return null
  const cards = [
    { id: 'total_companies',   label: 'Empresas',       color: 'text-primary',   value: stats.total_companies },
    { id: 'total_contacts',    label: 'Contatos',       color: 'text-info',      value: stats.total_contacts },
    { id: 'hot_leads',         label: 'Hot Leads',      color: 'text-danger',    value: stats.hot_leads },
    { id: 'meetings',          label: 'Reuniões',       color: 'text-success',   value: stats.meetings },
    { id: 'pending_review',    label: 'Aguard. Revisão',color: 'text-warning',   value: stats.pending_review },
    { id: 'avg_score',         label: 'Score Médio',    color: 'text-info',      value: stats.avg_score || '—' },
    { id: 'docs_count',        label: 'Docs RAG',       color: 'text-secondary', value: stats.docs_count },
    { id: 'pipeline_value',    label: 'Pipeline R$',    color: 'text-success',   value: formatCurrency(stats.pipeline_value) },
    { id: 'enriched_contacts', label: 'Com E-mail',     color: '',               style: { color: '#7c6af7' },
      value: `${stats.enriched_contacts || 0}/${stats.total_contacts || 0}` },
  ]
  return (
    <div className="container-fluid px-4">
      <div className="row g-3 mb-4">
        {cards.map(c => (
          <div key={c.id} className="col">
            <div className="card p-3 text-center" style={{ border: 'none', borderRadius: 12 }}>
              <div className={`display-6 fw-bold ${c.color}`} style={c.style}>{c.value ?? '—'}</div>
              <div className="text-muted small">{c.label}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
