import React from 'react'
import { api } from '../api.js'

export default function GoldenCases({ toast, loadStats }) {
  return (
    <div className="tab-container">
      <div id="tab-golden" className="d-none">
  <div className="row g-3">
    <div className="col-md-4">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-trophy me-1"></i>Novo Caso de Ouro</h6>
        <div className="mb-2"><input className="form-control form-control-sm" id="gc-title" placeholder="Título *" /></div>
        <div className="mb-2"><input className="form-control form-control-sm" id="gc-context" placeholder="Contexto (setor, cargo, produto)" /></div>
        <div className="mb-2"><textarea className="form-control form-control-sm" id="gc-content" rows="6" placeholder="Conversa ou mensagem que gerou resultado real..."></textarea></div>
        <div className="mb-3">
          <label className="small fw-bold">Score de sucesso</label>
          <div className="d-flex gap-2 mt-1" id="gc-score-btns">
            <button className="btn btn-outline-warning btn-sm score-btn" data-score="3">3★</button>
            <button className="btn btn-outline-warning btn-sm score-btn" data-score="4">4★</button>
            <button className="btn btn-warning btn-sm score-btn active" data-score="5">5★</button>
          </div>
        </div>
        <button className="btn btn-warning btn-sm w-100"><i className="bi bi-star-fill me-1"></i>Salvar Caso</button>
      </div>
    </div>
    <div className="col-md-8">
      <div className="card p-3">
        <div className="d-flex justify-content-between mb-2">
          <h6 className="fw-bold mb-0">Biblioteca de Casos de Ouro</h6>
          <button className="btn btn-outline-secondary btn-sm"><i className="bi bi-arrow-clockwise"></i></button>
        </div>
        <div id="golden-list"></div>
      </div>
    </div>
  </div>
</div>
    </div>
  )
}
