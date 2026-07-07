import React from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

export const TABS = [
  { key: 'companies',      path: '/companies',     icon: 'bi-building',          label: 'Empresas' },
  { key: 'whatsapp',       path: '/whatsapp',      icon: 'bi-whatsapp',          label: 'WhatsApp' },
  { key: 'notifications',  path: '/notifications', icon: 'bi-bell-fill',         label: 'Notificações', badgeKey: 'notifications' },
  { key: 'followup',       path: '/followup',      icon: 'bi-clock-history',     label: 'Follow-ups' },
  { key: 'opportunities',  path: '/opportunities', icon: 'bi-funnel',            label: 'Oportunidades' },
  { key: 'dashboard',      path: '/dashboard',     icon: 'bi-bar-chart-line',    label: 'Dashboard' },
  { key: 'rlhf',           path: '/rlhf',          icon: 'bi-stars',             label: 'RLHF / Curadoria', badgeKey: 'rlhf' },
  { key: 'rag',            path: '/rag',           icon: 'bi-file-earmark-text', label: 'RAG / Docs' },
  { key: 'golden',         path: '/golden',        icon: 'bi-trophy',            label: 'Casos de Ouro' },
  { key: 'agenda',         path: '/agenda',        icon: 'bi-calendar-check',    label: 'Agenda' },
  { key: 'lgpd',           path: '/lgpd',          icon: 'bi-shield-lock',       label: 'LGPD' },
  { key: 'metrics',        path: '/metrics',       icon: 'bi-graph-up-arrow',    label: 'Métricas' },
]

export default function Sidebar({
  pendingReview = 0,
  unreadNotifications = 0,
  collapsed,
  onToggle,
  mobileOpen,
  onCloseMobile,
}) {
  const { user } = useAuth()

  const badgeFor = (t) => {
    if (t.badgeKey === 'notifications') return unreadNotifications
    if (t.badgeKey === 'rlhf') return pendingReview
    return 0
  }

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <aside className={`app-sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}>
        <div className="sidebar-header">
          <span className="sidebar-brand">
            <i className="bi bi-robot" />
            <span className="sidebar-label">Sales AI Agent</span>
          </span>
          <button className="sidebar-toggle" onClick={onToggle} title={collapsed ? 'Expandir' : 'Recolher'}>
            <i className={`bi ${collapsed ? 'bi-chevron-right' : 'bi-chevron-left'}`} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {TABS.map((t) => {
            const badge = badgeFor(t)
            return (
              <NavLink
                key={t.key}
                to={t.path}
                className={({ isActive }) => `sidebar-item${isActive ? ' active' : ''}`}
                title={collapsed ? t.label : undefined}
                onClick={() => onCloseMobile && onCloseMobile()}
              >
                <i className={`bi ${t.icon}`} />
                <span className="sidebar-label">{t.label}</span>
                {badge > 0 && <span className="sidebar-badge">{badge}</span>}
              </NavLink>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <span className="sidebar-user" title={user?.name || user?.username || '—'}>
            <i className="bi bi-person-circle" />
            <span className="sidebar-label">{user?.name || user?.username || '—'}</span>
          </span>
          <a href="/logout" className="sidebar-logout" title="Sair">
            <i className="bi bi-box-arrow-right" />
            <span className="sidebar-label">Sair</span>
          </a>
        </div>
      </aside>
    </>
  )
}
