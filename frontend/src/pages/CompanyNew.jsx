import { useNavigate } from 'react-router-dom';
import { AddForm } from './Companies.jsx';

// Página dedicada de cadastro de empresa + primeiro contato (rota /companies/new)
export default function CompanyNew({ toast, loadStats }) {
  const navigate = useNavigate();

  return (
    <div className="row g-3">
      <div className="col-12 col-lg-6 mx-auto">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h5 className="fw-bold mb-0">
            <i className="bi bi-building-add me-2"></i>Cadastro de Empresa
          </h5>
          <button className="btn btn-outline-secondary btn-sm" onClick={() => navigate('/companies')}>
            <i className="bi bi-arrow-left me-1"></i>Voltar
          </button>
        </div>
        <AddForm
          toast={toast}
          onAdded={() => { if (loadStats) loadStats(); navigate('/companies'); }}
        />
      </div>
    </div>
  );
}
