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

export interface OrderItem {
  productId: number
  productName: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
}

export interface Order {
  id: number
  userEmail: string
  status: string
  totalCents: number
  /** The currency the order was placed in, which may differ from today's store currency. */
  currency: string
  createdAt: string
  items: OrderItem[]
}

export interface StoreConfig {
  currency: string
  locale: string
}

export interface CartLine {
  productId: number
  quantity: number
}

export interface StockMovement {
  id: number
  delta: number
  reason: 'opening_balance' | 'purchase' | 'restock' | 'write_off'
  stockAfter: number
  orderId: number | null
  actorEmail: string | null
  note: string
  createdAt: string
}

export interface Reconciliation {
  balanced: boolean
  productsChecked: number
  mismatches: { productId: number; sku: string; stock: number; ledgerStock: number }[]
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
  config: () => request<StoreConfig>('GET', '/config'),

  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/login', { email, password }),
  register: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/register', { email, password }),
  me: () => request<{ user: User }>('GET', '/auth/me'),

  products: () => request<{ products: Product[] }>('GET', '/products'),
  checkout: (items: CartLine[], idempotencyKey: string) =>
    request<{ order: Order; replayed: boolean }>('POST', '/orders', { items }, {
      'Idempotency-Key': idempotencyKey,
    }),
  myOrders: () => request<{ orders: Order[] }>('GET', '/orders/mine'),

  admin: {
    products: () => request<{ products: Product[] }>('GET', '/admin/products'),
    create: (p: { sku: string; name: string; description: string; priceCents: number; stock: number }) =>
      request<{ product: Product }>('POST', '/admin/products', p),
    update: (id: number, edit: { version: number; name?: string; description?: string; priceCents?: number; isActive?: boolean }) =>
      request<{ product: Product }>('PATCH', `/admin/products/${id}`, edit),
    adjustStock: (id: number, delta: number, note: string) =>
      request<{ product: Product }>('POST', `/admin/products/${id}/stock-adjustments`, { delta, note }),
    deactivate: (id: number) => request<void>('DELETE', `/admin/products/${id}`),
    orders: () => request<{ orders: Order[] }>('GET', '/admin/orders'),
    movements: (id: number) => request<{ movements: StockMovement[] }>('GET', `/admin/products/${id}/stock-movements`),
    reconciliation: () => request<Reconciliation>('GET', '/admin/inventory/reconciliation'),
  },
}

// Loaded from the API once, before the app renders (see main.tsx).
let store: StoreConfig | undefined

export async function loadStoreConfig() {
  store = await api.config()
}

/** The currency product prices are in. */
export const storeCurrency = () => store!.currency

// The currency decides the symbol; the locale only decides language and
// number format. Intl lets the locale pick the symbol ("$" means SGD in en-SG
// but USD in en-US), so each currency gets one fixed, unambiguous symbol.
const CURRENCY_SYMBOLS: Record<string, string> = { SGD: 'S$', USD: 'US$' }

/**
 * Formats an amount in cents, e.g. "S$12.99". Product prices use the store
 * currency; an order passes its own, because it keeps the currency it was
 * placed in. Unknown currencies fall back to their ISO code ("EUR 12.99").
 */
export function formatPrice(cents: number, currency = storeCurrency()) {
  const symbol = CURRENCY_SYMBOLS[currency]
  // "narrowSymbol" lays the amount out the way the locale places a symbol
  // ("$12.99" in English); we then swap in our own symbol.
  return new Intl.NumberFormat(store!.locale, {
    style: 'currency',
    currency,
    currencyDisplay: symbol ? 'narrowSymbol' : 'code',
  })
    .formatToParts(cents / 100)
    .map((p) => (p.type === 'currency' && symbol ? symbol : p.value))
    .join('')
}

/** Sums order totals per currency, e.g. "S$120.00 + US$46.80". Different currencies are never added together. */
export function formatTotals(orders: Order[]) {
  const totals = new Map<string, number>()
  for (const o of orders) totals.set(o.currency, (totals.get(o.currency) ?? 0) + o.totalCents)
  return [...totals].map(([currency, cents]) => formatPrice(cents, currency)).join(' + ')
}

/** Parses "12.99" into 1299 cents without floating-point drift. */
export function parsePriceToCents(input: string): number | null {
  const match = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(input)
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}
