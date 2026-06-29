import React from 'react'
import { useAuth } from '../context/AuthContext.jsx'

export default function Navbar({ activeTab, onTabChange, pendingReview }) {
  const { user } = useAuth()

  const tabs = [
    { key: 'companies',     icon: 'bi-building',          label: 'Empresas' },
    { key: 'followup',      icon: 'bi-clock-history',     label: 'Follow-ups' },
    { key: 'opportunities', icon: 'bi-funnel',             label: 'Oportunidades' },
    { key: 'dashboard',     icon: 'bi-bar-chart-line',    label: 'Dashboard' },
    { key: 'rlhf',          icon: 'bi-stars',              label: 'RLHF / Curadoria', badge: pendingReview },
    { key: 'rag',           icon: 'bi-file-earmark-text', label: 'RAG / Docs' },
    { key: 'golden',        icon: 'bi-trophy',             label: 'Casos de Ouro' },
    { key: 'agenda',        icon: 'bi-calendar-check',    label: 'Agenda' },
    { key: 'lgpd',          icon: 'bi-shield-lock',       label: 'LGPD' },
    { key: 'metrics',       icon: 'bi-graph-up-arrow',    label: 'Métricas' },
  ]

  return (
    <>
      <nav className="navbar navbar-dark px-3 py-2 mb-4" style={{ background: '#1a1d23' }}>
        <span className="navbar-brand fw-bold" style={{ color: '#7c6af7' }}>
          <i className="bi bi-robot me-2" />Sales AI Agent
        </span>
        <div className="d-flex align-items-center gap-3">
          <span className="text-light small">
            <i className="bi bi-person-circle me-1" />{user?.name || user?.username || '—'}
          </span>
          <a href="/logout" className="btn btn-outline-secondary btn-sm">
            <i className="bi bi-box-arrow-right me-1" />Sair
          </a>
        </div>
      </nav>
      <div className="container-fluid px-4">
        <ul className="nav nav-tabs mb-3">
          {tabs.map(t => (
            <li key={t.key} className="nav-item">
              <a
                className={`nav-link ${activeTab === t.key ? 'active' : ''}`}
                href="#"
                onClick={e => { e.preventDefault(); onTabChange(t.key) }}
              >
                <i className={`bi ${t.icon} me-1`} />
                {t.label}
                {t.badge > 0 && (
                  <span className="badge bg-danger rounded-pill ms-1" style={{ fontSize: 10 }}>{t.badge}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
