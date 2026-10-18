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
            <th>Items</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>#{o.id}</td>
              <td>{new Date(o.createdAt).toLocaleString()}</td>
              {showCustomer && <td>{o.userEmail}</td>}
              <td>
                <ul className="line-items">
                  {o.items.map((i) => (
                    <li key={i.productId}>
                      <span>
                        {i.quantity} × {i.productName}
                      </span>
                      <span className="muted small">
                        {formatPrice(i.unitPriceCents, o.currency)} each · {formatPrice(i.lineTotalCents, o.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </td>
              <td className="num">
                <strong>{formatPrice(o.totalCents, o.currency)}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
