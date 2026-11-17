import {
  id,
  now,
  bad,
  HttpError,
  normPhone,
  validPhone,
  validEmail,
  text
} from './postgres-shared.mjs';
import {
  money,
  productView,
  parseImages,
  productFields
} from './postgres-domain-helpers.mjs';
import { courierBook, COURIERS, SHIPMENT_STATUSES } from './gateways.mjs';

const bdt = value => Number(value || 0) / 100;
const orderNo = value => 'HAAT-' + String(value).replace(/-/g, '').slice(0, 10).toUpperCase();
const slugify = value => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || id().slice(0, 8);

const lim = (url, fallback = 100) => {
  const n = Number.parseInt(url?.searchParams?.get('limit') || String(fallback), 10);
  return Number.isSafeInteger(n) ? Math.min(Math.max(n, 1), 500) : fallback;
};

// PostgreSQL-only operational routes providing full parity with the SQLite admin/operations
// endpoints while preserving transaction boundaries, role isolation, and atomic row locks.
export function registerPostgresOperationsRoutes(route, ok, { database, orderLifecycle } = {}) {
  if (!database?.q || typeof database.tx !== 'function') {
    throw new TypeError('PostgreSQL database with transaction support is required');
  }
  const q = sql => database.q(sql);

  async function audit(actorId, action, entity, entityId, detail = {}) {
    await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id(), actorId || null, action, entity, entityId || null, JSON.stringify(detail), now());
  }

  async function notify(userId, title, body = '') {
    if (!userId) return;
    await q('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
      .run(id(), userId, title, body, now());
  }

  async function sellerBalance(sellerId) {
    const row = await q(`SELECT
      COALESCE((SELECT SUM(subtotal_paisa) FROM seller_orders WHERE seller_id=? AND status='DELIVERED'),0) AS sales,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind='COMMISSION'),0) AS commission,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind IN('SELLER_EARNING','SELLER_REVERSAL')),0) AS earned,
      COALESCE((SELECT SUM(net_paisa) FROM seller_orders WHERE seller_id=? AND status IN('CONFIRMED','PROCESSING','SHIPPED')),0) AS pending,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status='APPROVED'),0) AS paid,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status IN('REQUESTED','APPROVED')),0) AS reserved
    `).get(sellerId, sellerId, sellerId, sellerId, sellerId, sellerId);
    const earned = Number(row?.earned || 0);
    const reserved = Number(row?.reserved || 0);
    const availablePaisa = Math.max(0, earned - reserved);
    return {
      total_sales_bdt: bdt(row?.sales),
      commission_bdt: bdt(row?.commission),
      net_earnings_bdt: bdt(earned),
      pending_balance_bdt: bdt(row?.pending),
      available_balance_bdt: bdt(availablePaisa),
      paid_out_bdt: bdt(row?.paid),
      available_paisa: availablePaisa
    };
  }

  // ---------- Customers ----------
  async function loadCustomer(customerId) {
    const row = await q(`SELECT id,name,phone,email,status,phone_verified,email_verified,created_at
      FROM users WHERE id=? AND role='CUSTOMER'`).get(customerId);
    if (!row) throw new HttpError(404, 'Customer not found');
    return {
      ...row,
      phone_verified: Boolean(Number(row.phone_verified)),
      email_verified: Boolean(Number(row.email_verified))
    };
  }

  route('GET', '/api/v1/admin/customers', ['ADMIN'], async ({ url }) => {
    const term = '%' + String(url.searchParams.get('q') || '').trim().slice(0, 60) + '%';
    const rows = await q(`SELECT id,name,phone,email,status,created_at,
      (SELECT COUNT(*)::int FROM orders o WHERE o.user_id=users.id) AS orders
      FROM users WHERE role='CUSTOMER' AND (name ILIKE ? OR phone ILIKE ? OR COALESCE(email,'') ILIKE ?)
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(term, term, term, lim(url));
    return ok(rows.map(r => ({ ...r, orders: Number(r.orders || 0) })));
  });

  route('GET', '/api/v1/admin/customers/:id', ['ADMIN'], async ({ params }) => {
    const c = await loadCustomer(params[0]);
    const [addresses, countRow] = await Promise.all([
      q('SELECT label,name,phone,address,area FROM addresses WHERE user_id=? ORDER BY is_default DESC,id').all(c.id),
      q('SELECT COUNT(*)::int AS n FROM orders WHERE user_id=?').get(c.id)
    ]);
    return ok({ ...c, addresses, order_count: Number(countRow?.n || 0) });
  });

  route('GET', '/api/v1/admin/customers/:id/orders', ['ADMIN'], async ({ params }) => {
    await loadCustomer(params[0]);
    const rows = await q(`SELECT id,total_paisa,status,payment_method,payment_status,created_at
      FROM orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200`).all(params[0]);
    return ok(rows.map(r => ({
      id: r.id,
      orderNumber: orderNo(r.id),
      total_bdt: bdt(r.total_paisa),
      status: r.status,
      payment: { method: r.payment_method, status: r.payment_status },
      created_at: r.created_at
    })));
  });

  route('PUT', '/api/v1/admin/customers/:id', ['ADMIN'], async ({ user, params, body }) => {
    const c = await loadCustomer(params[0]);
    const name = text(body.name ?? c.name, 100, 'নাম');
    const phone = normPhone(body.phone ?? c.phone);
    const email = text(body.email ?? c.email, 160, 'ইমেইল', { required: false }).toLowerCase() || null;
    if (!validPhone(phone) || (email && !validEmail(email))) throw bad('মোবাইল বা ইমেইল সঠিক নয়');
    const phoneDup = await q('SELECT 1 FROM users WHERE phone=? AND id<>?').get(phone, c.id);
    const emailDup = email ? await q('SELECT 1 FROM users WHERE lower(email)=? AND id<>?').get(email, c.id) : null;
    if (phoneDup || emailDup) throw new HttpError(409, 'মোবাইল বা ইমেইল ব্যবহৃত');
    await q('UPDATE users SET name=?,phone=?,email=? WHERE id=?').run(name, phone, email, c.id);
    await audit(user.id, 'CUSTOMER_EDIT', 'user', c.id);
    return ok(await loadCustomer(c.id));
  });

  for (const [act, status] of [['suspend', 'SUSPENDED'], ['activate', 'ACTIVE']]) {
    route('POST', '/api/v1/admin/customers/:id/' + act, ['ADMIN'], async ({ user, params }) => {
      await loadCustomer(params[0]);
      await database.tx(async () => {
        await q('UPDATE users SET status=? WHERE id=?').run(status, params[0]);
        if (status === 'SUSPENDED') await q('DELETE FROM sessions WHERE user_id=?').run(params[0]);
        await audit(user.id, 'CUSTOMER_' + status, 'user', params[0]);
      });
      return ok({ id: params[0], status });
    });
  }

  // ---------- Sellers extended actions & inspection ----------
  const SELLER_SQL = `SELECT u.id,u.name,u.phone,u.email,u.status AS user_status,
    sp.shop_name,sp.shop_address,sp.business_info,sp.kyc_nid,sp.kyc_trade_license,
    sp.status,sp.commission_bps,sp.created_at
    FROM seller_profiles sp JOIN users u ON u.id=sp.user_id`;

  async function loadSeller(sellerId) {
    const row = await q(SELLER_SQL + ' WHERE u.id=?').get(sellerId);
    if (!row) throw new HttpError(404, 'Seller not found');
    return { ...row, commission_bps: Number(row.commission_bps) };
  }

  route('GET', '/api/v1/admin/sellers/:id', ['ADMIN'], async ({ params }) => {
    const s = await loadSeller(params[0]);
    const [{ available_paisa, ...balance }, prodCount] = await Promise.all([
      sellerBalance(s.id),
      q("SELECT COUNT(*)::int AS n FROM products WHERE seller_id=? AND status<>'ARCHIVED'").get(s.id)
    ]);
    return ok({ ...s, balance, product_count: Number(prodCount?.n || 0) });
  });

  route('GET', '/api/v1/admin/sellers/:id/products', ['ADMIN'], async ({ params }) => {
    const rows = await q('SELECT id,name_bn,name_en,price_paisa,discount_paisa,stock,status FROM products WHERE seller_id=? ORDER BY created_at DESC,id DESC LIMIT 300').all(params[0]);
    return ok(rows.map(productView));
  });

  route('GET', '/api/v1/admin/sellers/:id/orders', ['ADMIN'], async ({ params }) => {
    const rows = await q('SELECT id,order_id,status,subtotal_paisa,commission_paisa,net_paisa,created_at FROM seller_orders WHERE seller_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(params[0]);
    return ok(rows.map(o => ({
      id: o.id,
      orderNumber: orderNo(o.order_id),
      status: o.status,
      subtotal_bdt: bdt(o.subtotal_paisa),
      commission_bdt: bdt(o.commission_paisa),
      net_bdt: bdt(o.net_paisa),
      created_at: o.created_at
    })));
  });

  route('GET', '/api/v1/admin/sellers/:id/finance', ['ADMIN'], async ({ params }) => {
    const { available_paisa, ...balance } = await sellerBalance(params[0]);
    return ok(balance);
  });

  for (const [act, spStatus, userStatus] of [
    ['approve', 'APPROVED', 'ACTIVE'],
    ['reject', 'REJECTED', 'ACTIVE'],
    ['suspend', 'SUSPENDED', 'SUSPENDED'],
    ['activate', 'APPROVED', 'ACTIVE']
  ]) {
    route('POST', '/api/v1/admin/sellers/:id/' + act, ['ADMIN'], async ({ user, params, body }) => {
      const s = await loadSeller(params[0]);
      const reason = String(body.reason || '').slice(0, 300);
      await database.tx(async () => {
        await q('UPDATE seller_profiles SET status=? WHERE user_id=?').run(spStatus, s.id);
        await q('UPDATE users SET status=? WHERE id=?').run(userStatus, s.id);
        if (userStatus === 'SUSPENDED') await q('DELETE FROM sessions WHERE user_id=?').run(s.id);
        await audit(user.id, 'SELLER_' + spStatus, 'seller', s.id, { reason });
        await notify(s.id, 'বিক্রেতা অ্যাকাউন্ট: ' + spStatus, reason);
      });
      return ok({ id: s.id, status: spStatus });
    });
  }

  route('PATCH', '/api/v1/admin/sellers/:id/commission', ['ADMIN'], async ({ user, params, body }) => {
    const bps = Number(body.commission_bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw bad('কমিশন ০–৫০% এর মধ্যে হতে হবে');
    await loadSeller(params[0]);
    await q('UPDATE seller_profiles SET commission_bps=? WHERE user_id=?').run(bps, params[0]);
    await audit(user.id, 'COMMISSION_SET', 'seller', params[0], { bps });
    return ok({ id: params[0], commission_bps: bps });
  });

  // ---------- Products extended admin edits ----------
  route('PUT', '/api/v1/admin/products/:id', ['ADMIN'], async ({ user, params, body }) => {
    const exists = await q("SELECT id FROM products WHERE id=? AND status<>'ARCHIVED'").get(params[0]);
    if (!exists) throw new HttpError(404, 'Product not found');
    const fields = await productFields(body, { partial: true, query: q });
    const imgs = parseImages(body.images);
    const keys = Object.keys(fields);
    await database.tx(async () => {
      if (keys.length) {
        await q('UPDATE products SET ' + keys.map(k => k + '=?').join(',') + ',updated_at=? WHERE id=?')
          .run(...keys.map(k => fields[k]), now(), params[0]);
      }
      if (imgs !== null) {
        await q('DELETE FROM product_images WHERE product_id=?').run(params[0]);
        for (let i = 0; i < imgs.length; i++) {
          await q('INSERT INTO product_images(id,product_id,url,position) VALUES(?,?,?,?)').run(id(), params[0], imgs[i], i);
        }
      }
      await audit(user.id, 'PRODUCT_ADMIN_EDIT', 'product', params[0]);
    });
    return ok({ id: params[0] });
  }, { limit: 3000000 });

  route('PATCH', '/api/v1/admin/products/:id/stock', ['ADMIN'], async ({ user, params, body }) => {
    const stock = Number(body.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) throw bad('স্টক সঠিক নয়');
    const res = await q('UPDATE products SET stock=?,updated_at=? WHERE id=?').run(stock, now(), params[0]);
    if (!res.changes) throw new HttpError(404, 'Product not found');
    await audit(user.id, 'STOCK_UPDATE', 'product', params[0], { stock });
    return ok({ id: params[0], stock });
  });

  route('DELETE', '/api/v1/admin/products/:id', ['ADMIN'], async ({ user, params }) => {
    await database.tx(async () => {
      const res = await q("UPDATE products SET status='ARCHIVED',active=0,updated_at=? WHERE id=? AND status<>'ARCHIVED'")
        .run(now(), params[0]);
      if (!res.changes) throw new HttpError(404, 'Product not found');
      await q('DELETE FROM cart_items WHERE product_id=?').run(params[0]);
      await audit(user.id, 'PRODUCT_DELETE', 'product', params[0]);
    });
    return ok({ deleted: true });
  });

  // ---------- Categories & Brands ----------
  route('POST', '/api/v1/admin/categories', ['ADMIN'], async ({ user, body }) => {
    const bn = text(body.name_bn, 80, 'বাংলা নাম');
    const en = text(body.name_en, 80, 'ইংরেজি নাম', { required: false });
    const slug = slugify(body.slug || en || bn);
    const cid = id();
    await q('INSERT INTO categories(id,slug,name_bn,name_en) VALUES(?,?,?,?)').run(cid, slug, bn, en);
    await audit(user.id, 'CATEGORY_CREATE', 'category', cid, { slug });
    return ok({ id: cid, slug }, 201);
  });

  route('PUT', '/api/v1/admin/categories/:slug', ['ADMIN'], async ({ user, params, body }) => {
    const bn = text(body.name_bn, 80, 'বাংলা নাম');
    const en = text(body.name_en, 80, 'ইংরেজি নাম', { required: false });
    const res = await q('UPDATE categories SET name_bn=?,name_en=? WHERE slug=?').run(bn, en, params[0]);
    if (!res.changes) throw new HttpError(404, 'Not found');
    await audit(user.id, 'CATEGORY_EDIT', 'category', params[0]);
    return ok({ slug: params[0] });
  });

  route('DELETE', '/api/v1/admin/categories/:slug', ['ADMIN'], async ({ user, params }) => {
    const used = await q('SELECT 1 FROM products p JOIN categories c ON c.id=p.category_id WHERE c.slug=? LIMIT 1').get(params[0]);
    if (used) throw new HttpError(409, 'ক্যাটাগরিতে পণ্য আছে');
    await q('DELETE FROM categories WHERE slug=?').run(params[0]);
    await audit(user.id, 'CATEGORY_DELETE', 'category', params[0]);
    return ok({ deleted: true });
  });

  route('POST', '/api/v1/admin/brands', ['ADMIN'], async ({ user, body }) => {
    const name = text(body.name, 80, 'ব্র্যান্ড নাম');
    const slug = slugify(body.slug || name);
    const bid = id();
    await q('INSERT INTO brands(id,slug,name) VALUES(?,?,?)').run(bid, slug, name);
    await audit(user.id, 'BRAND_CREATE', 'brand', bid, { slug });
    return ok({ id: bid, slug }, 201);
  });

  route('DELETE', '/api/v1/admin/brands/:slug', ['ADMIN'], async ({ user, params }) => {
    await database.tx(async () => {
      await q('UPDATE products SET brand_id=NULL WHERE brand_id=(SELECT id FROM brands WHERE slug=?)').run(params[0]);
      await q('DELETE FROM brands WHERE slug=?').run(params[0]);
      await audit(user.id, 'BRAND_DELETE', 'brand', params[0]);
    });
    return ok({ deleted: true });
  });

  // ---------- Refunds ----------
  async function applyRefundApproval(refund, actorId, { reverse }) {
    const order = await q('SELECT id,user_id,total_paisa FROM orders WHERE id=? FOR UPDATE').get(refund.order_id);
    if (!order) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
    const stamp = now();
    const updated = await q("UPDATE refunds SET status='APPROVED',decided_at=? WHERE id=? AND status='REQUESTED'")
      .run(stamp, refund.id);
    if (updated.changes !== 1) throw new HttpError(409, 'রিফান্ড আগেই প্রক্রিয়াকরণ করা হয়েছে');
    await q('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,ref) DO NOTHING')
      .run(id(), 'REFUND', order.id, null, null, -Number(refund.amount_paisa), refund.id, stamp);
    if (reverse) {
      const sellerOrders = await q("SELECT id,seller_id,net_paisa FROM seller_orders WHERE order_id=? AND status='DELIVERED'").all(order.id);
      for (const so of sellerOrders) {
        const amt = Math.round(Number(so.net_paisa) * Number(refund.amount_paisa) / Number(order.total_paisa));
        if (amt > 0) {
          await q('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,ref) DO NOTHING')
            .run(id(), 'SELLER_REVERSAL', order.id, so.id, so.seller_id, -amt, refund.id + ':' + so.id, stamp);
        }
      }
    }
    const refundedRow = await q("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM refunds WHERE order_id=? AND status='APPROVED'").get(order.id);
    const full = Number(refundedRow?.s || 0) >= Number(order.total_paisa);
    await q('UPDATE orders SET payment_status=? WHERE id=?').run(full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', order.id);
    if (full) await q("UPDATE payments SET status='REFUNDED',updated_at=? WHERE order_id=? AND status='PAID'").run(stamp, order.id);
    await audit(actorId, 'REFUND_APPROVED', 'refund', refund.id, { amount: Number(refund.amount_paisa), order: order.id });
    await notify(order.user_id, 'রিফান্ড অনুমোদিত', orderNo(order.id) + ': ' + bdt(refund.amount_paisa) + ' টাকা');
  }

  route('GET', '/api/v1/admin/refunds', ['ADMIN'], async () => {
    const rows = await q('SELECT id,order_id,amount_paisa,reason,status,created_at,decided_at FROM refunds ORDER BY created_at DESC,id DESC LIMIT 200').all();
    return ok(rows.map(r => ({
      ...r,
      amount_paisa: Number(r.amount_paisa),
      orderNumber: orderNo(r.order_id),
      amount_bdt: bdt(r.amount_paisa)
    })));
  });

  route('POST', '/api/v1/admin/orders/:id/refund', ['ADMIN'], async ({ user, params, body }) => {
    const result = await database.tx(async () => {
      const order = await q('SELECT id,total_paisa,payment_status FROM orders WHERE id=? FOR UPDATE').get(params[0]);
      if (!order) throw new HttpError(404, 'অর্ডার পাওয়া যায়নি');
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.payment_status)) {
        throw new HttpError(409, 'পেমেন্ট সম্পন্ন না হলে রিফান্ড করা যায় না');
      }
      const amt = money(body.amount_bdt, 'রিফান্ড পরিমাণ');
      const doneRow = await q("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM refunds WHERE order_id=? AND status<>'REJECTED'").get(order.id);
      const done = Number(doneRow?.s || 0);
      if (amt > Number(order.total_paisa) - done) {
        throw new HttpError(409, 'রিফান্ড পরিমাণ অর্ডারের পরিশোধিত অংশের বেশি');
      }
      const refund = { id: id(), order_id: order.id, amount_paisa: amt };
      await q('INSERT INTO refunds(id,order_id,amount_paisa,reason,status,created_at,decided_at) VALUES(?,?,?,?,?,?,NULL)')
        .run(refund.id, order.id, amt, text(body.reason, 300, 'কারণ'), 'REQUESTED', now());
      await applyRefundApproval(refund, user.id, { reverse: true });
      return { id: refund.id, status: 'APPROVED' };
    });
    return ok(result, 201);
  });

  route('POST', '/api/v1/admin/refunds/:id/approve', ['ADMIN'], async ({ user, params }) => {
    const result = await database.tx(async () => {
      const refund = await q("SELECT id,order_id,amount_paisa,reason FROM refunds WHERE id=? AND status='REQUESTED' FOR UPDATE").get(params[0]);
      if (!refund) throw new HttpError(404, 'Refund request not found');
      await applyRefundApproval(refund, user.id, { reverse: !/বাতিল/.test(String(refund.reason || '')) });
      return { id: refund.id, status: 'APPROVED' };
    });
    return ok(result);
  });

  route('POST', '/api/v1/admin/refunds/:id/reject', ['ADMIN'], async ({ user, params }) => {
    const res = await q("UPDATE refunds SET status='REJECTED',decided_at=? WHERE id=? AND status='REQUESTED'").run(now(), params[0]);
    if (!res.changes) throw new HttpError(404, 'Refund request not found');
    await audit(user.id, 'REFUND_REJECTED', 'refund', params[0]);
    return ok({ id: params[0], status: 'REJECTED' });
  });

  // ---------- Payouts approve / reject action aliases ----------
  for (const decision of ['APPROVE', 'REJECT']) {
    route('POST', '/api/v1/admin/payouts/:id/' + decision.toLowerCase(), ['ADMIN'], async ({ user, params, body }) => {
      const note = text(body.note, 300, 'নোট', { required: false });
      const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const result = await database.tx(async () => {
        const candidate = await q('SELECT seller_id FROM payouts WHERE id=?').get(params[0]);
        if (!candidate) throw new HttpError(404, 'পেআউট অনুরোধ পাওয়া যায়নি');
        await q('SELECT user_id FROM seller_profiles WHERE user_id=? FOR UPDATE').get(candidate.seller_id);
        const payout = await q('SELECT id,seller_id,amount_paisa,status FROM payouts WHERE id=? FOR UPDATE').get(params[0]);
        if (!payout) throw new HttpError(404, 'পেআউট অনুরোধ পাওয়া যায়নি');
        if (payout.status !== 'REQUESTED') throw new HttpError(409, 'এই পেআউটের সিদ্ধান্ত আগেই দেওয়া হয়েছে');
        if (decision === 'APPROVE') {
          const totals = await q(`SELECT
            COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status IN ('REQUESTED','APPROVED')),0) AS reserved,
            COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind IN ('SELLER_EARNING','SELLER_REVERSAL')),0) AS earned
          `).get(payout.seller_id, payout.seller_id);
          if (Number(totals?.reserved || 0) > Number(totals?.earned || 0)) {
            throw new HttpError(409, 'বিক্রেতার বর্তমান earned balance দিয়ে সব payout reservation সমর্থিত নয়');
          }
        }
        const timestamp = now();
        const changed = await q("UPDATE payouts SET status=?,note=?,decided_at=? WHERE id=? AND status='REQUESTED'")
          .run(status, note, timestamp, payout.id);
        if (changed.changes !== 1) throw new HttpError(409, 'এই পেআউটের সিদ্ধান্ত আগেই দেওয়া হয়েছে');
        await audit(user.id, 'PAYOUT_' + status, 'payout', payout.id, { seller_id: payout.seller_id, amount_paisa: Number(payout.amount_paisa), note });
        await notify(payout.seller_id, status === 'APPROVED' ? 'পেআউট সম্পন্ন' : 'পেআউট প্রত্যাখ্যাত', note);
        return { id: payout.id, status, decided_at: timestamp };
      });
      return ok(result);
    });
  }

  // ---------- Finance & Audit Logs ----------
  route('GET', '/api/v1/admin/finance/summary', ['ADMIN'], async () => {
    const row = await q(`SELECT
      COALESCE((SELECT SUM(total_paisa) FROM orders WHERE status NOT IN('CANCELLED','AWAITING_PAYMENT')),0) AS gross_paisa,
      COALESCE((SELECT SUM(amount_paisa) FROM refunds WHERE status='APPROVED'),0) AS refunds_paisa,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE kind='COMMISSION'),0) AS commission_paisa,
      COALESCE((SELECT SUM(net_paisa) FROM seller_orders WHERE status IN('CONFIRMED','PROCESSING','SHIPPED')),0) AS pending_balance_paisa,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE status='APPROVED'),0) AS paid_out_paisa,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE status='REQUESTED'),0) AS pending_payouts_paisa
    `).get();
    const sellers = await q('SELECT user_id FROM seller_profiles').all();
    let avail = 0;
    for (const s of sellers) avail += (await sellerBalance(s.user_id)).available_paisa;
    const gross = Number(row?.gross_paisa || 0);
    const refunds = Number(row?.refunds_paisa || 0);
    return ok({
      gross_sales_bdt: bdt(gross),
      refunds_bdt: bdt(refunds),
      net_sales_bdt: bdt(gross - refunds),
      platform_commission_bdt: bdt(row?.commission_paisa),
      seller_available_balance_bdt: bdt(avail),
      seller_pending_balance_bdt: bdt(row?.pending_balance_paisa),
      paid_out_bdt: bdt(row?.paid_out_paisa),
      pending_payouts_bdt: bdt(row?.pending_payouts_paisa)
    });
  });

  route('GET', '/api/v1/admin/finance/transactions', ['ADMIN'], async ({ url }) => {
    const kind = url.searchParams.get('kind');
    const rows = await q(`SELECT id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at
      FROM transactions${kind ? ' WHERE kind=?' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...(kind ? [kind] : []), lim(url, 200));
    return ok(rows.map(t => ({ ...t, amount_paisa: Number(t.amount_paisa), amount_bdt: bdt(t.amount_paisa) })));
  });

  route('GET', '/api/v1/admin/finance/report', ['ADMIN'], async ({ url }) => {
    const from = (url.searchParams.get('from') || '0000').slice(0, 10);
    const to = (url.searchParams.get('to') || '9999').slice(0, 10) + 'T99';
    const rows = await q(`SELECT substr(created_at,1,10) AS day,COUNT(*)::int AS orders,COALESCE(SUM(total_paisa),0) AS gross
      FROM orders WHERE status NOT IN('CANCELLED','AWAITING_PAYMENT') AND created_at>=? AND created_at<=?
      GROUP BY day ORDER BY day`).all(from, to);
    return ok(rows.map(r => ({ day: r.day, orders: Number(r.orders || 0), gross_bdt: bdt(r.gross) })));
  });

  route('GET', '/api/v1/admin/audit-logs', ['ADMIN'], async ({ url }) => {
    const rows = await q('SELECT id,actor_id,action,entity,entity_id,detail,created_at FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(lim(url, 200));
    return ok(rows);
  });

  // ---------- Admin Courier ----------
  route('POST', '/api/v1/admin/seller-orders/:id/courier', ['ADMIN'], async ({ user, params, body }) => {
    const provider = String(body.provider || '').trim().toUpperCase();
    if (!COURIERS.includes(provider)) throw bad('অজানা কুরিয়ার নির্বাচন করা হয়েছে');
    const result = await database.tx(async () => {
      const so = await q('SELECT so.id,so.order_id,so.status,o.delivery_area FROM seller_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=? FOR UPDATE OF so,o').get(params[0]);
      if (!so) throw new HttpError(404, 'Not found');
      if (!['PROCESSING', 'SHIPPED'].includes(so.status)) throw new HttpError(409, 'অবস্থা পরিবর্তন সম্ভব নয়');
      const active = await q("SELECT 1 FROM shipments WHERE seller_order_id=? AND status NOT IN('FAILED_DELIVERY','RETURNED') LIMIT 1").get(so.id);
      if (active) throw new HttpError(409, 'ইতিমধ্যে কুরিয়ার বুক করা আছে');
      const b = courierBook(provider, so.delivery_area || '');
      const shipmentId = id();
      const stamp = now();
      await q('INSERT INTO shipments(id,seller_order_id,provider,tracking_id,status,charge_paisa,mode,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(shipmentId, so.id, provider, b.trackingId, b.status, b.charge, 'sandbox', stamp);
      await q('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(), so.order_id, so.id, 'COURIER_BOOKED', provider + ' ' + b.trackingId, user.id, stamp);
      await audit(user.id, 'COURIER_BOOKED', 'shipment', shipmentId, { provider, tracking_id: b.trackingId });
      return { id: shipmentId, provider, tracking_id: b.trackingId, status: b.status, charge_bdt: bdt(b.charge), mode: 'sandbox' };
    });
    return ok(result, 201);
  });

  route('POST', '/api/v1/admin/shipments/:id/status', ['ADMIN'], async ({ user, params, body }) => {
    const status = String(body.status || '').trim().toUpperCase();
    if (!SHIPMENT_STATUSES.includes(status)) throw bad('Invalid shipment status');
    const info = await database.tx(async () => {
      const sh = await q('SELECT sh.id,sh.seller_order_id,sh.provider,sh.tracking_id,so.order_id,so.status AS so_status,o.user_id FROM shipments sh JOIN seller_orders so ON so.id=sh.seller_order_id JOIN orders o ON o.id=so.order_id WHERE sh.id=? FOR UPDATE OF sh,so,o').get(params[0]);
      if (!sh) throw new HttpError(404, 'Shipment not found');
      await q('UPDATE shipments SET status=? WHERE id=?').run(status, sh.id);
      await q('INSERT INTO order_events(id,order_id,seller_order_id,status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(), sh.order_id, sh.seller_order_id, 'COURIER_' + status, sh.provider + ' ' + sh.tracking_id, user.id, now());
      if (status === 'FAILED_DELIVERY' || status === 'RETURNED') {
        await notify(sh.user_id, 'ডেলিভারি আপডেট', status);
      }
      await audit(user.id, 'SHIPMENT_' + status, 'shipment', sh.id);
      return sh;
    });
    if (status === 'DELIVERED' && info.so_status === 'SHIPPED' && typeof orderLifecycle?.applySellerStatus === 'function') {
      await orderLifecycle.applySellerStatus(info.seller_order_id, 'DELIVERED', user.id, 'কুরিয়ার ডেলিভারি নিশ্চিত');
    }
    return ok({ id: info.id, status });
  });
}
