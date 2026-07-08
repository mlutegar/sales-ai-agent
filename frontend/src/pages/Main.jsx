import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import Sidebar from '../components/Sidebar.jsx'
import StatCards from '../components/StatCards.jsx'
import Companies from './Companies.jsx'
import CompanyNew from './CompanyNew.jsx'
import Opportunities from './Opportunities.jsx'
import Dashboard from './Dashboard.jsx'
import RLHF from './RLHF.jsx'
import RAG from './RAG.jsx'
import GoldenCases from './GoldenCases.jsx'
import Agenda from './Agenda.jsx'
import LGPD from './LGPD.jsx'
import Metrics from './Metrics.jsx'
import FollowUps from './FollowUps.jsx'
import Notifications from './Notifications.jsx'
import WhatsAppInbox from './WhatsAppInbox.jsx'
import { api } from '../api.js'

export default function Main({ toast }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [stats, setStats] = useState(null)

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      localStorage.setItem('sidebarCollapsed', next ? '1' : '0')
      return next
    })
  }, [])
  const [unreadNotifications, setUnreadNotifications] = useState(0)
  const pollRef = useRef(null)

  const [dataVersion, setDataVersion] = useState(0)
  const refreshData = useCallback(() => setDataVersion((v) => v + 1), [])

  const loadStats = useCallback(async () => {
    try {
      const s = await api('/api/stats')
      setStats(s)
    } catch {}
  }, [])

  // Polling de notificações a cada 30s
  const pollNotifications = useCallback(async () => {
    try {
      const res  = await fetch('/api/notifications')
      const data = await res.json()
      const prev = unreadNotifications
      const next = data.unread || 0
      setUnreadNotifications(next)
      // Se apareceu notificação nova e o usuário não está na página de notificações, toca um alerta visual
      if (next > prev && location.pathname !== '/notifications') {
        toast(`🔔 ${next > prev ? next - prev : next} nova${next - prev !== 1 ? 's' : ''} notificação${next - prev !== 1 ? 'ões' : ''}`, 'info')
      }
    } catch {}
  }, [unreadNotifications, location.pathname, toast])

  useEffect(() => { loadStats() }, [loadStats])

  useEffect(() => {
    pollNotifications()
    pollRef.current = setInterval(pollNotifications, 30_000)
    return () => clearInterval(pollRef.current)
  }, []) // eslint-disable-line

  const sharedProps = { toast, loadStats, dataVersion, refreshData }

  return (
    <div className="app-shell" style={{ fontSize: '.93rem' }}>
      <Sidebar
        pendingReview={stats?.pending_review || 0}
        unreadNotifications={unreadNotifications}
        collapsed={collapsed}
        onToggle={toggleSidebar}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className={`app-main${collapsed ? ' collapsed' : ''}`}>
        <div className="mobile-topbar">
          <button onClick={() => setMobileOpen(true)} title="Menu"><i className="bi bi-list" /></button>
          <span className="mobile-brand"><i className="bi bi-robot me-2" />Sales AI Agent</span>
        </div>
        <StatCards stats={stats} />
        <div className="container-fluid px-4 pb-5">
          <Routes>
            <Route index element={<Navigate to="/companies" replace />} />
            <Route path="/companies/new" element={<CompanyNew     {...sharedProps} />} />
            <Route path="/companies"     element={<Companies     {...sharedProps} onOpenWhatsApp={(companyId, contactId) => navigate('/whatsapp', { state: { companyId, contactId } })} />} />
            <Route path="/whatsapp"      element={<WhatsAppInbox toast={toast} initialCompanyId={location.state?.companyId ?? null} initialContactId={location.state?.contactId ?? null} onEditMessage={(messageId) => navigate('/rlhf', { state: { messageId } })} />} />
            <Route path="/notifications" element={<Notifications toast={toast} onUnreadChange={setUnreadNotifications} />} />
            <Route path="/followup"      element={<FollowUps      {...sharedProps} />} />
            <Route path="/opportunities" element={<Opportunities  {...sharedProps} />} />
            <Route path="/dashboard"     element={<Dashboard      {...sharedProps} />} />
            <Route path="/rlhf"          element={<RLHF           {...sharedProps} initialMessageId={location.state?.messageId ?? null} />} />
            <Route path="/rag"           element={<RAG            {...sharedProps} />} />
            <Route path="/golden"        element={<GoldenCases    {...sharedProps} />} />
            <Route path="/agenda"        element={<Agenda         {...sharedProps} />} />
            <Route path="/lgpd"          element={<LGPD           {...sharedProps} />} />
            <Route path="/metrics"       element={<Metrics        {...sharedProps} />} />
            <Route path="*" element={<Navigate to="/companies" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
