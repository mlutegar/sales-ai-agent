import React, { useState, useEffect, useRef } from 'react'
import { api } from '../api.js'

export default function Metrics({ toast }) {
  const [overview, setOverview] = useState(null)
  const [timing, setTiming] = useState([])
  const [loading, setLoading] = useState(false)

  const chartChannelRef = useRef(null)
  const chartRoleRef = useRef(null)
  const chartFunnelRef = useRef(null)
  
  const chartInstances = useRef({ channel: null, role: null, funnel: null })

  const loadMetrics = async () => {
    setLoading(true)
    try {
      const [ov, tm] = await Promise.all([
        api('/api/metrics/overview').catch(() => null),
        api('/api/metrics/timing').catch(() => null),
      ])
      setOverview(ov)
      setTiming(tm || [])
    } catch (e) {
      toast('Erro ao carregar métricas', 'danger')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMetrics()
    return () => {
      // Cleanup charts
      Object.values(chartInstances.current).forEach(chart => {
        if (chart) chart.destroy()
      })
    }
  }, [])

  useEffect(() => {
    if (!overview || !window.Chart) return

    const Chart = window.Chart

    // Cleanup previous instances
    Object.values(chartInstances.current).forEach(chart => {
      if (chart) chart.destroy()
    })

    // Chart Channel
    if (chartChannelRef.current && overview.by_channel && overview.by_channel.length > 0) {
      const labels = overview.by_channel.map(r => r.channel || 'N/A')
      const rates = overview.by_channel.map(r => r.response_rate || 0)
      const sent = overview.by_channel.map(r => r.sent || 0)
      
      chartInstances.current.channel = new Chart(chartChannelRef.current, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Taxa de Resposta (%)', data: rates, backgroundColor: ['#0077b5','#ea4335','#25d366'], yAxisID: 'y' },
            { label: 'Msgs Enviadas', data: sent, backgroundColor: '#e9ecef', yAxisID: 'y2', type: 'line', borderColor: '#6c757d', fill: false }
          ]
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'bottom' } },
          scales: {
            y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } },
            y2: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } }
          }
        }
      })
    }

    // Chart Role
    if (chartRoleRef.current && overview.by_role) {
      const roleMap = { c_level: 'C-Level', manager: 'Gerente', engineer: 'Engenheiro', other: 'Outro' }
      const labels = overview.by_role.map(r => roleMap[r.role] || r.role)
      const data = overview.by_role.map(r => r.total || 0)
      
      chartInstances.current.role = new Chart(chartRoleRef.current, {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: ['#7c6af7','#0dcaf0','#198754','#ffc107'] }] },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
      })
    }

    // Chart Funnel
    if (chartFunnelRef.current && overview.funnel) {
      const STATUS_L = {
        new: 'Novo', researched: 'Pesquisado', sequence_created: 'Sequencia criada',
        contacted: 'Contactado', needs_followup: 'Follow-up', hot_lead: 'Hot Lead',
        rejected: 'Rejeitado', meeting_set: 'Reuniao', opted_out: 'Opt-out'
      }
      const labels = overview.funnel.map(r => STATUS_L[r.status] || r.status)
      const data = overview.funnel.map(r => r.total || 0)
      
      chartInstances.current.funnel = new Chart(chartFunnelRef.current, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Leads', data, backgroundColor: '#7c6af7' }] },
        options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
      })
    }

  }, [overview])

  const totalSent = overview?.by_channel?.reduce((sum, r) => sum + (r.sent || 0), 0) || 0

  const renderTimingHeatmap = () => {
    if (timing.length === 0) return <p className="text-muted small">Envie mensagens para gerar dados de timing.</p>
    
    const byChannel = {}
    timing.forEach(r => {
      if (!byChannel[r.channel]) byChannel[r.channel] = {}
      byChannel[r.channel][`${r.day_of_week}_${r.hour_of_day}`] = r.response_rate || 0
    })

    const days = ['Seg','Ter','Qua','Qui','Sex','Sab','Dom']
    
    return Object.keys(byChannel).map(ch => {
      const data = byChannel[ch]
      const vals = Object.values(data)
      const maxRate = Math.max(1, ...vals)
      
      return (
        <div key={ch} className="mb-3">
          <strong className="small">{ch.toUpperCase()}</strong>
          <div style={{overflowX: 'auto'}}>
            <table className="table table-bordered table-sm" style={{fontSize: '.7rem', minWidth: '600px'}}>
              <thead>
                <tr>
                  <th style={{width: '40px'}}>Dia</th>
                  {Array.from({length: 13}).map((_, i) => (
                    <th key={i} className="text-center">{i + 8}h</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((day, di) => (
                  <tr key={di}>
                    <td><strong>{day}</strong></td>
                    {Array.from({length: 13}).map((_, hrIdx) => {
                      const hr = hrIdx + 8
                      const rate = data[`${di}_${hr}`] || 0
                      const alpha = rate > 0 ? Math.max(0.15, rate / maxRate) : 0
                      const bg = rate > 0 ? `rgba(124,106,247,${alpha.toFixed(2)})` : '#f8f9fa'
                      const tc = rate > 50 ? '#fff' : 'inherit'
                      
                      return (
                        <td key={hr} className="text-center" style={{background: bg, color: tc}}>
                          {rate > 0 ? `${rate.toFixed(0)}%` : '-'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    })
  }

  if (loading) {
    return (
      <div className="tab-container">
        <div id="tab-metrics">
          <p className="text-muted text-center py-5">Carregando métricas...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-container">
      <div id="tab-metrics">
        
        {totalSent === 0 && (
          <div id="metrics-empty-state" className="text-center py-5 mb-3">
            <div style={{fontSize: '2.5rem'}}>📊</div>
            <h6 className="fw-semibold mt-2">Sem dados de métricas ainda</h6>
            <p className="text-muted small">Gere sequências de mensagens e marque algumas como enviadas para começar a ver as estatísticas de performance aqui.</p>
          </div>
        )}

        <div className={`row g-3 mb-3 ${totalSent === 0 ? 'opacity-50' : ''}`}>
          <div className="col-12 col-md-6">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-bar-chart me-1"></i>Taxa de Resposta por Canal</h6>
              {(!overview?.by_channel || overview.by_channel.length === 0) ? (
                <div className="text-muted small text-center mt-2">Envie mensagens para gerar dados.</div>
              ) : (
                <canvas ref={chartChannelRef} height="200"></canvas>
              )}
            </div>
          </div>
          
          <div className="col-6 col-md-3">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-people me-1"></i>Leads por Cargo</h6>
              <canvas ref={chartRoleRef} height="220"></canvas>
            </div>
          </div>
          
          <div className="col-6 col-md-3">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-shuffle me-1"></i>A/B Testing</h6>
              <div>
                {overview?.ab_stats?.decided > 0 ? (
                  <>
                    <div className="text-center mb-2">
                      <div className="display-6 fw-bold" style={{color: '#7c6af7'}}>
                        {((overview.ab_stats.b_won / overview.ab_stats.decided) * 100).toFixed(0)}%
                      </div>
                      <div className="text-muted small">variante B venceu</div>
                    </div>
                    <div className="small">
                      <div className="d-flex justify-content-between">
                        <span>Testes realizados</span><strong>{overview.ab_stats.decided}</strong>
                      </div>
                      <div className="d-flex justify-content-between">
                        <span>Variante B venceu</span><strong>{overview.ab_stats.b_won}</strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-muted small">Nenhum teste realizado ainda.</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className={`row g-3 mb-3 ${totalSent === 0 ? 'opacity-50' : ''}`}>
          <div className="col-12 col-md-5">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-filter me-1"></i>Funil de Conversão</h6>
              <canvas ref={chartFunnelRef} height="200"></canvas>
            </div>
          </div>
          
          <div className="col-12 col-md-7">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-2"><i className="bi bi-clock me-1"></i>Melhores Horários de Envio</h6>
              <p className="text-muted small mb-2">Taxa de resposta por dia da semana e hora (mais escuro = melhor)</p>
              <div>{renderTimingHeatmap()}</div>
            </div>
          </div>
        </div>
        
      </div>
    </div>
  )
}
