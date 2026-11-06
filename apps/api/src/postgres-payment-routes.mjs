import { HttpError, id as defaultId, now as defaultNow } from './postgres-shared.mjs';

const DEFAULT_METHODS = ['BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ'];
const ONLINE_OUTCOMES = new Set(['SUCCESS', 'FAILED']);

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) {
    throw new HttpError(400, label + ' সঠিক নয়');
  }
  return value.trim();
}

function safePaisa(value, label = 'পেমেন্টের পরিমাণ') {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, label + ' সঠিক নয়');
  return amount;
}

function parseBdtAmount(value) {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) {
    throw new HttpError(400, 'পেমেন্টের পরিমাণ সঠিক নয়');
  }
  const [whole, fraction = ''] = raw.split('.');
  const paisa = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (paisa <= 0n || paisa > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(400, 'পেমেন্টের পরিমাণ সঠিক নয়');
  }
  return Number(paisa);
}

function parseRaw(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function responseFromInitiated(payment) {
  const raw = parseRaw(payment.raw);
  return {
    id: payment.id,
    method: payment.method,
    status: payment.status,
    gateway_txn_id: payment.gateway_txn_id,
    redirect_url: typeof raw.redirect_url === 'string' ? raw.redirect_url : null,
    sandbox: raw.sandbox === true
  };
}

export function createPostgresPaymentRepository(database, {
  id = defaultId,
  now = defaultNow,
  gatewayInitiate,
  methods = DEFAULT_METHODS
} = {}) {
  if (!database?.q || typeof database.tx !== 'function') {
    throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  }
  if (typeof gatewayInitiate !== 'function') throw new TypeError('A payment gateway adapter is required');

  const query = sql => database.q(sql);
  const onlineMethods = new Set(methods.map(method => String(method).toUpperCase()).filter(method => method !== 'COD'));

  function methodValue(value) {
    const method = String(value || '').trim().toUpperCase();
    if (!onlineMethods.has(method)) throw new HttpError(400, 'অনলাইন পেমেন্ট পদ্ধতি সঠিক নয়');
    return method;
  }

  async function prepareCustomerPayment({ userId, orderId, method } = {}) {
    const customerId = identifier(userId, 'গ্রাহক আইডি');
    const oid = identifier(orderId, 'অর্ডার আইডি');
    const paymentMethod = methodValue(method);
    return database.tx(async () => {
      const order = await query('SELECT id,total_paisa,status,payment_status FROM orders WHERE id=? AND user_id=? FOR UPDATE')
        .get(oid, customerId);
      if (!order) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
      if (order.status !== 'AWAITING_PAYMENT' || order.payment_status === 'PAID') {
        throw new HttpError(409, 'এই অর্ডারে এখন অনলাইন পেমেন্ট নেওয়া যাবে না');
      }
      const amount = safePaisa(order.total_paisa);
      const active = await query(`SELECT id,method,status,amount_paisa,gateway_txn_id,raw
        FROM payments WHERE order_id=? AND status IN ('PENDING','INITIATING','INITIATED')
        ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`).get(oid);
      if (active) {
        if (active.status === 'INITIATING') throw new HttpError(409, 'পেমেন্ট চালু করার প্রক্রিয়া চলছে');
        if (active.status === 'INITIATED' && active.method !== paymentMethod) {
          throw new HttpError(409, 'চালু পেমেন্ট শেষ না হওয়া পর্যন্ত পদ্ধতি পরিবর্তন করা যাবে না');
        }
        if (safePaisa(active.amount_paisa) !== amount) {
          throw new HttpError(409, 'অর্ডারের মূল্য বদলে গেছে; পেমেন্ট আবার শুরু করা যাবে না');
        }
        if (active.status === 'PENDING') {
          await query('UPDATE payments SET method=?,updated_at=? WHERE id=? AND status=\'PENDING\'')
            .run(paymentMethod, now(), active.id);
          await query('UPDATE orders SET payment_method=? WHERE id=?').run(paymentMethod, oid);
          return { id: active.id, method: paymentMethod };
        }
        return { id: active.id, method: active.method };
      }
      const paymentId = id();
      const stamp = now();
      await query(`INSERT INTO payments(
        id,order_id,method,amount_paisa,status,gateway_txn_id,raw,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        paymentId, oid, paymentMethod, amount, 'PENDING', null, '{}', stamp, stamp
      );
      await query('UPDATE orders SET payment_method=? WHERE id=?').run(paymentMethod, oid);
      return { id: paymentId, method: paymentMethod };
    });
  }

  async function initiatePayment({ userId, paymentId, method, amountPaisa } = {}) {
    const customerId = identifier(userId, 'গ্রাহক আইডি');
    const pid = identifier(paymentId, 'পেমেন্ট আইডি');
    const expectedMethod = methodValue(method);
    const reserved = await database.tx(async () => {
      const payment = await query(`SELECT p.id,p.order_id,p.method,p.amount_paisa,p.status,p.gateway_txn_id,p.raw,
        o.user_id,o.status AS order_status,o.payment_status,o.total_paisa
        FROM payments p JOIN orders o ON o.id=p.order_id
        WHERE p.id=? AND o.user_id=? FOR UPDATE OF p,o`).get(pid, customerId);
      if (!payment) throw new HttpError(404, 'পেমেন্ট পাওয়া যায়নি');
      if (payment.method !== expectedMethod) throw new HttpError(409, 'পেমেন্ট পদ্ধতি মিলছে না');
      if (amountPaisa !== undefined && safePaisa(amountPaisa) !== safePaisa(payment.amount_paisa)) {
        throw new HttpError(409, 'পেমেন্টের পরিমাণ পরিবর্তিত হয়েছে');
      }
      if (safePaisa(payment.total_paisa) !== safePaisa(payment.amount_paisa)) {
        throw new HttpError(409, 'অর্ডারের মোট মূল্য ও পেমেন্টের পরিমাণ মিলছে না');
      }
      if (payment.order_status !== 'AWAITING_PAYMENT' || payment.payment_status === 'PAID') {
        throw new HttpError(409, 'এই অর্ডারের পেমেন্ট আর চালু করা যাবে না');
      }
      if (payment.status === 'INITIATED') return { existing: true, payment };
      if (payment.status !== 'PENDING') throw new HttpError(409, 'এই পেমেন্টটি আর চালু করা যাবে না');
      const changed = await query(`UPDATE payments SET status='INITIATING',updated_at=?
        WHERE id=? AND status='PENDING' RETURNING id`).all(now(), pid);
      if (changed.length !== 1) throw new HttpError(409, 'পেমেন্টের অবস্থা বদলে গেছে; আবার চেষ্টা করুন');
      return { existing: false, payment };
    });

    if (reserved.existing) return responseFromInitiated(reserved.payment);

    let gateway;
    try {
      gateway = await gatewayInitiate(expectedMethod, {
        id: pid,
        total_paisa: safePaisa(reserved.payment.amount_paisa)
      });
      if (!gateway || typeof gateway.gatewayTxnId !== 'string' || !gateway.gatewayTxnId.trim() || gateway.gatewayTxnId.length > 200) {
        throw new HttpError(502, 'পেমেন্ট গেটওয়ে সঠিক transaction reference দেয়নি');
      }
    } catch (error) {
      await database.tx(async () => {
        await query(`UPDATE payments SET status='PENDING',updated_at=?
          WHERE id=? AND status='INITIATING'`).run(now(), pid);
      });
      throw error;
    }

    const redirectUrl = gateway.sandbox === true
      ? '/api/v1/payments/sandbox/' + pid + '/simulate'
      : String(gateway.redirectUrl || '');
    if (!redirectUrl || redirectUrl.length > 1000) {
      await database.tx(async () => {
        await query(`UPDATE payments SET status='PENDING',updated_at=?
          WHERE id=? AND status='INITIATING'`).run(now(), pid);
      });
      throw new HttpError(502, 'পেমেন্ট গেটওয়ে সঠিক redirect URL দেয়নি');
    }

    const raw = JSON.stringify({ sandbox: gateway.sandbox === true, redirect_url: redirectUrl });
    const stamp = now();
    await database.tx(async () => {
      const current = await query(`SELECT p.id,p.status,p.method,o.status AS order_status,o.payment_status
        FROM payments p JOIN orders o ON o.id=p.order_id
        WHERE p.id=? AND o.user_id=? FOR UPDATE OF p,o`).get(pid, customerId);
      if (!current || current.status !== 'INITIATING' || current.method !== expectedMethod ||
          current.order_status !== 'AWAITING_PAYMENT' || current.payment_status === 'PAID') {
        throw new HttpError(409, 'পেমেন্ট চালু করার সময় অর্ডারের অবস্থা বদলে গেছে');
      }
      const updated = await query(`UPDATE payments SET status='INITIATED',gateway_txn_id=?,raw=?,updated_at=?
        WHERE id=? AND status='INITIATING' RETURNING id`).all(
        gateway.gatewayTxnId.trim(), raw, stamp, pid
      );
      if (updated.length !== 1) throw new HttpError(409, 'পেমেন্ট সংরক্ষণ করা যায়নি');
    });

    return {
      id: pid,
      method: expectedMethod,
      status: 'INITIATED',
      gateway_txn_id: gateway.gatewayTxnId.trim(),
      redirect_url: redirectUrl,
      sandbox: gateway.sandbox === true
    };
  }

  async function getCustomerPayment(userId, paymentId) {
    const row = await query(`SELECT p.id,p.order_id,p.method,p.amount_paisa,p.status,p.gateway_txn_id,p.raw
      FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.id=? AND o.user_id=?`).get(
      identifier(paymentId, 'পেমেন্ট আইডি'),
      identifier(userId, 'গ্রাহক আইডি')
    );
    if (!row) return null;
    return {
      id: row.id, method: row.method, amount_paisa: safePaisa(row.amount_paisa),
      status: row.status, gateway_txn_id: row.gateway_txn_id, raw: row.raw
    };
  }

  async function recordVerifiedPaymentCallback({ method, gatewayTxnId, amountPaisa, status } = {}) {
    const paymentMethod = methodValue(method);
    const transactionId = identifier(gatewayTxnId, 'gateway transaction ID');
    const amount = safePaisa(amountPaisa);
    const outcome = String(status || '').toUpperCase();
    if (!ONLINE_OUTCOMES.has(outcome)) throw new HttpError(400, 'পেমেন্ট callback-এর status সঠিক নয়');

    return database.tx(async () => {
      const payment = await query(`SELECT p.id,p.order_id,p.method,p.amount_paisa,p.status,p.gateway_txn_id,
        o.user_id,o.status AS order_status,o.payment_status,o.total_paisa
        FROM payments p JOIN orders o ON o.id=p.order_id
        WHERE p.method=? AND p.gateway_txn_id=? FOR UPDATE OF p,o`).get(paymentMethod, transactionId);
      if (!payment) throw new HttpError(404, 'অজানা payment transaction');
      if (safePaisa(payment.amount_paisa) !== amount || safePaisa(payment.total_paisa) !== amount) {
        throw new HttpError(400, 'পেমেন্টের পরিমাণ অর্ডারের মোট মূল্যের সঙ্গে মিলছে না');
      }
      if (payment.status === 'PAID') return { duplicate: true, status: 'PAID' };
      if (payment.status === 'FAILED') {
        if (outcome === 'FAILED') return { duplicate: true, status: 'FAILED' };
        throw new HttpError(409, 'ব্যর্থ পেমেন্টকে সফল অবস্থায় পরিবর্তন করা যাবে না');
      }
      if (payment.status !== 'INITIATED') throw new HttpError(409, 'পেমেন্ট আগে চালু করা হয়নি');

      const stamp = now();
      if (outcome === 'FAILED') {
        await query(`UPDATE payments SET status='FAILED',updated_at=? WHERE id=? AND status='INITIATED'`)
          .run(stamp, payment.id);
        await query('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id(), payment.order_id, null, 'PAYMENT_FAILED', paymentMethod, null, stamp);
        await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id(), null, 'PAYMENT_FAILED', 'payment', payment.id, JSON.stringify({ method: paymentMethod }), stamp);
        await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
          .run(id(), payment.user_id, 'পেমেন্ট ব্যর্থ', 'অর্ডারের পেমেন্ট আবার চেষ্টা করুন', stamp);
        return { duplicate: false, status: 'FAILED' };
      }

      if (payment.order_status !== 'CANCELLED' && payment.payment_status === 'PAID') {
        throw new HttpError(409, 'অর্ডার ইতিমধ্যে পরিশোধ করা হয়েছে');
      }
      await query(`UPDATE payments SET status='PAID',updated_at=? WHERE id=? AND status='INITIATED'`)
        .run(stamp, payment.id);
      await query("UPDATE orders SET payment_status='PAID' WHERE id=?").run(payment.order_id);
      await query(`INSERT INTO transactions(
        id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at
      ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,ref) DO NOTHING`).run(
        id(), 'ORDER_PAYMENT', payment.order_id, null, null, amount, payment.id, stamp
      );

      if (payment.order_status === 'AWAITING_PAYMENT') {
        await query("UPDATE seller_orders SET status='CONFIRMED' WHERE order_id=? AND status='AWAITING_PAYMENT'")
          .run(payment.order_id);
        await query("UPDATE orders SET status='CONFIRMED' WHERE id=? AND status='AWAITING_PAYMENT'")
          .run(payment.order_id);
        await query('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id(), payment.order_id, null, 'PAYMENT_CONFIRMED', paymentMethod, null, stamp);
        const sellers = await query('SELECT seller_id FROM seller_orders WHERE order_id=?').all(payment.order_id);
        for (const seller of sellers) {
          await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
            .run(id(), seller.seller_id, 'নতুন অর্ডার', payment.order_id, stamp);
        }
      } else if (payment.order_status === 'CANCELLED') {
        const already = await query("SELECT COALESCE(SUM(amount_paisa),0) AS amount FROM refunds WHERE order_id=? AND status<>'REJECTED'")
          .get(payment.order_id);
        const refundedOrRequested = Number(already?.amount || 0);
        if (!Number.isSafeInteger(refundedOrRequested) || refundedOrRequested < 0) {
          throw new Error('Invalid existing refund total');
        }
        const refundAmount = Math.max(0, amount - refundedOrRequested);
        if (refundAmount > 0) {
          await query('INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES(?,?,?,?,?,?,NULL)')
            .run(id(), payment.order_id, refundAmount, 'বাতিল অর্ডারে payment এসেছে', 'REQUESTED', stamp);
        }
      }

      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(), null, 'PAYMENT_PAID', 'payment', payment.id, JSON.stringify({ method: paymentMethod, amount_paisa: amount }), stamp);
      await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
        .run(id(), payment.user_id, 'পেমেন্ট সফল', payment.order_id, stamp);
      return { duplicate: false, status: 'PAID' };
    });
  }

  return Object.freeze({
    prepareCustomerPayment, initiatePayment, getCustomerPayment, recordVerifiedPaymentCallback
  });
}

export function registerPostgresPaymentRoutes(route, ok, {
  paymentRepository,
  paymentMode = 'sandbox',
  gatewaySign,
  gatewayVerify
} = {}) {
  if (!paymentRepository?.prepareCustomerPayment || !paymentRepository?.initiatePayment ||
      !paymentRepository?.getCustomerPayment || !paymentRepository?.recordVerifiedPaymentCallback) {
    throw new TypeError('PostgreSQL payment repository is required');
  }
  if (typeof gatewaySign !== 'function' || typeof gatewayVerify !== 'function') {
    throw new TypeError('Payment callback signing and verification functions are required');
  }

  route('POST', '/api/v1/customer/orders/:id/pay', ['CUSTOMER'], async ({ user, params, body }) => {
    const pending = await paymentRepository.prepareCustomerPayment({
      userId: user.id, orderId: params[0], method: body.method
    });
    return ok(await paymentRepository.initiatePayment({
      userId: user.id, paymentId: pending.id, method: pending.method
    }), 201);
  });

  route('GET', '/api/v1/payments/:id/status', ['CUSTOMER'], async ({ user, params }) => {
    const payment = await paymentRepository.getCustomerPayment(user.id, params[0]);
    if (!payment) throw new HttpError(404, 'পেমেন্ট পাওয়া যায়নি');
    return ok({
      id: payment.id,
      method: payment.method,
      status: payment.status,
      amount_bdt: payment.amount_paisa / 100
    });
  });

  route('POST', '/api/v1/payments/sandbox/:id/simulate', ['CUSTOMER'], async ({ user, params, body }) => {
    if (paymentMode !== 'sandbox') throw new HttpError(404, 'Not found');
    const outcome = String(body.outcome || '').toLowerCase();
    if (!['success', 'fail'].includes(outcome)) throw new HttpError(400, 'Sandbox outcome success অথবা fail হতে হবে');
    const payment = await paymentRepository.getCustomerPayment(user.id, params[0]);
    if (!payment) throw new HttpError(404, 'পেমেন্ট পাওয়া যায়নি');
    if (payment.status !== 'INITIATED' || !payment.gateway_txn_id) {
      throw new HttpError(409, 'এই পেমেন্ট আর চালু নেই');
    }
    const status = outcome === 'fail' ? 'FAILED' : 'SUCCESS';
    const signed = {
      gatewayTxnId: payment.gateway_txn_id,
      amountPaisa: payment.amount_paisa,
      status
    };
    return ok({
      sandbox: true,
      ...(await paymentRepository.recordVerifiedPaymentCallback({
        method: payment.method,
        gatewayTxnId: signed.gatewayTxnId,
        amountPaisa: signed.amountPaisa,
        status: signed.status,
        signature: gatewaySign(signed)
      }))
    });
  });

  route('POST', '/api/v1/payments/callback/:gateway', null, async ({ params, body }) => {
    if (paymentMode !== 'sandbox') {
      throw new HttpError(501, 'লাইভ payment webhook adapter এখনো যাচাইকৃত নয়');
    }
    const method = String(params[0] || '').toUpperCase();
    if (!['BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ'].includes(method)) {
      throw new HttpError(404, 'Unknown payment gateway');
    }
    const status = String(body.status || '').toUpperCase();
    if (!ONLINE_OUTCOMES.has(status)) throw new HttpError(400, 'পেমেন্ট callback-এর status সঠিক নয়');
    const signed = {
      gatewayTxnId: identifier(body.gateway_txn_id, 'gateway transaction ID'),
      amountPaisa: parseBdtAmount(body.amount_bdt),
      status
    };
    if (typeof body.signature !== 'string' ||
        !gatewayVerify(signed, body.signature)) {
      throw new HttpError(401, 'Invalid gateway signature');
    }
    return ok(await paymentRepository.recordVerifiedPaymentCallback({
      method, gatewayTxnId: signed.gatewayTxnId, amountPaisa: signed.amountPaisa, status
    }));
  });
}
