import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, tokenStore, type User } from './api'

interface AuthState {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<User>
  register: (email: string, password: string) => Promise<User>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(() => Boolean(tokenStore.get()))

  // Restore the session on page load if a token is stored.
  useEffect(() => {
    if (!tokenStore.get()) return
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false))
  }, [])

  const accept = ({ token, user }: { token: string; user: User }) => {
    tokenStore.set(token)
    setUser(user)
    return user
  }

  const value: AuthState = {
    user,
    loading,
    login: async (email, password) => accept(await api.login(email, password)),
    register: async (email, password) => accept(await api.register(email, password)),
    logout: () => {
      tokenStore.clear()
      setUser(null)
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
