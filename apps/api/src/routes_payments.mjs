import { q, tx, id, now, audit, notify, bad, HttpError, bdt, orderNo, config } from './core.mjs';
import { signCallback, verifySignature, PAYMENT_METHODS } from './gateways.mjs';
import { addEvent, recomputeParent } from './orders.mjs';

// The ONLY place where a payment can become PAID. Requires a valid gateway signature, matching amount,
// and is idempotent: replays of the same callback never create a second transaction.
export function processCallback(method, body) {
  const amountPaisa = Math.round(Number(body.amount_bdt) * 100), status = String(body.status || '').toUpperCase(), txn = String(body.gateway_txn_id || '');
  if (!txn || !['SUCCESS', 'FAILED'].includes(status) || !Number.isSafeInteger(amountPaisa)) throw bad('Invalid callback payload');
  if (!verifySignature({ gatewayTxnId: txn, amountPaisa, status }, body.signature)) throw new HttpError(401, 'Invalid gateway signature');
  return tx(() => {
    const p = q('SELECT * FROM payments WHERE method=? AND gateway_txn_id=?').get(method, txn);
    if (!p) throw new HttpError(404, 'Unknown transaction');
    if (p.amount_paisa !== amountPaisa) throw bad('Amount mismatch');
    if (p.status === 'PAID' || p.status === 'REFUNDED') return { duplicate: true, status: p.status };
    const o = q('SELECT * FROM orders WHERE id=?').get(p.order_id);
    if (status === 'FAILED') {
      q("UPDATE payments SET status='FAILED',updated_at=? WHERE id=?").run(now(), p.id);
      addEvent(o.id, null, 'PAYMENT_FAILED', method, null); audit(null, 'PAYMENT_FAILED', 'payment', p.id);
      notify(o.user_id, 'পেমেন্ট ব্যর্থ', orderNo(o.id) + ' — আবার চেষ্টা করুন');
      return { duplicate: false, status: 'FAILED' };
    }
    q("UPDATE payments SET status='PAID',updated_at=? WHERE id=?").run(now(), p.id);
    q("UPDATE orders SET payment_status='PAID' WHERE id=?").run(o.id);
    q('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?)').run(id(), 'ORDER_PAYMENT', o.id, null, null, p.amount_paisa, p.id, now());
    if (o.status === 'AWAITING_PAYMENT') {
      q("UPDATE seller_orders SET status='CONFIRMED' WHERE order_id=? AND status='AWAITING_PAYMENT'").run(o.id);
      recomputeParent(o.id); addEvent(o.id, null, 'PAYMENT_CONFIRMED', method, null);
      for (const s of q('SELECT seller_id FROM seller_orders WHERE order_id=?').all(o.id)) notify(s.seller_id, 'নতুন অর্ডার', orderNo(o.id));
    } else if (o.status === 'CANCELLED') { // money arrived after cancellation -> refund request
      q('INSERT INTO refunds VALUES(?,?,?,?,?,?,NULL)').run(id(), o.id, p.amount_paisa, 'বাতিল অর্ডারে পেমেন্ট এসেছে (বাতিল)', 'REQUESTED', now());
    }
    audit(null, 'PAYMENT_PAID', 'payment', p.id, { method, amount: p.amount_paisa });
    notify(o.user_id, 'পেমেন্ট সফল', orderNo(o.id));
    return { duplicate: false, status: 'PAID' };
  });
}

export default function register(route, ok) {
  const own = (pid, uid) => { const p = q('SELECT p.* FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND o.user_id=?').get(pid, uid); if (!p) throw new HttpError(404, 'Payment not found'); return p; };
  // Gateway server-to-server callback / webhook (signature protected)
  route('POST', '/api/v1/payments/callback/:gateway', null, ({ params, body }) => {
    const method = params[0].toUpperCase(); if (!PAYMENT_METHODS.includes(method) || method === 'COD') throw new HttpError(404, 'Unknown gateway');
    return ok(processCallback(method, body));
  });
  // Customer polls the backend-verified status (frontend never decides success on its own)
  route('GET', '/api/v1/payments/:id/status', ['CUSTOMER'], ({ user, params }) => { const p = own(params[0], user.id); return ok({ id: p.id, method: p.method, status: p.status, amount_bdt: bdt(p.amount_paisa) }); });
  // Sandbox only: simulates what the gateway would send, through the exact same verified path
  route('POST', '/api/v1/payments/sandbox/:id/simulate', ['CUSTOMER'], ({ user, params, body }) => {
    if (config.paymentMode !== 'sandbox') throw new HttpError(404, 'Not found');
    const p = own(params[0], user.id); if (p.status !== 'INITIATED') throw new HttpError(409, 'এই পেমেন্ট আর চালু নেই');
    const status = body.outcome === 'fail' ? 'FAILED' : 'SUCCESS';
    const payload = { gateway_txn_id: p.gateway_txn_id, amount_bdt: bdt(p.amount_paisa), status };
    payload.signature = signCallback({ gatewayTxnId: p.gateway_txn_id, amountPaisa: p.amount_paisa, status });
    return ok({ sandbox: true, ...processCallback(p.method, payload) });
  });
}
