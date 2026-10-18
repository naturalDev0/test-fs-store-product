import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, formatPrice, type CartLine, type Product } from '../api'
import { useAuth } from '../auth'

type Flash = { kind: 'success' | 'error'; text: string; lines?: string[] } | null

const CART_KEY = 'cart'
const MAX_CART_LINES = 20
const MAX_QTY = 100

// The cart survives a page refresh. Storage can be unavailable (private
// browsing, blocked cookies), so every access is guarded.
function loadCart(): CartLine[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
function saveCart(cart: CartLine[]) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart))
  } catch {
    /* ignore */
  }
}

export default function Storefront() {
  const { user } = useAuth()
  const [products, setProducts] = useState<Product[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cart, setCartState] = useState<CartLine[]>(loadCart)
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [checkingOut, setCheckingOut] = useState(false)
  const [flash, setFlash] = useState<Flash>(null)

  // One idempotency key per checkout attempt. If the network fails
  // mid-request, the key is kept, so pressing Checkout again safely retries
  // the SAME purchase instead of risking a second order. It's discarded when
  // the server answers, or when the cart changes (a different cart is a
  // different purchase and needs a new key).
  const attemptKey = useRef<string | null>(null)

  const setCart = (next: CartLine[]) => {
    attemptKey.current = null
    setCartState(next)
    saveCart(next)
  }

  const load = useCallback(() => {
    api
      .products()
      .then(({ products }) => setProducts(products))
      .catch((e: Error) => setLoadError(e.message))
  }, [])

  useEffect(load, [load])

  const byId = new Map((products ?? []).map((p) => [p.id, p]))
  const cartLines = cart.filter((l) => byId.has(l.productId))
  const cartTotal = cartLines.reduce((sum, l) => sum + byId.get(l.productId)!.priceCents * l.quantity, 0)
  const inCart = (id: number) => cart.find((l) => l.productId === id)?.quantity ?? 0

  function addToCart(p: Product) {
    const qty = quantities[p.id] ?? 1
    const existing = cart.find((l) => l.productId === p.id)
    if (!existing && cart.length >= MAX_CART_LINES) {
      setFlash({ kind: 'error', text: `A cart can hold at most ${MAX_CART_LINES} different products.` })
      return
    }
    const quantity = Math.min(MAX_QTY, (existing?.quantity ?? 0) + qty)
    setCart(existing ? cart.map((l) => (l.productId === p.id ? { ...l, quantity } : l)) : [...cart, { productId: p.id, quantity }])
    setFlash(null)
  }

  function setLineQuantity(productId: number, quantity: number) {
    if (quantity <= 0) return setCart(cart.filter((l) => l.productId !== productId))
    setCart(cart.map((l) => (l.productId === productId ? { ...l, quantity: Math.min(MAX_QTY, quantity) } : l)))
  }

  async function checkout() {
    attemptKey.current ??= crypto.randomUUID()
    setCheckingOut(true)
    setFlash(null)
    try {
      const { order } = await api.checkout(cartLines, attemptKey.current)
      attemptKey.current = null
      setCart([])
      setFlash({
        kind: 'success',
        text: `Order #${order.id} placed for ${formatPrice(order.totalCents)}.`,
        lines: order.items.map((i) => `${i.quantity} × ${i.productName}`),
      })
    } catch (e) {
      if (!(e instanceof ApiError)) {
        setFlash({ kind: 'error', text: 'Network problem. Press Checkout again to retry safely; you will not be charged twice.' })
        return
      }
      attemptKey.current = null // The server answered; this attempt is settled.
      if (e.code === 'INSUFFICIENT_STOCK') {
        const { items } = e.details as { items: { name: string; requested: number; available: number }[] }
        setFlash({
          kind: 'error',
          text: 'Nothing was charged: some items no longer have enough stock. Adjust your cart and try again.',
          lines: items.map((i) => `${i.name}: you asked for ${i.requested}, ${i.available} left`),
        })
      } else if (e.code === 'PRODUCT_UNAVAILABLE') {
        const { productIds } = e.details as { productIds: number[] }
        setCart(cart.filter((l) => !productIds.includes(l.productId)))
        setFlash({ kind: 'error', text: 'Some products are no longer available and were removed from your cart. Nothing was charged.' })
      } else {
        setFlash({ kind: 'error', text: e.message })
      }
    } finally {
      setCheckingOut(false)
      load() // Always show the latest stock after an attempt.
    }
  }

  if (loadError) return <p className="notice error">Couldn't load products: {loadError}</p>
  if (!products) return <p className="muted">Loading products…</p>

  const canBuy = user?.role === 'customer'

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


      <div className={canBuy ? 'shop-layout' : ''}>
        {products.length === 0 ? (
          <p className="muted">No products available yet.</p>
        ) : (
          <div className="grid">
            {products.map((p) => {
              const soldOut = p.stock === 0
              const qty = quantities[p.id] ?? 1
              const already = inCart(p.id)
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
                    {canBuy && (
                      <div className="buy-row">
                        <label className="sr-only" htmlFor={`qty-${p.id}`}>
                          Quantity
                        </label>
                        <input
                          id={`qty-${p.id}`}
                          type="number"
                          min={1}
                          max={MAX_QTY}
                          value={qty}
                          disabled={soldOut}
                          onChange={(e) =>
                            setQuantities({ ...quantities, [p.id]: Math.max(1, Math.floor(Number(e.target.value) || 1)) })
                          }
                        />
                        <button onClick={() => addToCart(p)} disabled={soldOut || checkingOut}>
                          {already ? `Add more (${already} in cart)` : 'Add to cart'}
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}

        {canBuy && (
          <aside className="card cart" aria-label="Cart">
            <h2>Cart</h2>
            {/* Messages live in the cart, which stays in view, so a result
                is never hidden above the fold after checking out. */}
            {flash && (
              <div className={`notice ${flash.kind}`} role="status">
                {flash.text}
                {flash.lines && (
                  <ul>
                    {flash.lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {cartLines.length === 0 ? (
              <p className="muted small">Your cart is empty.</p>
            ) : (
              <>
                <ul className="cart-lines">
                  {cartLines.map((l) => {
                    const p = byId.get(l.productId)!
                    const short = l.quantity > p.stock
                    return (
                      <li key={l.productId}>
                        <div>
                          <div>{p.name}</div>
                          <div className={short ? 'stock out small' : 'muted small'}>
                            {formatPrice(p.priceCents)} each{short && ` · only ${p.stock} left`}
                          </div>
                        </div>
                        <div className="cart-qty">
                          <input
                            aria-label={`Quantity of ${p.name}`}
                            type="number"
                            min={0}
                            max={MAX_QTY}
                            value={l.quantity}
                            disabled={checkingOut}
                            onChange={(e) => setLineQuantity(l.productId, Math.floor(Number(e.target.value) || 0))}
                          />
                          <button className="link-button" disabled={checkingOut} onClick={() => setLineQuantity(l.productId, 0)}>
                            Remove
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                <div className="cart-total">
                  <span>Total</span>
                  <strong>{formatPrice(cartTotal)}</strong>
                </div>
                <button className="checkout" onClick={checkout} disabled={checkingOut}>
                  {checkingOut ? 'Placing order…' : 'Checkout'}
                </button>
                <p className="muted small">Your whole cart is bought together, or not at all.</p>
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}
