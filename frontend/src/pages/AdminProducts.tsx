import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, formatPrice, parsePriceToCents, type Product, type Reconciliation, type StockMovement } from '../api'

type Flash = { kind: 'success' | 'error'; text: string } | null

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'VERSION_CONFLICT') return 'Someone else changed this product while you were editing. The latest version has been loaded; please re-apply your change.'
    if (e.code === 'VALIDATION_ERROR') return (e.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`).join('; ')
    return e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong'
}

export default function AdminProducts() {
  const [products, setProducts] = useState<Product[] | null>(null)
  const [recon, setRecon] = useState<Reconciliation | null>(null)
  const [flash, setFlash] = useState<Flash>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [historyId, setHistoryId] = useState<number | null>(null)
  // Bumped after every change, so an open stock history reloads.
  const [revision, setRevision] = useState(0)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    const [{ products }, recon] = await Promise.all([api.admin.products(), api.admin.reconciliation()])
    setProducts(products)
    setRecon(recon)
    setRevision((r) => r + 1)
  }, [])

  useEffect(() => {
    load().catch((e) => setFlash({ kind: 'error', text: describeError(e) }))
  }, [load])

  /** Runs an action, reports the result, and always refreshes the list. */
  async function run(action: () => Promise<unknown>, success: string) {
    setFlash(null)
    try {
      await action()
      setFlash({ kind: 'success', text: success })
      return true
    } catch (e) {
      setFlash({ kind: 'error', text: describeError(e) })
      return false
    } finally {
      await load().catch(() => {})
    }
  }

  if (!products) return flash ? <p className={`notice ${flash.kind}`}>{flash.text}</p> : <p className="muted">Loading…</p>

  const active = products.filter((p) => p.isActive)
  const lowStock = active.filter((p) => p.stock <= 5).length

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p className="muted">
            {active.length} active products · {lowStock} low on stock (5 or fewer)
            {recon &&
              (recon.balanced ? (
                <span className="pill on recon" title="Every product's stock equals the sum of its recorded stock movements">
                  Ledger balanced
                </span>
              ) : (
                <span className="pill bad recon" title={recon.mismatches.map((m) => `${m.sku}: stock ${m.stock}, ledger ${m.ledgerStock}`).join('\n')}>
                  Ledger mismatch on {recon.mismatches.length} product{recon.mismatches.length === 1 ? '' : 's'}
                </span>
              ))}
          </p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Close' : 'New product'}</button>
      </div>

      {flash && <p className={`notice ${flash.kind}`}>{flash.text}</p>}

      {showCreate && (
        <CreateForm
          onCreate={async (input) => {
            const ok = await run(() => api.admin.create(input), `Created ${input.name}.`)
            if (ok) setShowCreate(false)
          }}
        />
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>SKU</th>
              <th className="num">Price</th>
              <th className="num">Stock</th>
              <th>Status</th>
              <th>Adjust stock</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {products.flatMap((p) => [
              editingId === p.id ? (
                <EditRow
                  key={p.id}
                  product={p}
                  onCancel={() => setEditingId(null)}
                  onSave={async (edit) => {
                    const ok = await run(() => api.admin.update(p.id, { version: p.version!, ...edit }), `Saved ${edit.name ?? p.name}.`)
                    if (ok) setEditingId(null)
                  }}
                />
              ) : (
                <tr key={p.id} className={p.isActive ? '' : 'inactive'}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="muted small truncate">{p.description}</div>
                  </td>
                  <td>
                    <code>{p.sku}</code>
                  </td>
                  <td className="num">{formatPrice(p.priceCents)}</td>
                  <td className="num">
                    <span className={p.stock === 0 ? 'stock out' : p.stock <= 5 ? 'stock low' : ''}>{p.stock}</span>
                  </td>
                  <td>{p.isActive ? <span className="pill on">Active</span> : <span className="pill off">Inactive</span>}</td>
                  <td>
                    <StockAdjuster
                      onAdjust={(delta, note) =>
                        run(() => api.admin.adjustStock(p.id, delta, note), `Stock for ${p.name} ${delta > 0 ? 'increased' : 'reduced'} by ${Math.abs(delta)}.`)
                      }
                    />
                  </td>
                  <td>
                    <div className="actions">
                    <button className="secondary" aria-expanded={historyId === p.id} onClick={() => setHistoryId(historyId === p.id ? null : p.id)}>
                      History
                    </button>
                    <button className="secondary" onClick={() => setEditingId(p.id)}>
                      Edit
                    </button>
                    {p.isActive ? (
                      <button
                        className="danger"
                        onClick={() => {
                          if (confirm(`Remove ${p.name} from the storefront? Past orders are kept.`)) {
                            run(() => api.admin.deactivate(p.id), `${p.name} removed from the storefront.`)
                          }
                        }}
                      >
                        Delete
                      </button>
                    ) : (
                      <button className="secondary" onClick={() => run(() => api.admin.update(p.id, { version: p.version!, isActive: true }), `${p.name} restored.`)}>
                        Restore
                      </button>
                    )}
                    </div>
                  </td>
                </tr>
              ),
              historyId === p.id && (
                <tr key={`history-${p.id}`} className="history-row">
                  <td colSpan={7}>
                    <StockHistory productId={p.id} revision={revision} />
                  </td>
                </tr>
              ),
            ])}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Stock is changed by adding or removing units, never by typing a new total, so adjustments can't overwrite purchases made at the same time. Every change is
        recorded in the stock history. Delete hides a product but keeps its order history.
      </p>
    </section>
  )
}

function CreateForm({ onCreate }: { onCreate: (p: { sku: string; name: string; description: string; priceCents: number; stock: number }) => Promise<void> }) {
  const [form, setForm] = useState({ sku: '', name: '', description: '', price: '', stock: '0' })
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  async function submit(e: FormEvent) {
    e.preventDefault()
    const priceCents = parsePriceToCents(form.price)
    if (priceCents === null) return setError('Enter a price like 19.99')
    setError(null)
    await onCreate({ sku: form.sku, name: form.name, description: form.description, priceCents, stock: Number(form.stock) })
  }

  return (
    <form className="card create-form" onSubmit={submit}>
      <label>
        Name
        <input required maxLength={200} value={form.name} onChange={set('name')} />
      </label>
      <label>
        SKU
        <input required maxLength={64} value={form.sku} onChange={set('sku')} />
      </label>
      <label>
        Price (USD)
        <input required inputMode="decimal" placeholder="19.99" value={form.price} onChange={set('price')} />
      </label>
      <label>
        Initial stock
        <input required type="number" min={0} step={1} value={form.stock} onChange={set('stock')} />
      </label>
      <label className="wide">
        Description
        <textarea rows={2} maxLength={2000} value={form.description} onChange={set('description')} />
      </label>
      {error && <p className="notice error wide">{error}</p>}
      <div className="wide">
        <button type="submit">Create product</button>
      </div>
    </form>
  )
}

function EditRow({
  product,
  onSave,
  onCancel,
}: {
  product: Product
  onSave: (edit: { name: string; description: string; priceCents: number }) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(product.name)
  const [description, setDescription] = useState(product.description)
  const [price, setPrice] = useState((product.priceCents / 100).toFixed(2))
  const priceCents = parsePriceToCents(price)

  return (
    <tr className="editing">
      <td>
        <input aria-label="Name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Description" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </td>
      <td>
        <code>{product.sku}</code>
      </td>
      <td className="num">
        <input aria-label="Price" className="narrow" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </td>
      <td className="num">{product.stock}</td>
      <td colSpan={2} className="muted small">
        Editing version {product.version}
      </td>
      <td>
        <div className="actions">
          <button disabled={!name.trim() || priceCents === null} onClick={() => onSave({ name, description, priceCents: priceCents! })}>
            Save
          </button>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </td>
    </tr>
  )
}

function StockAdjuster({ onAdjust }: { onAdjust: (delta: number, note: string) => Promise<unknown> }) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const n = Math.floor(Number(amount))
  const valid = Number.isFinite(n) && n > 0

  const apply = async (sign: 1 | -1) => {
    await onAdjust(sign * n, note)
    setAmount('')
    setNote('')
  }

  return (
    <div className="adjuster">
      <div className="adjuster-row">
        <input aria-label="Units" className="narrow" type="number" min={1} step={1} placeholder="Units" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className="secondary" disabled={!valid} onClick={() => apply(1)} title="Restock: add units">
          +
        </button>
        <button className="secondary" disabled={!valid} onClick={() => apply(-1)} title="Write off: remove units">
          −
        </button>
      </div>
      {valid && (
        <input aria-label="Reason" className="note" maxLength={500} placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      )}
    </div>
  )
}

const REASON_LABELS: Record<StockMovement['reason'], string> = {
  opening_balance: 'Opening balance',
  purchase: 'Purchase',
  restock: 'Restock',
  write_off: 'Write-off',
}

function StockHistory({ productId, revision }: { productId: number; revision: number }) {
  const [movements, setMovements] = useState<StockMovement[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.admin
      .movements(productId)
      .then(({ movements }) => !cancelled && setMovements(movements))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [productId, revision])

  if (error) return <p className="notice error">{error}</p>
  if (!movements) return <p className="muted small">Loading history…</p>
  if (movements.length === 0) return <p className="muted small">No stock movements yet.</p>

  return (
    <div className="history">
      <h3>Stock history</h3>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Reason</th>
            <th className="num">Change</th>
            <th className="num">Stock after</th>
            <th>By</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id}>
              <td>{new Date(m.createdAt).toLocaleString()}</td>
              <td>{REASON_LABELS[m.reason]}</td>
              <td className={`num ${m.delta > 0 ? 'delta-up' : 'delta-down'}`}>{m.delta > 0 ? `+${m.delta}` : `−${Math.abs(m.delta)}`}</td>
              <td className="num">{m.stockAfter}</td>
              <td>{m.actorEmail ?? <span className="muted">system</span>}</td>
              <td className="muted">{m.orderId ? `Order #${m.orderId}` : m.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
