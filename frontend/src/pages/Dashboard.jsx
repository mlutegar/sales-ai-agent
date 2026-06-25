import React from 'react'
import { api } from '../api.js'

export default function Dashboard({ toast, loadStats }) {
  return (
    <div className="tab-container">
      <div id="tab-dashboard" className="d-none">
  <div className="row g-3">
    {/*  Funil de status  */}
    <div className="col-12">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-filter me-1"></i>Funil de Status</h6>
        <div className="d-flex gap-2 flex-wrap" id="dashboard-funnel"></div>
      </div>
    </div>
    <div className="col-md-6">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-pie-chart me-1"></i>Distribuição por Setor</h6>
        <div id="dashboard-sectors"></div>
      </div>
    </div>
    <div className="col-md-3">
      <div className="card p-3 text-center">
        <h6 className="fw-bold mb-3"><i className="bi bi-star me-1"></i>Score Médio de Interesse</h6>
        <div className="display-3 fw-bold text-warning" id="dashboard-avg-score">—</div>
        <div className="text-muted small">de 10</div>
      </div>
    </div>
    <div className="col-md-3">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-trophy me-1"></i>Top 5 por Interesse</h6>
        <div id="dashboard-top5"></div>
      </div>
    </div>
  </div>
</div>
    </div>
  )
}
