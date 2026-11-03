import { HttpError } from './postgres-shared.mjs';

const bdt = value => Number(value || 0) / 100;
const integer = value => Number(value || 0);

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
}
