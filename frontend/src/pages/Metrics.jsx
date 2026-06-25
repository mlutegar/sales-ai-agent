import React from 'react'
import { api } from '../api.js'

export default function Metrics({ toast, loadStats }) {
  return (
    <div className="tab-container">
      <div id="tab-metrics" className="d-none">
  {/*  Empty state global enquanto não há dados  */}
  <div id="metrics-empty-state" className="text-center py-5 mb-3">
    <div>📊</div>
    <h6 className="fw-semibold mt-2">Sem dados de métricas ainda</h6>
    <p className="text-muted small">Gere sequências de mensagens e marque algumas como enviadas para começar a ver as estatísticas de performance aqui.</p>
    <button className="btn btn-sm btn-outline-primary">
      <i className="bi bi-arrow-left me-1"></i>Ir para Empresas
    </button>
  </div>
  <div className="row g-3 mb-3">
    {/*  Taxa de resposta por canal  */}
    <div className="col-md-6">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-bar-chart me-1"></i>Taxa de Resposta por Canal</h6>
        <canvas id="chart-channel" height="200"></canvas>
        <div id="chart-channel-empty" className="text-muted small text-center mt-2 d-none">Envie mensagens para gerar dados.</div>
      </div>
    </div>
    {/*  Distribuicao por Cargo  */}
    <div className="col-md-3">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-people me-1"></i>Leads por Cargo</h6>
        <canvas id="chart-role" height="220"></canvas>
      </div>
    </div>
    {/*  A/B Testing resultados  */}
    <div className="col-md-3">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-shuffle me-1"></i>A/B Testing</h6>
        <div id="ab-stats-panel"><p className="text-muted small">Nenhum teste realizado ainda.</p></div>
      </div>
    </div>
  </div>
  <div className="row g-3 mb-3">
    {/*  Funil de conversao  */}
    <div className="col-md-5">
      <div className="card p-3">
        <h6 className="fw-bold mb-3"><i className="bi bi-filter me-1"></i>Funil de Conversao</h6>
        <canvas id="chart-funnel" height="200"></canvas>
      </div>
    </div>
    {/*  Timing heatmap  */}
    <div className="col-md-7">
      <div className="card p-3">
        <h6 className="fw-bold mb-2"><i className="bi bi-clock me-1"></i>Melhores Horarios de Envio</h6>
        <p className="text-muted small mb-2">Taxa de resposta por dia da semana e hora (mais escuro = melhor)</p>
        <div id="timing-heatmap"><p className="text-muted small">Envie mensagens para gerar dados de timing.</p></div>
      </div>
    </div>
  </div>
  {/*  Follow-ups pendentes  */}
  <div className="card p-3">
    <div className="d-flex justify-content-between align-items-center mb-3">
      <h6 className="fw-bold mb-0"><i className="bi bi-clock-history me-1 text-warning"></i>Follow-ups Pendentes</h6>
      <div className="d-flex gap-2">
        <select className="form-select form-select-sm" id="followup-days">
          <option value="3">3+ dias sem resposta</option>
          <option value="5" selected>5+ dias sem resposta</option>
          <option value="7">7+ dias sem resposta</option>
          <option value="14">14+ dias sem resposta</option>
        </select>
        <button className="btn btn-outline-secondary btn-sm"><i className="bi bi-arrow-clockwise"></i></button>
      </div>
    </div>
    <div id="followup-list"><p className="text-muted small">Carregando...</p></div>
  </div>
</div>
    </div>
  )
}
