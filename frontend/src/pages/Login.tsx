import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../api'
import { useAuth } from '../auth'

export default function Login() {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const user = mode === 'login' ? await login(email, password) : await register(email, password)
      navigate(user.role === 'admin' ? '/admin/products' : '/')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        const details = err.details as { message: string }[]
        setError(details.map((d) => d.message).join('. '))
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="auth">
      <form className="card" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Log in' : 'Create an account'}</h1>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="notice error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
        <button type="button" className="link-button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}
        </button>
        <p className="muted small hint">
          Demo accounts: <code>admin@example.com</code> / <code>Admin123!</code> and{' '}
          <code>customer@example.com</code> / <code>Customer123!</code>
        </p>
      </form>
    </section>
  )
}
