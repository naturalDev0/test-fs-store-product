import type { ReactNode } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './auth'
import type { Role } from './api'
import Storefront from './pages/Storefront'
import Login from './pages/Login'
import MyOrders from './pages/MyOrders'
import AdminProducts from './pages/AdminProducts'
import AdminOrders from './pages/AdminOrders'

/** Client-side guard for navigation only. The API enforces roles on every request. */
function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <p className="muted">Loading…</p>
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== role) return <p className="notice error">You don't have access to this page.</p>
  return children
}

export default function App() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            Product Store
          </Link>
          <nav>
            {user?.role === 'admin' ? (
              <>
                <NavLink to="/admin/products">Inventory</NavLink>
                <NavLink to="/admin/orders">Orders</NavLink>
                <NavLink to="/" end>
                  Storefront
                </NavLink>
              </>
            ) : (
              <>
                <NavLink to="/" end>
                  Shop
                </NavLink>
                {user && <NavLink to="/orders">My orders</NavLink>}
              </>
            )}
          </nav>
          <div className="session">
            {user ? (
              <>
                <span className="muted small">
                  {user.email}
                  {user.role === 'admin' && <span className="badge">admin</span>}
                </span>
                <button
                  className="link-button"
                  onClick={() => {
                    logout()
                    navigate('/')
                  }}
                >
                  Log out
                </button>
              </>
            ) : (
              <NavLink to="/login">Log in</NavLink>
            )}
          </div>
        </div>
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<Storefront />} />
          <Route path="/login" element={<Login />} />
          <Route
            path="/orders"
            element={
              <RequireRole role="customer">
                <MyOrders />
              </RequireRole>
            }
          />
          <Route
            path="/admin/products"
            element={
              <RequireRole role="admin">
                <AdminProducts />
              </RequireRole>
            }
          />
          <Route
            path="/admin/orders"
            element={
              <RequireRole role="admin">
                <AdminOrders />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}
