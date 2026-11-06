import { HttpError } from './postgres-shared.mjs';
import { parseSafePostgresBigInt } from './postgres-types.mjs';

const bdt = value => Number(value || 0) / 100;
const integer = value => Number(value || 0);

function reportPeriod(url) {
  const from = url?.searchParams?.get('from') || '';
  const to = url?.searchParams?.get('to') || '';
  const sellerId = url?.searchParams?.get('seller_id') || null;
  const validDate = value => {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(value + 'T00:00:00.000Z');
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  if (!validDate(from) || !validDate(to)) {
    throw new HttpError(400, 'রিপোর্টের from ও to তারিখ YYYY-MM-DD ফরম্যাটে দিতে হবে');
  }
  const days = (Date.parse(to + 'T00:00:00.000Z') - Date.parse(from + 'T00:00:00.000Z')) / 86400000 + 1;
  if (days < 1 || days > 366) throw new HttpError(400, 'রিপোর্টের তারিখসীমা সর্বোচ্চ ৩৬৬ দিন হতে পারে');
  if (sellerId !== null && (!/^[A-Za-z0-9_-]{1,160}$/.test(sellerId))) {
    throw new HttpError(400, 'বিক্রেতার আইডি সঠিক নয়');
  }
  return { from, to, sellerId };
}

function reportInteger(value) {
  try { return parseSafePostgresBigInt(value ?? 0); }
  catch { throw new HttpError(503, 'রিপোর্টের aggregate নিরাপদ সংখ্যাসীমার বাইরে'); }
}

export function registerPostgresAdminDashboardRoutes(route, ok, { database } = {}) {
  if (!database?.q) throw new TypeError('PostgreSQL database is required');
  route('GET', '/api/v1/admin/dashboard', ['ADMIN'], async () => {
    const row = await database.q(`SELECT
      COALESCE((SELECT SUM(total_paisa) FROM orders WHERE payment_status='PAID' AND status<>'CANCELLED'),0) AS total_revenue_paisa,
      (SELECT COUNT(*) FROM orders WHERE status<>'AWAITING_PAYMENT') AS total_orders,
      (SELECT COUNT(*) FROM users WHERE role='CUSTOMER') AS total_customers,
      (SELECT COUNT(*) FROM seller_profiles) AS total_sellers,
      (SELECT COUNT(*) FROM seller_profiles WHERE status='PENDING') AS pending_seller_applications,
      (SELECT COUNT(*) FROM products WHERE status='PENDING_REVIEW') AS pending_product_approvals,
      (SELECT COUNT(*) FROM products WHERE status<>'ARCHIVED') AS total_products,
      (SELECT COUNT(*) FROM products WHERE status='ACTIVE' AND active=1) AS active_products,
      (SELECT COUNT(*) FROM orders WHERE status='CANCELLED') AS cancelled_orders,
      (SELECT COUNT(*) FROM payouts WHERE status='REQUESTED') AS pending_payouts,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE status='REQUESTED'),0) AS pending_payout_amount_paisa,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE kind='COMMISSION'),0) AS platform_commission_paisa`).get();
    if (!row) throw new HttpError(503, 'ড্যাশবোর্ডের তথ্য পাওয়া যাচ্ছে না');
    return ok({
      total_revenue_bdt: bdt(row.total_revenue_paisa),
      total_orders: integer(row.total_orders),
      total_customers: integer(row.total_customers),
      total_sellers: integer(row.total_sellers),
      pending_seller_applications: integer(row.pending_seller_applications),
      pending_product_approvals: integer(row.pending_product_approvals),
      total_products: integer(row.total_products),
      active_products: integer(row.active_products),
      cancelled_orders: integer(row.cancelled_orders),
      pending_payouts: integer(row.pending_payouts),
      pending_payout_amount_bdt: bdt(row.pending_payout_amount_paisa),
      platform_commission_bdt: bdt(row.platform_commission_paisa)
    });
  });

  route('GET', '/api/v1/admin/reports/summary', ['ADMIN'], async ({ url }) => {
    const period = reportPeriod(url);
    const row = await database.q(`WITH report_params AS (
        SELECT ?::text AS seller_id, ?::date AS start_date, ?::date AS end_date
      ),
      order_scope AS (
        SELECT o.id,o.subtotal_paisa,o.shipping_paisa,o.discount_paisa,o.status,
          o.payment_method,o.payment_status,so.subtotal_paisa AS seller_subtotal_paisa,
          so.coupon_discount_paisa AS seller_discount_paisa
        FROM orders o
        CROSS JOIN report_params rp
        LEFT JOIN seller_orders so ON so.order_id=o.id AND so.seller_id=rp.seller_id
        WHERE o.created_at::timestamptz >= (rp.start_date::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND o.created_at::timestamptz < ((rp.end_date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND (rp.seller_id IS NULL OR so.id IS NOT NULL)
      ),
      order_metrics AS (
        SELECT COUNT(*) AS orders_count,
          COUNT(*) FILTER (WHERE payment_status='PAID' AND status<>'CANCELLED') AS paid_orders_count,
          COUNT(*) FILTER (WHERE status='CANCELLED') AS cancelled_orders_count,
          COUNT(*) FILTER (WHERE payment_method='COD' AND payment_status<>'PAID' AND status<>'CANCELLED') AS unpaid_cod_orders_count,
          COALESCE(SUM(CASE WHEN seller_subtotal_paisa IS NULL THEN subtotal_paisa ELSE seller_subtotal_paisa END)
            FILTER (WHERE payment_status='PAID' AND status<>'CANCELLED'),0) AS gross_merchandise_paisa,
          COALESCE(SUM(CASE WHEN seller_discount_paisa IS NULL THEN discount_paisa ELSE seller_discount_paisa END)
            FILTER (WHERE payment_status='PAID' AND status<>'CANCELLED'),0) AS discounts_paisa,
          COALESCE(SUM(shipping_paisa) FILTER (WHERE payment_status='PAID' AND status<>'CANCELLED'),0) AS shipping_paisa
        FROM order_scope
      ),
      ledger_metrics AS (
        SELECT COALESCE(SUM(amount_paisa) FILTER (WHERE kind='COMMISSION'),0) AS platform_commission_paisa,
          COALESCE(SUM(amount_paisa) FILTER (WHERE kind='SELLER_EARNING'),0) AS seller_earnings_paisa,
          COALESCE(SUM(amount_paisa) FILTER (WHERE kind='SELLER_REVERSAL'),0) AS seller_reversals_paisa
        FROM transactions t
        CROSS JOIN report_params rp
        WHERE t.created_at::timestamptz >= (rp.start_date::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND t.created_at::timestamptz < ((rp.end_date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND (rp.seller_id IS NULL OR t.seller_id=rp.seller_id)
      ),
      refund_metrics AS (
        SELECT COUNT(*) FILTER (WHERE r.status='REQUESTED') AS requested_refund_count,
          COALESCE(SUM(r.amount_paisa) FILTER (WHERE r.status='REQUESTED'),0) AS requested_refund_paisa
        FROM refunds r
        CROSS JOIN report_params rp
        WHERE r.created_at::timestamptz >= (rp.start_date::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND r.created_at::timestamptz < ((rp.end_date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND (rp.seller_id IS NULL OR EXISTS (
            SELECT 1 FROM seller_orders so WHERE so.order_id=r.order_id AND so.seller_id=rp.seller_id
          ))
      ),
      payout_metrics AS (
        SELECT COUNT(*) FILTER (WHERE p.status='REQUESTED') AS requested_payout_count,
          COALESCE(SUM(p.amount_paisa) FILTER (WHERE p.status='REQUESTED'),0) AS requested_payout_paisa,
          COUNT(*) FILTER (WHERE p.status='APPROVED') AS approved_payout_count,
          COALESCE(SUM(p.amount_paisa) FILTER (WHERE p.status='APPROVED'),0) AS approved_payout_paisa,
          COUNT(*) FILTER (WHERE p.status='REJECTED') AS rejected_payout_count,
          COALESCE(SUM(p.amount_paisa) FILTER (WHERE p.status='REJECTED'),0) AS rejected_payout_paisa
        FROM payouts p
        CROSS JOIN report_params rp
        WHERE p.created_at::timestamptz >= (rp.start_date::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND p.created_at::timestamptz < ((rp.end_date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka')
          AND (rp.seller_id IS NULL OR p.seller_id=rp.seller_id)
      )
      SELECT order_metrics.*,ledger_metrics.*,refund_metrics.*,payout_metrics.*,
        (SELECT seller_id FROM report_params) AS seller_id
      FROM order_metrics CROSS JOIN ledger_metrics CROSS JOIN refund_metrics CROSS JOIN payout_metrics
    `).get(period.sellerId, period.from, period.to);
    if (!row) throw new HttpError(503, 'রিপোর্টের তথ্য পাওয়া যাচ্ছে না');

    const gross = reportInteger(row.gross_merchandise_paisa);
    const discounts = reportInteger(row.discounts_paisa);
    const net = gross - discounts;
    if (!Number.isSafeInteger(net) || net < 0) throw new HttpError(503, 'রিপোর্টের net merchandise amount সঠিক নয়');
    const shipping = period.sellerId === null ? reportInteger(row.shipping_paisa) : null;
    const money = value => ({ paisa: value, bdt: bdt(value) });
    return ok({
      period: { from: period.from, to: period.to, time_zone: 'Asia/Dhaka', seller_id: period.sellerId },
      date_basis: {
        orders: 'orders.created_at',
        financial_ledger: 'transactions.created_at',
        refunds: 'refunds.created_at',
        payouts: 'payouts.created_at'
      },
      orders: {
        total: reportInteger(row.orders_count),
        paid: reportInteger(row.paid_orders_count),
        cancelled: reportInteger(row.cancelled_orders_count),
        unpaid_cod: reportInteger(row.unpaid_cod_orders_count)
      },
      sales: {
        gross_merchandise: money(gross),
        discounts: money(discounts),
        net_merchandise: money(net),
        shipping: shipping === null ? null : money(shipping)
      },
      finance: {
        platform_commission: money(reportInteger(row.platform_commission_paisa)),
        seller_earnings: money(reportInteger(row.seller_earnings_paisa)),
        seller_reversals: money(reportInteger(row.seller_reversals_paisa))
      },
      refunds: {
        requested_count: reportInteger(row.requested_refund_count),
        requested_amount: money(reportInteger(row.requested_refund_paisa))
      },
      payouts: {
        requested_count: reportInteger(row.requested_payout_count),
        requested_amount: money(reportInteger(row.requested_payout_paisa)),
        approved_count: reportInteger(row.approved_payout_count),
        approved_amount: money(reportInteger(row.approved_payout_paisa)),
        rejected_count: reportInteger(row.rejected_payout_count),
        rejected_amount: money(reportInteger(row.rejected_payout_paisa))
      }
    });
  });
}
