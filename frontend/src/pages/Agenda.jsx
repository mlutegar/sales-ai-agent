import React from 'react'
import { api } from '../api.js'

export default function Agenda({ toast, loadStats }) {
  return (
    <div className="tab-container">
      <div id="tab-agenda" className="d-none">
  <div className="row g-3">
    <div className="col-md-4">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-calendar-plus me-1"></i>Novo Horário Disponível</h6>
        <div className="mb-2"><input className="form-control form-control-sm" type="datetime-local" id="slot-dt" /></div>
        <div className="mb-2">
          <select className="form-select form-select-sm" id="slot-dur">
            <option value="15">15 minutos</option>
            <option value="30">30 minutos</option>
            <option value="60">1 hora</option>
          </select>
        </div>
        <div className="mb-3"><input className="form-control form-control-sm" id="slot-link" placeholder="Link da reunião (Meet, Zoom...)" /></div>
        <button className="btn btn-success btn-sm w-100"><i className="bi bi-plus-circle me-1"></i>Adicionar Slot</button>
        <hr />
        <p className="small text-muted">
          <i className="bi bi-info-circle me-1"></i>
          Integração com Calendly/Google Calendar requer configuração de API externa — não implementada neste protótipo.
        </p>
      </div>
    </div>
    <div className="col-md-8">
      <div className="card p-3">
        <div className="d-flex justify-content-between mb-2">
          <h6 className="fw-bold mb-0">Slots de Agenda</h6>
          <button className="btn btn-outline-secondary btn-sm"><i className="bi bi-arrow-clockwise"></i></button>
        </div>
        <div id="slots-list"></div>
      </div>
    </div>
  </div>
</div>
    </div>
  )
}
