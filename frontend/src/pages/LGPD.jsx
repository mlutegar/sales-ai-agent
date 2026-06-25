import React from 'react'
import { api } from '../api.js'

export default function LGPD({ toast, loadStats }) {
  return (
    <div className="tab-container">
      <div id="tab-lgpd" className="d-none">
  <div className="card p-3">
    <div className="d-flex justify-content-between mb-3">
      <h6 className="fw-bold mb-0"><i className="bi bi-shield-lock me-1"></i>Logs de Consentimento LGPD</h6>
      <button className="btn btn-outline-secondary btn-sm"><i className="bi bi-arrow-clockwise"></i></button>
    </div>
    <div className="table-responsive">
      <table className="table table-sm table-hover">
        <thead className="table-light"><tr><th>Data</th><th>Empresa</th><th>Contato</th><th>Ação</th><th>Detalhes</th></tr></thead>
        <tbody id="consent-tbody"></tbody>
      </table>
    </div>
  </div>
</div>
    </div>
  )
}
