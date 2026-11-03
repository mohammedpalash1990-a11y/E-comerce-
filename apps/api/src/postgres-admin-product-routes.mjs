import { randomUUID } from 'node:crypto';
import { HttpError, text, now as defaultNow } from './postgres-shared.mjs';

const STATUSES = ['PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED'];
const transitions = {
  approve: { from: 'PENDING_REVIEW', to: 'ACTIVE' },
  reject: { from: 'PENDING_REVIEW', to: 'REJECTED' },
  suspend: { from: 'ACTIVE', to: 'SUSPENDED' },
  unsuspend: { from: 'SUSPENDED', to: 'ACTIVE' }
};

export function registerPostgresAdminProductRoutes(route, ok, { database, id = randomUUID, now = defaultNow } = {}) {
  if (!database?.q || !database?.tx) throw new TypeError('PostgreSQL database is required');
  const q = sql => database.q(sql);
  const productProjection = `p.id,p.name_bn,p.name_en,p.price_paisa,p.discount_paisa,p.stock,p.status,p.sku,p.description,
    p.seller_id,c.slug AS category_slug,COALESCE(sp.shop_name,u.name) AS seller_name,
    (SELECT i.url FROM product_images i WHERE i.product_id=p.id ORDER BY i.position LIMIT 1) AS image`;
  const limitFrom = url => Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 300);

  route('GET', '/api/v1/admin/products', ['ADMIN'], async ({ url }) => {
    const status = String(url.searchParams.get('status') || '').toUpperCase();
    if (status && !STATUSES.includes(status)) throw new HttpError(400, 'পণ্যের স্ট্যাটাস সঠিক নয়');
    const term = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    const clauses = ["p.status<>'ARCHIVED'"], values = [];
    if (status) { clauses.push('p.status=?'); values.push(status); }
    if (term) { clauses.push('(p.name_bn ILIKE ? OR p.name_en ILIKE ? OR COALESCE(p.sku,\'\') ILIKE ?)'); values.push('%'+term+'%','%'+term+'%','%'+term+'%'); }
    const limit = limitFrom(url);
    const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
    const rows = await q(`SELECT ${productProjection} FROM products p
      LEFT JOIN categories c ON c.id=p.category_id
      LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id
      LEFT JOIN users u ON u.id=p.seller_id
      WHERE ${clauses.join(' AND ')} ORDER BY CASE p.status WHEN 'PENDING_REVIEW' THEN 0 ELSE 1 END,p.created_at DESC,p.id DESC
      LIMIT ? OFFSET ?`).all(...values, limit, offset);
    return ok(rows.map(row => ({ ...row, price_paisa: Number(row.price_paisa), price_bdt: Number(row.price_paisa)/100,
      discount_paisa: row.discount_paisa == null ? null : Number(row.discount_paisa),
      discount_price_bdt: row.discount_paisa == null ? null : Number(row.discount_paisa)/100,
      stock: Number(row.stock) })));
  });

  route('GET', '/api/v1/admin/products/pending', ['ADMIN'], async () => {
    const rows = await q(`SELECT ${productProjection} FROM products p
      LEFT JOIN categories c ON c.id=p.category_id
      LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id
      LEFT JOIN users u ON u.id=p.seller_id
      WHERE p.status='PENDING_REVIEW' ORDER BY p.created_at,p.id LIMIT 300`).all();
    return ok(rows.map(row => ({ ...row, price_paisa: Number(row.price_paisa), price_bdt: Number(row.price_paisa)/100,
      discount_paisa: row.discount_paisa == null ? null : Number(row.discount_paisa),
      discount_price_bdt: row.discount_paisa == null ? null : Number(row.discount_paisa)/100,
      stock: Number(row.stock) })));
  });

  for (const [action, transition] of Object.entries(transitions)) {
    route('POST', '/api/v1/admin/products/:id/' + action, ['ADMIN'], async ({ user, params, body }) => {
      const reason = text(body.reason, 300, 'কারণ', { required: false });
      return database.tx(async () => {
        const product = await q('SELECT id,seller_id,status FROM products WHERE id=? FOR UPDATE').get(params[0]);
        if (!product || product.status === 'ARCHIVED') throw new HttpError(404, 'পণ্যটি পাওয়া যায়নি');
        if (product.status !== transition.from) throw new HttpError(409, 'পণ্যের বর্তমান স্ট্যাটাসে এই সিদ্ধান্ত দেওয়া যাবে না');
        if (transition.to === 'ACTIVE') {
          const seller = await q('SELECT sp.status,u.status AS account_status FROM seller_profiles sp JOIN users u ON u.id=sp.user_id WHERE sp.user_id=?').get(product.seller_id);
          if (seller?.status !== 'APPROVED' || seller?.account_status !== 'ACTIVE') throw new HttpError(409, 'আগে বিক্রেতা ও অ্যাকাউন্ট অনুমোদিত হতে হবে');
        }
        const timestamp = now();
        await q('UPDATE products SET status=?,active=?,updated_at=? WHERE id=?')
          .run(transition.to, transition.to === 'ACTIVE' ? 1 : 0, timestamp, product.id);
        await q('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id(), user.id, 'PRODUCT_' + transition.to, 'product', product.id,
            JSON.stringify({ from: transition.from, to: transition.to, reason }), timestamp);
        await q('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)')
          .run(id(), product.seller_id, 'পণ্যের স্ট্যাটাস: ' + transition.to,
            reason || (transition.to === 'ACTIVE' ? 'আপনার পণ্য অনুমোদিত হয়েছে' : 'আপনার পণ্যের স্ট্যাটাস পরিবর্তন হয়েছে'), timestamp);
        return ok({ id: product.id, status: transition.to });
      });
    });
  }
}
