import React from 'react'

export default function LoadingButton({ loading, onClick, className, children, disabled, type = 'button' }) {
  return (
    <button
      type={type}
      className={className}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading ? (
        <><span className="spinner-border spinner-border-sm me-1" />Aguarde...</>
      ) : children}
    </button>
  )
}
