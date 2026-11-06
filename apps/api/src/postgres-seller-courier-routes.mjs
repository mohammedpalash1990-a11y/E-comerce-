import { HttpError, id, now, text } from './postgres-shared.mjs';
import { courierBook, courierQuote, COURIERS, SHIPMENT_STATUSES } from './gateways.mjs';

const activeTransitions = Object.freeze({
  BOOKED: new Set(['PICKED_UP', 'FAILED_DELIVERY', 'RETURNED']),
  PICKED_UP: new Set(['IN_TRANSIT', 'FAILED_DELIVERY', 'RETURNED']),
  IN_TRANSIT: new Set(['DELIVERED', 'FAILED_DELIVERY', 'RETURNED']),
  FAILED_DELIVERY: new Set(['PICKED_UP', 'IN_TRANSIT', 'RETURNED']),
  DELIVERED: new Set(),
  RETURNED: new Set()
});

const bdt = paisa => Number(paisa || 0) / 100;

export function registerPostgresSellerCourierRoutes(route, ok, {
  database, orderLifecycle, id: makeId = id, now: getNow = now
} = {}) {
  if (!database?.q || typeof database.tx !== 'function') {
    throw new TypeError('PostgreSQL database with transaction support is required');
  }
  if (typeof orderLifecycle?.applySellerStatus !== 'function') {
    throw new TypeError('PostgreSQL order lifecycle repository is required');
  }
  const q = sql => database.q(sql);

  route('GET', '/api/v1/seller/courier/quote', ['SELLER'], async ({ user, url }) => {
    const profile = await q(`SELECT sp.status,u.status AS account_status
      FROM seller_profiles sp JOIN users u ON u.id=sp.user_id
      WHERE sp.user_id=?`).get(user.id);
    if (!profile || profile.status !== 'APPROVED' || profile.account_status !== 'ACTIVE') {
      throw new HttpError(403, 'অনুমোদিত ও সক্রিয় বিক্রেতা অ্যাকাউন্ট প্রয়োজন');
    }
    const area = text(url.searchParams.get('area'), 100, 'ডেলিভারি এলাকা', { required: false });
    return ok({
      mode: 'sandbox',
      quotes_bdt: Object.fromEntries(COURIERS.map(provider => [provider, bdt(courierQuote(provider, area))]))
    });
  });

  route('POST', '/api/v1/seller/orders/:id/courier', ['SELLER'], async ({ user, params, body }) => {
    const sellerOrderId = text(params[0], 128, 'Seller order ID');
    const provider = String(body.provider || '').trim().toUpperCase();
    if (!COURIERS.includes(provider)) throw new HttpError(400, 'অজানা কুরিয়ার নির্বাচন করা হয়েছে');

    const result = await database.tx(async () => {
      const seller = await q(`SELECT sp.status,u.status AS account_status
        FROM seller_profiles sp JOIN users u ON u.id=sp.user_id
        WHERE sp.user_id=? FOR SHARE OF sp,u`).get(user.id);
      if (!seller || seller.status !== 'APPROVED' || seller.account_status !== 'ACTIVE') {
        throw new HttpError(403, 'অনুমোদিত ও সক্রিয় বিক্রেতা অ্যাকাউন্ট প্রয়োজন');
      }

      const order = await q(`SELECT so.id,so.order_id,so.status,o.delivery_area,o.user_id
        FROM seller_orders so JOIN orders o ON o.id=so.order_id
        WHERE so.id=? AND so.seller_id=? FOR UPDATE OF so,o`).get(sellerOrderId, user.id);
      if (!order) throw new HttpError(404, 'আপনার বিক্রেতা অর্ডারটি পাওয়া যায়নি');
      if (order.status !== 'SHIPPED') {
        throw new HttpError(409, 'কুরিয়ার বুক করার আগে বিক্রেতার অর্ডার SHIPPED করতে হবে');
      }

      const active = await q(`SELECT id,provider,tracking_id,status
        FROM shipments WHERE seller_order_id=?
          AND status NOT IN ('FAILED_DELIVERY','RETURNED')
        ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`).get(order.id);
      if (active) throw new HttpError(409, 'এই অর্ডারে কুরিয়ার আগে থেকেই বুক করা আছে');

      const booking = courierBook(provider, order.delivery_area || '');
      const shipmentId = makeId();
      const timestamp = getNow();
      await q(`INSERT INTO shipments(
        id,seller_order_id,provider,tracking_id,status,charge_paisa,mode,created_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        shipmentId, order.id, provider, booking.trackingId, 'BOOKED', booking.charge, 'sandbox', timestamp
      );
      await q(`INSERT INTO order_events(
        id,order_id,seller_order_id,status,note,actor_id,created_at
      ) VALUES(?,?,?,?,?,?,?)`).run(
        makeId(), order.order_id, order.id, 'COURIER_BOOKED',
        provider + ' ' + booking.trackingId, user.id, timestamp
      );
      await q(`INSERT INTO audit_logs(
        id,actor_id,action,entity,entity_id,detail,created_at
      ) VALUES(?,?,?,?,?,?,?)`).run(
        makeId(), user.id, 'COURIER_BOOKED', 'shipment', shipmentId,
        JSON.stringify({ seller_order_id: order.id, provider, tracking_id: booking.trackingId, mode: 'sandbox' }),
        timestamp
      );
      await q('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
        .run(makeId(), order.user_id, 'আপনার অর্ডার কুরিয়ারে দেওয়া হয়েছে', provider + ' · ' + booking.trackingId, timestamp);

      return {
        id: shipmentId, seller_order_id: order.id, provider,
        tracking_id: booking.trackingId, status: 'BOOKED',
        charge_bdt: bdt(booking.charge), mode: 'sandbox'
      };
    });
    return ok(result, 201);
  });

  route('POST', '/api/v1/seller/shipments/:id/status', ['SELLER'], async ({ user, params, body }) => {
    const shipmentId = text(params[0], 128, 'Shipment ID');
    const next = String(body.status || '').trim().toUpperCase();
    if (!SHIPMENT_STATUSES.includes(next) || next === 'BOOKED') throw new HttpError(400, 'কুরিয়ার স্ট্যাটাস সঠিক নয়');

    const result = await database.tx(async () => {
      const seller = await q(`SELECT sp.status,u.status AS account_status
        FROM seller_profiles sp JOIN users u ON u.id=sp.user_id
        WHERE sp.user_id=? FOR SHARE OF sp,u`).get(user.id);
      if (!seller || seller.status !== 'APPROVED' || seller.account_status !== 'ACTIVE') {
        throw new HttpError(403, 'অনুমোদিত ও সক্রিয় বিক্রেতা অ্যাকাউন্ট প্রয়োজন');
      }

      const shipment = await q(`SELECT sh.id,sh.seller_order_id,sh.provider,sh.tracking_id,sh.status,
          so.order_id,so.status AS seller_order_status,o.user_id
        FROM shipments sh
        JOIN seller_orders so ON so.id=sh.seller_order_id
        JOIN orders o ON o.id=so.order_id
        WHERE sh.id=? AND so.seller_id=?
        FOR UPDATE OF sh,so,o`).get(shipmentId, user.id);
      if (!shipment) throw new HttpError(404, 'আপনার shipment পাওয়া যায়নি');

      const duplicate = shipment.status === next;
      if (next === 'DELIVERED' && shipment.seller_order_status !== 'SHIPPED') {
        throw new HttpError(409, 'ডেলিভারি সম্পন্ন করার আগে বিক্রেতার অর্ডার SHIPPED অবস্থায় থাকতে হবে');
      }
      if (!duplicate && !activeTransitions[shipment.status]?.has(next)) {
        throw new HttpError(409, 'এই courier status transition অনুমোদিত নয়');
      }

      const timestamp = getNow();
      if (!duplicate) {
        const updated = await q('UPDATE shipments SET status=? WHERE id=? AND status=? RETURNING id')
          .all(next, shipmentId, shipment.status);
        if (updated.length !== 1) throw new HttpError(409, 'Shipment status পরিবর্তিত হয়েছে; আবার লোড করুন');
        await q(`INSERT INTO order_events(
          id,order_id,seller_order_id,status,note,actor_id,created_at
        ) VALUES(?,?,?,?,?,?,?)`).run(
          makeId(), shipment.order_id, shipment.seller_order_id, 'COURIER_' + next,
          shipment.provider + ' ' + shipment.tracking_id, user.id, timestamp
        );
        await q(`INSERT INTO audit_logs(
          id,actor_id,action,entity,entity_id,detail,created_at
        ) VALUES(?,?,?,?,?,?,?)`).run(
          makeId(), user.id, 'SHIPMENT_' + next, 'shipment', shipmentId,
          JSON.stringify({ seller_order_id: shipment.seller_order_id, from: shipment.status, to: next }),
          timestamp
        );
        await q('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
          .run(makeId(), shipment.user_id, 'ডেলিভারি আপডেট', next, timestamp);
      }
      return {
        id: shipmentId, seller_order_id: shipment.seller_order_id,
        status: next, seller_order_status: shipment.seller_order_status,
        duplicate
      };
    });

    // Order earning/commission accounting is handled by the canonical lifecycle
    // repository. Repeat DELIVERED calls safely retry this step if a prior
    // request committed the shipment update but the lifecycle transaction failed.
    let parentStatus;
    if (next === 'DELIVERED' && result.seller_order_status === 'SHIPPED') {
      parentStatus = await orderLifecycle.applySellerStatus(
        result.seller_order_id, 'DELIVERED', user.id, 'কুরিয়ার ডেলিভারি নিশ্চিত'
      );
    }
    return ok({
      id: result.id, seller_order_id: result.seller_order_id,
      status: result.status, duplicate: result.duplicate,
      ...(parentStatus ? { parent_status: parentStatus } : {})
    });
  });
}
