export type Role = 'admin' | 'customer'

export interface User {
  id: number
  email: string
  role: Role
}

export interface Product {
  id: number
  sku: string
  name: string
  description: string
  priceCents: number
  stock: number
  // Admin-only fields
  isActive?: boolean
  version?: number
}

export interface Order {
  id: number
  productId: number
  productName: string
  quantity: number
  unitPriceCents: number
  totalCents: number
  status: string
  createdAt: string
  userEmail?: string
}

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const TOKEN_KEY = 'token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const token = tokenStore.get()
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = data.error ?? {}
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? 'Request failed', err.details)
  }
  return data as T
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/login', { email, password }),
  register: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/register', { email, password }),
  me: () => request<{ user: User }>('GET', '/auth/me'),

  products: () => request<{ products: Product[] }>('GET', '/products'),
  buy: (productId: number, quantity: number, idempotencyKey: string) =>
    request<{ order: Order; replayed: boolean }>('POST', '/orders', { productId, quantity }, {
      'Idempotency-Key': idempotencyKey,
    }),
  myOrders: () => request<{ orders: Order[] }>('GET', '/orders/mine'),

  admin: {
    products: () => request<{ products: Product[] }>('GET', '/admin/products'),
    create: (p: { sku: string; name: string; description: string; priceCents: number; stock: number }) =>
      request<{ product: Product }>('POST', '/admin/products', p),
    update: (id: number, edit: { version: number; name?: string; description?: string; priceCents?: number; isActive?: boolean }) =>
      request<{ product: Product }>('PATCH', `/admin/products/${id}`, edit),
    adjustStock: (id: number, delta: number) =>
      request<{ product: Product }>('POST', `/admin/products/${id}/stock-adjustments`, { delta }),
    deactivate: (id: number) => request<void>('DELETE', `/admin/products/${id}`),
    orders: () => request<{ orders: Order[] }>('GET', '/admin/orders'),
  },
}

export const formatPrice = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

/** Parses "12.99" into 1299 cents without floating-point drift. */
export function parsePriceToCents(input: string): number | null {
  const match = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(input)
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}
