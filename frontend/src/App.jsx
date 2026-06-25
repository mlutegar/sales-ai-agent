import React, { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { useToast } from './hooks/useToast.js'
import ToastContainer from './components/ToastContainer.jsx'

const Login = lazy(() => import('./pages/Login.jsx'))
const Main = lazy(() => import('./pages/Main.jsx'))

function PrivateRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="d-flex justify-content-center align-items-center" style={{height:'100vh'}}><div className="spinner-border text-primary"></div></div>
  return user ? children : <Navigate to="/login" replace />
}

function AppRoutes() {
  const { toasts, toast, removeToast } = useToast()
  return (
    <>
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Suspense fallback={<div className="d-flex justify-content-center align-items-center" style={{height:'100vh'}}><div className="spinner-border text-primary"></div></div>}>
        <Routes>
          <Route path="/login" element={<Login toast={toast} />} />
          <Route path="/*" element={<PrivateRoute><Main toast={toast} /></PrivateRoute>} />
        </Routes>
      </Suspense>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
