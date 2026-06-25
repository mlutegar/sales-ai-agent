import React from 'react'
import { api } from '../api.js'

export default function FollowUps({ toast, loadStats }) {
  return (
    <div className="tab-container">
      <div id="tab-followup" className="d-none">
  <div className="card p-3">
    <div className="d-flex justify-content-between align-items-center mb-3">
      <h6 className="fw-bold mb-0"><i className="bi bi-clock-history me-1 text-warning"></i>Follow-ups Pendentes</h6>
      <div className="d-flex gap-2 align-items-center">
        <select className="form-select form-select-sm" id="followup-days-filter">
          <option value="3">3+ dias sem contato</option>
          <option value="7" selected>7+ dias sem contato</option>
          <option value="14">14+ dias sem contato</option>
          <option value="30">30+ dias sem contato</option>
        </select>
        <button className="btn btn-outline-secondary btn-sm"><i className="bi bi-arrow-clockwise"></i></button>
      </div>
    </div>
    <div id="followup-list-tab" className="d-flex flex-column gap-0">
      <p className="text-muted small">Carregando...</p>
    </div>
  </div>
</div>
    </div>
  )
}
