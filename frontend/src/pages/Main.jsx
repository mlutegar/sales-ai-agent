import React, { useState, useEffect, useCallback } from 'react'
import Navbar from '../components/Navbar.jsx'
import StatCards from '../components/StatCards.jsx'
import Companies from './Companies.jsx'
import Opportunities from './Opportunities.jsx'
import Dashboard from './Dashboard.jsx'
import RLHF from './RLHF.jsx'
import RAG from './RAG.jsx'
import GoldenCases from './GoldenCases.jsx'
import Agenda from './Agenda.jsx'
import LGPD from './LGPD.jsx'
import Metrics from './Metrics.jsx'
import FollowUps from './FollowUps.jsx'
import { api } from '../api.js'

export default function Main({ toast }) {
  const [tab, setTab] = useState('companies')
  const [stats, setStats] = useState(null)

  const loadStats = useCallback(async () => {
    try {
      const s = await api('/api/stats')
      setStats(s)
    } catch {}
  }, [])

  useEffect(() => { loadStats() }, [loadStats])

  const sharedProps = { toast, loadStats }

  return (
    <div style={{ background: '#f5f7fa', minHeight: '100vh', fontSize: '.93rem' }}>
      <Navbar activeTab={tab} onTabChange={setTab} pendingReview={stats?.pending_review || 0} />
      <StatCards stats={stats} />
      <div className="container-fluid px-4 pb-5">
        {tab === 'companies'     && <Companies     {...sharedProps} />}
        {tab === 'followup'      && <FollowUps      {...sharedProps} />}
        {tab === 'opportunities' && <Opportunities  {...sharedProps} />}
        {tab === 'dashboard'     && <Dashboard      {...sharedProps} />}
        {tab === 'rlhf'          && <RLHF           {...sharedProps} />}
        {tab === 'rag'           && <RAG            {...sharedProps} />}
        {tab === 'golden'        && <GoldenCases    {...sharedProps} />}
        {tab === 'agenda'        && <Agenda         {...sharedProps} />}
        {tab === 'lgpd'          && <LGPD           {...sharedProps} />}
        {tab === 'metrics'       && <Metrics        {...sharedProps} />}
      </div>
    </div>
  )
}
