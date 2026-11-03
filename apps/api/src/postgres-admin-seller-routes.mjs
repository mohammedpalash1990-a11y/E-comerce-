import { id, now, HttpError, text } from './postgres-shared.mjs';

const transitions = Object.freeze({
  PENDING: new Set(['APPROVED', 'REJECTED']),
  APPROVED: new Set(['SUSPENDED']),
  SUSPENDED: new Set(['APPROVED'])
});

async function audit(database, actorId, action, sellerId, detail) {
  await database.q(
    'INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id(), actorId, action, 'SELLER_PROFILE', sellerId, JSON.stringify(detail), now());
}

export function registerPostgresAdminSellerRoutes(route, ok, { database } = {}) {
  if (!database?.q || typeof database.tx !== 'function') {
    throw new TypeError('PostgreSQL database with transaction support is required');
  }

  route('GET', '/api/v1/admin/sellers', ['ADMIN'], async ({ url }) => {
    const requested = String(url.searchParams.get('status') || '').toUpperCase();
    const allowed = new Set(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']);
    if (requested && !allowed.has(requested)) throw new HttpError(400, 'Invalid seller status filter');

    const rows = await database.q(`SELECT sp.user_id,sp.shop_name,sp.shop_address,sp.business_info,
      sp.status,sp.commission_bps,sp.created_at,u.name,u.phone,u.email,
      (sp.kyc_nid <> '') AS has_nid,(sp.kyc_trade_license <> '') AS has_trade_license
      FROM seller_profiles sp JOIN users u ON u.id=sp.user_id
      ${requested ? 'WHERE sp.status=?' : ''}
      ORDER BY CASE sp.status WHEN 'PENDING' THEN 0 ELSE 1 END,sp.created_at ASC,sp.user_id ASC
      LIMIT 300`).all(...(requested ? [requested] : []));
    return ok(rows);
  });

  route('PATCH', '/api/v1/admin/sellers/:id/status', ['ADMIN'], async ({ user, params, body }) => {
    const sellerId = text(params[0], 128, 'বিক্রেতা আইডি');
    const next = String(body.status || '').trim().toUpperCase();
    if (!['APPROVED', 'REJECTED', 'SUSPENDED'].includes(next)) {
      throw new HttpError(400, 'Invalid seller status');
    }
    const note = text(body.note, 300, 'নোট', { required: false });

    const result = await database.tx(async () => {
      const seller = await database.q(`SELECT sp.user_id,sp.shop_name,sp.status,u.status AS account_status
        FROM seller_profiles sp JOIN users u ON u.id=sp.user_id
        WHERE sp.user_id=? FOR UPDATE`).get(sellerId);
      if (!seller) throw new HttpError(404, 'Seller not found');
      if (!transitions[seller.status]?.has(next)) {
        throw new HttpError(409, `Seller cannot transition from ${seller.status} to ${next}`);
      }
      if (seller.account_status !== 'ACTIVE') {
        throw new HttpError(409, 'Inactive seller account cannot change lifecycle status');
      }
      const changed = await database.q(
        'UPDATE seller_profiles SET status=? WHERE user_id=? AND status=?'
      ).run(next, sellerId, seller.status);
      if (changed.changes !== 1) throw new HttpError(409, 'Seller status changed; reload and try again');

      await audit(database, user.id, 'SELLER_STATUS_CHANGED', sellerId, {
        from: seller.status, to: next, note
      });
      const title = next === 'APPROVED' ? 'আপনার বিক্রেতা অ্যাকাউন্ট অনুমোদিত হয়েছে'
        : next === 'REJECTED' ? 'আপনার বিক্রেতা আবেদন গ্রহণ করা হয়নি'
          : 'আপনার বিক্রেতা অ্যাকাউন্ট সাময়িকভাবে স্থগিত';
      await database.q(
        'INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)'
      ).run(id(), sellerId, title, note, now());

      return { seller_id: sellerId, shop_name: seller.shop_name, previous_status: seller.status, status: next };
    });

    return ok(result);
  });
}
