import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresOrderLifecycleRepository } from '../apps/api/src/postgres-orders.mjs';

function lifecycleHarness({ status = 'CONFIRMED', paymentMethod = 'COD', paymentStatus = 'PENDING' } = {}) {
  const parent = {
    id: 'order-1', user_id: 'customer-1', status, payment_method: paymentMethod,
    payment_status: paymentStatus, total_paisa: 20000
  };
  const sellerOrder = {
    id: 'seller-order-1', order_id: 'order-1', seller_id: 'seller-1',
    status, subtotal_paisa: 20000, net_paisa: 18400, commission_paisa: 1600
  };
  const product = { id: 'product-1', stock: 3 };
  const items = [{ product_id: 'product-1', quantity: 2 }];
  const calls = [];
  const ledger = { transactions: [], refunds: [], events: [], audits: [], notifications: [] };

  const database = {
    q(sql) {
      return {
        async get(...values) {
          calls.push({ sql, values, method: 'get' });
          if (sql.includes('SELECT order_id FROM seller_orders')) return sellerOrder.id === values[0] ? { order_id: sellerOrder.order_id } : undefined;
          if (sql.includes('SELECT * FROM orders')) return parent.id === values[0] ? { ...parent } : undefined;
          if (sql.includes('SELECT * FROM seller_orders')) return sellerOrder.id === values[0] ? { ...sellerOrder } : undefined;
          if (sql.includes('SELECT COUNT(*) count FROM seller_orders')) return { count: 0 };
          if (sql.includes('COALESCE(SUM(amount_paisa),0) amount FROM refunds')) return { amount: ledger.refunds.filter(x => x.status !== 'REJECTED').reduce((sum, x) => sum + x.amount, 0) };
          if (sql.includes('SELECT status FROM orders')) return { status: parent.status };
          return undefined;
        },
        async all(...values) {
          calls.push({ sql, values, method: 'all' });
          if (sql.includes('SELECT status FROM seller_orders')) return [{ status: sellerOrder.status }];
          if (sql.includes('SELECT id,status FROM seller_orders')) return [{ id: sellerOrder.id, status: sellerOrder.status }];
          if (sql.includes('SELECT product_id,quantity FROM order_items')) return items;
          return [];
        },
        async run(...values) {
          calls.push({ sql, values, method: 'run' });
          if (sql.includes('UPDATE products SET stock=stock+')) product.stock += values[0];
          if (sql.includes('UPDATE seller_orders SET status=')) sellerOrder.status = values[0];
          if (sql.includes("UPDATE orders SET payment_status='PAID'")) parent.payment_status = 'PAID';
          if (sql.includes("UPDATE orders SET status=")) parent.status = values[0];
          if (sql.includes("UPDATE payments SET status='PAID'")) ledger.paymentUpdated = true;
          if (sql.includes('INSERT INTO transactions')) ledger.transactions.push(values);
          if (sql.includes('INSERT INTO refunds')) ledger.refunds.push({ amount: values[2], status: values[4] });
          if (sql.includes('INSERT INTO order_events')) ledger.events.push(values);
          return { changes: 1, rows: [], lastInsertRowid: null };
        }
      };
    },
    async tx(fn) {
      calls.push({ sql: 'BEGIN' });
      try {
        const result = await fn();
        calls.push({ sql: 'COMMIT' });
        return result;
      } catch (error) {
        calls.push({ sql: 'ROLLBACK' });
        throw error;
      }
    }
  };
  const repo = createPostgresOrderLifecycleRepository(database, {
    id: (() => { let n = 0; return () => 'ledger-' + (++n); })(),
    now: () => '2026-11-02T00:00:00.000Z',
    orderNo: id => 'HAAT-' + id,
    notify: async (...args) => ledger.notifications.push(args),
    audit: async (...args) => ledger.audits.push(args)
  });
  return { repo, parent, sellerOrder, product, calls, ledger };
}

test('cancelling a seller sub-order restores its stock exactly once and updates the parent', async () => {
  const h = lifecycleHarness();
  const status = await h.repo.applySellerStatus('seller-order-1', 'CANCELLED', 'admin-1', 'out of stock');

  assert.equal(status, 'CANCELLED');
  assert.equal(h.product.stock, 5);
  assert.equal(h.sellerOrder.status, 'CANCELLED');
  assert.equal(h.parent.status, 'CANCELLED');
  assert.equal(h.ledger.events.length, 1);
  assert.equal(h.ledger.audits.length, 1);
  assert.equal(h.ledger.notifications.length, 1);
  await assert.rejects(h.repo.applySellerStatus('seller-order-1', 'CANCELLED', 'admin-1'), /পরিবর্তন করা যাবে না/);
  assert.equal(h.product.stock, 5);
});

test('delivering a COD seller order records seller earning, commission and parent payment once', async () => {
  const h = lifecycleHarness({ status: 'SHIPPED', paymentMethod: 'COD' });
  const status = await h.repo.applySellerStatus('seller-order-1', 'DELIVERED', 'seller-1');

  assert.equal(status, 'DELIVERED');
  assert.equal(h.parent.status, 'DELIVERED');
  assert.equal(h.parent.payment_status, 'PAID');
  assert.equal(h.ledger.transactions.length, 3);
  assert.deepEqual(h.ledger.transactions.map(row => row[1]), ['SELLER_EARNING', 'COMMISSION', 'ORDER_PAYMENT']);
  assert.equal(h.ledger.paymentUpdated, true);
});

test('paid online cancellation creates a capped refund request', async () => {
  const h = lifecycleHarness({ paymentMethod: 'BKASH', paymentStatus: 'PAID' });
  await h.repo.applySellerStatus('seller-order-1', 'CANCELLED', 'admin-1');

  assert.equal(h.ledger.refunds.length, 1);
  assert.equal(h.ledger.refunds[0].amount, 20000);
  assert.equal(h.parent.status, 'CANCELLED');
});

test('invalid seller-order transitions fail without restoring inventory', async () => {
  const h = lifecycleHarness({ status: 'DELIVERED' });
  await assert.rejects(h.repo.applySellerStatus('seller-order-1', 'CANCELLED', 'admin-1'), /পরিবর্তন করা যাবে না/);
  assert.equal(h.product.stock, 3);
  assert.equal(h.sellerOrder.status, 'DELIVERED');
});
