import { useEffect, useState } from 'react'
import { api, formatTotals, type Order } from '../api'
import OrdersTable from '../components/OrdersTable'

export default function AdminOrders() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.admin
      .orders()
      .then(({ orders }) => setOrders(orders))
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) return <p className="notice error">{error}</p>
  if (!orders) return <p className="muted">Loading…</p>

  return (
    <section>
      <div className="page-head">
        <h1>Orders</h1>
        <p className="muted">
          {orders.length} most recent orders · {formatTotals(orders)} revenue
        </p>
      </div>
      <OrdersTable orders={orders} showCustomer />
    </section>
  )
}
