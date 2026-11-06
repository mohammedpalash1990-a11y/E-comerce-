import { randomUUID } from 'node:crypto';
import { HttpError, text, now as defaultNow } from './postgres-shared.mjs';

const METHODS = ['BKASH', 'NAGAD', 'ROCKET', 'BANK'];
const STATES = ['REQUESTED', 'APPROVED', 'REJECTED'];
const toPaisa = value => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new HttpError(400, 'পেআউটের পরিমাণ সঠিক নয়');
  const paisa = Math.round(amount * 100);
  if (!Number.isSafeInteger(paisa) || paisa <= 0) throw new HttpError(400, 'পেআউটের পরিমাণ সঠিক নয়');
  return paisa;
};
const bdt = value => Number(value || 0) / 100;

export function registerPostgresPayoutRoutes(route, ok, { database, id = randomUUID, now = defaultNow } = {}) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database is required');
  const q = sql => database.q(sql);
  async function balance(sellerId) {
    const row = await q(`SELECT
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind IN('SELLER_EARNING','SELLER_REVERSAL')),0) AS earned,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status IN('REQUESTED','APPROVED')),0) AS reserved
    `).get(sellerId, sellerId);
    return Math.max(0, Number(row?.earned || 0) - Number(row?.reserved || 0));
  }
  async function sellerCanRequest(userId) {
    const row = await q('SELECT sp.status,u.status AS account_status FROM seller_profiles sp JOIN users u ON u.id=sp.user_id WHERE sp.user_id=? FOR UPDATE OF sp').get(userId);
    if (!row) throw new HttpError(403, 'বিক্রেতা প্রোফাইল পাওয়া যায়নি');
    if (row.status !== 'APPROVED' || row.account_status !== 'ACTIVE') throw new HttpError(403, 'শুধু সক্রিয় অনুমোদিত বিক্রেতা পেআউট চাইতে পারবেন');
  }
  async function notifyAdmins(title, body) {
    const admins = await q("SELECT id FROM users WHERE role='ADMIN' AND status='ACTIVE'").all();
    for (const admin of admins) await q('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
      .run(id(), admin.id, title, body, now());
  }

  route('GET', '/api/v1/seller/finance', ['SELLER'], async ({ user }) => {
    const [ledger, payouts, totals] = await Promise.all([
      q('SELECT kind,amount_paisa,created_at,seller_order_id FROM transactions WHERE seller_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(user.id),
      q('SELECT id,amount_paisa,method,account,status,note,created_at,decided_at FROM payouts WHERE seller_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(user.id),
      q(`SELECT
        COALESCE((SELECT SUM(subtotal_paisa) FROM seller_orders WHERE seller_id=? AND status='DELIVERED'),0) AS sales,
        COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind='COMMISSION'),0) AS commission,
        COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind IN('SELLER_EARNING','SELLER_REVERSAL')),0) AS earned,
        COALESCE((SELECT SUM(net_paisa) FROM seller_orders WHERE seller_id=? AND status IN('CONFIRMED','PROCESSING','SHIPPED')),0) AS pending,
        COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status='APPROVED'),0) AS paid
      `).get(user.id,user.id,user.id,user.id,user.id)
    ]);
    return ok({
      total_sales_bdt: bdt(totals.sales), commission_bdt: bdt(totals.commission),
      net_earnings_bdt: bdt(totals.earned), pending_balance_bdt: bdt(totals.pending),
      available_balance_bdt: bdt(await balance(user.id)), paid_out_bdt: bdt(totals.paid),
      settlements: ledger.map(row => ({ ...row, amount_bdt: bdt(row.amount_paisa) })),
      payouts: payouts.map(row => ({ ...row, amount_bdt: bdt(row.amount_paisa) }))
    });
  });

  route('POST', '/api/v1/seller/payouts', ['SELLER'], async ({ user, body }) => {
    const amount = toPaisa(body.amount_bdt);
    const method = String(body.method || '').toUpperCase();
    if (!METHODS.includes(method)) throw new HttpError(400, 'পেআউট পদ্ধতি সঠিক নয়');
    const account = text(body.account, 100, 'অ্যাকাউন্ট নম্বর');
    const payoutId = id(), timestamp = now();
    await database.tx(async () => {
      await sellerCanRequest(user.id);
      const available = await balance(user.id);
      if (amount > available) throw new HttpError(409, 'পর্যাপ্ত Available Balance নেই');
      await q(`INSERT INTO payouts(id,seller_id,amount_paisa,method,account,status,note,created_at,decided_at)
        VALUES(?,?,?,?,?,'REQUESTED','',?,NULL)`).run(payoutId,user.id,amount,method,account,timestamp);
      await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(),user.id,'PAYOUT_REQUEST','payout',payoutId,JSON.stringify({ amount_paisa: amount, method }),timestamp);
      await notifyAdmins('নতুন পেআউট অনুরোধ', bdt(amount) + ' টাকা');
    });
    return ok({ id: payoutId, amount_bdt: bdt(amount), status: 'REQUESTED' }, 201);
  });

  route('GET', '/api/v1/admin/payouts', ['ADMIN'], async ({ url }) => {
    const status = String(url.searchParams.get('status') || 'REQUESTED').toUpperCase();
    if (!STATES.includes(status)) throw new HttpError(400, 'পেআউট স্ট্যাটাস সঠিক নয়');
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100',10) || 100,1),300);
    const rows = await q(`SELECT p.id,p.seller_id,p.amount_paisa,p.method,p.account,p.status,p.note,p.created_at,p.decided_at,
      sp.shop_name,u.name AS seller_name,u.phone AS seller_phone
      FROM payouts p JOIN seller_profiles sp ON sp.user_id=p.seller_id JOIN users u ON u.id=p.seller_id
      WHERE p.status=? ORDER BY p.created_at ASC,p.id ASC LIMIT ?`).all(status,limit);
    return ok(rows.map(row => ({ ...row, amount_paisa: Number(row.amount_paisa), amount_bdt: bdt(row.amount_paisa) })));
  });

  route('POST', '/api/v1/admin/payouts/:id/decision', ['ADMIN'], async ({ user, params, body }) => {
    const decision = String(body.decision || '').toUpperCase();
    if (!['APPROVE','REJECT'].includes(decision)) throw new HttpError(400, 'সিদ্ধান্ত APPROVE অথবা REJECT হতে হবে');
    const note = text(body.note, 300, 'নোট', { required: false });
    const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    return database.tx(async () => {
      const candidate = await q('SELECT seller_id FROM payouts WHERE id=?').get(params[0]);
      if (!candidate) throw new HttpError(404, 'পেআউট অনুরোধ পাওয়া যায়নি');
      // Serialize payout decisions with seller payout requests on the same profile row.
      const seller = await q('SELECT user_id FROM seller_profiles WHERE user_id=? FOR UPDATE').get(candidate.seller_id);
      if (!seller) throw new HttpError(404, 'বিক্রেতা প্রোফাইল পাওয়া যায়নি');
      const payout = await q('SELECT id,seller_id,amount_paisa,status FROM payouts WHERE id=? FOR UPDATE').get(params[0]);
      if (!payout || payout.seller_id !== candidate.seller_id) throw new HttpError(404, 'পেআউট অনুরোধ পাওয়া যায়নি');
      if (payout.status !== 'REQUESTED') throw new HttpError(409, 'এই পেআউটের সিদ্ধান্ত আগেই দেওয়া হয়েছে');

      if (decision === 'APPROVE') {
        const totals = await q(`SELECT
          COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE seller_id=? AND status IN ('REQUESTED','APPROVED')),0) AS reserved,
          COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE seller_id=? AND kind IN ('SELLER_EARNING','SELLER_REVERSAL')),0) AS earned
        `).get(payout.seller_id, payout.seller_id);
        const reserved = Number(totals?.reserved || 0);
        const earned = Number(totals?.earned || 0);
        if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(earned) ||
            reserved < 0 || earned < 0 || reserved > earned) {
          throw new HttpError(409, 'বিক্রেতার বর্তমান earned balance দিয়ে সব payout reservation সমর্থিত নয়');
        }
      }

      const timestamp = now();
      const changed = await q("UPDATE payouts SET status=?,note=?,decided_at=? WHERE id=? AND status='REQUESTED'")
        .run(status,note,timestamp,payout.id);
      if (changed.changes !== 1) throw new HttpError(409, 'এই পেআউটের সিদ্ধান্ত আগেই দেওয়া হয়েছে');
      await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id(),user.id,'PAYOUT_' + status,'payout',payout.id,JSON.stringify({ seller_id:payout.seller_id,amount_paisa:Number(payout.amount_paisa),note }),timestamp);
      await q('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
        .run(id(),payout.seller_id,status === 'APPROVED' ? 'পেআউট সম্পন্ন' : 'পেআউট প্রত্যাখ্যাত',
          note || (status === 'APPROVED' ? 'আপনার পেআউট অনুমোদিত হয়েছে' : 'আপনার পেআউট অনুরোধটি গ্রহণ করা হয়নি'),timestamp);
      return ok({ id:payout.id,status,decided_at:timestamp });
    });
  });
}
