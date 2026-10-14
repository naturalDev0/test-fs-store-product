import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, formatPrice, type Product } from '../api'
import { useAuth } from '../auth'

type Flash = { kind: 'success' | 'error'; text: string } | null

export default function Storefront() {
  const { user } = useAuth()
  const [products, setProducts] = useState<Product[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [pending, setPending] = useState<number | null>(null)
  const [flash, setFlash] = useState<Flash>(null)

  // One idempotency key per purchase attempt. If the network fails mid-request,
  // the key is kept, so clicking Buy again safely retries the SAME purchase
  // instead of risking a second order. It's discarded once we get an answer.
  const attemptKeys = useRef(new Map<number, string>())

  const load = useCallback(() => {
    api
      .products()
      .then(({ products }) => setProducts(products))
      .catch((e: Error) => setLoadError(e.message))
  }, [])

  useEffect(load, [load])

  async function buy(product: Product) {
    const quantity = quantities[product.id] ?? 1
    const key = attemptKeys.current.get(product.id) ?? crypto.randomUUID()
    attemptKeys.current.set(product.id, key)
    setPending(product.id)
    setFlash(null)
    try {
      const { order } = await api.buy(product.id, quantity, key)
      attemptKeys.current.delete(product.id)
      setFlash({ kind: 'success', text: `Order #${order.id} placed: ${order.quantity} × ${order.productName} for ${formatPrice(order.totalCents)}.` })
    } catch (e) {
      if (e instanceof ApiError) {
        attemptKeys.current.delete(product.id) // The server answered; this attempt is settled.
        if (e.code === 'INSUFFICIENT_STOCK') {
          const { available } = e.details as { available: number }
          setFlash({ kind: 'error', text: `Sorry, only ${available} left of ${product.name}. Someone may have just bought it.` })
        } else {
          setFlash({ kind: 'error', text: e.message })
        }
      } else {
        setFlash({ kind: 'error', text: 'Network problem. Click Buy again to retry safely; you will not be charged twice.' })
      }
    } finally {
      setPending(null)
      load() // Always show the latest stock after an attempt.
    }
  }

  if (loadError) return <p className="notice error">Couldn't load products: {loadError}</p>
  if (!products) return <p className="muted">Loading products…</p>

  return (
    <section>
      <div className="page-head">
        <h1>Shop</h1>
        {!user && (
          <p className="muted">
            <Link to="/login">Log in</Link> to buy.
          </p>
        )}
        {user?.role === 'admin' && <p className="muted">Admins can browse but not buy. Log in as a customer to purchase.</p>}
      </div>

      {flash && <p className={`notice ${flash.kind}`}>{flash.text}</p>}

      {products.length === 0 ? (
        <p className="muted">No products available yet.</p>
      ) : (
        <div className="grid">
          {products.map((p) => {
            const soldOut = p.stock === 0
            const qty = quantities[p.id] ?? 1
            return (
              <article key={p.id} className="card product">
                <div>
                  <h2>{p.name}</h2>
                  <p className="muted small">{p.sku}</p>
                  <p>{p.description}</p>
                </div>
                <div className="product-foot">
                  <div className="price-row">
                    <strong className="price">{formatPrice(p.priceCents)}</strong>
                    <span className={soldOut ? 'stock out' : p.stock <= 5 ? 'stock low' : 'stock'}>
                      {soldOut ? 'Sold out' : `${p.stock} in stock`}
                    </span>
                  </div>
                  {user?.role === 'customer' && (
                    <div className="buy-row">
                      <label className="sr-only" htmlFor={`qty-${p.id}`}>
                        Quantity
                      </label>
                      <input
                        id={`qty-${p.id}`}
                        type="number"
                        min={1}
                        max={Math.max(1, Math.min(p.stock, 100))}
                        value={qty}
                        disabled={soldOut}
                        onChange={(e) =>
                          setQuantities({ ...quantities, [p.id]: Math.max(1, Math.floor(Number(e.target.value) || 1)) })
                        }
                      />
                      <button onClick={() => buy(p)} disabled={soldOut || pending !== null}>
                        {pending === p.id ? 'Buying…' : 'Buy'}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
