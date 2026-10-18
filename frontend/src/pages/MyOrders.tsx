import { useEffect, useState } from 'react'
import { api, formatTotals, type Order } from '../api'
import OrdersTable from '../components/OrdersTable'

export default function MyOrders() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .myOrders()
      .then(({ orders }) => setOrders(orders))
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) return <p className="notice error">{error}</p>
  if (!orders) return <p className="muted">Loading…</p>

  return (
    <section>
      <div className="page-head">
        <h1>My orders</h1>
        {orders.length > 0 && <p className="muted">Total spent: {formatTotals(orders)}</p>}
      </div>
      <OrdersTable orders={orders} />
    </section>
  )
}
