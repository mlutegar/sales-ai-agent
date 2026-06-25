import React from 'react'

export default function ToastContainer({ toasts, onRemove }) {
  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999 }}>
      {toasts.map(t => (
        <div key={t.id} className={`toast align-items-center text-bg-${t.type} border-0 show mb-2`}>
          <div className="d-flex">
            <div className="toast-body">{t.msg}</div>
            <button type="button" className="btn-close btn-close-white me-2 m-auto" onClick={() => onRemove(t.id)} />
          </div>
        </div>
      ))}
    </div>
  )
}
