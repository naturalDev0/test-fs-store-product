import { formatPrice, type Order } from '../api'

export default function OrdersTable({ orders, showCustomer = false }: { orders: Order[]; showCustomer?: boolean }) {
  if (orders.length === 0) return <p className="muted">No orders yet.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Date</th>
            {showCustomer && <th>Customer</th>}
            <th>Product</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>#{o.id}</td>
              <td>{new Date(o.createdAt).toLocaleString()}</td>
              {showCustomer && <td>{o.userEmail}</td>}
              <td>{o.productName}</td>
              <td className="num">{o.quantity}</td>
              <td className="num">{formatPrice(o.unitPriceCents)}</td>
              <td className="num">{formatPrice(o.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
