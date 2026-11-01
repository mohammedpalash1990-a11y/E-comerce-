import { randomUUID } from 'node:crypto';

function fail(status, code, message) { const error = new Error(message); error.status=status; error.code=code; return error; }
function integer(value,label) { const n=typeof value==='number'?value:Number(value); if(!Number.isSafeInteger(n)) throw fail(500,'INVALID_DATABASE_VALUE',label+' is not a safe integer'); return n; }
function limit(value, fallback=100) { const n=Number(value??fallback); return Number.isInteger(n)?Math.min(Math.max(n,1),500):fallback; }
function money(value) { return integer(value??0,'money')/100; }

export function createPostgresAdminRepository(database,{createId=randomUUID,clock=()=>new Date().toISOString()}={}) {
  if(!database||typeof database.q!=='function'||typeof database.tx!=='function') throw new TypeError('A PostgreSQL database adapter with q() and tx() is required');
  const query=sql=>database.q(sql), stamp=()=>clock(), makeId=()=>createId();

  async function listPayouts({status,limit:pageSize=200}={}) {
    const state=status?String(status).toUpperCase():null;
    if(state&&!['REQUESTED','APPROVED','REJECTED'].includes(state)) throw fail(400,'INVALID_PAYOUT_STATUS','পেআউট স্ট্যাটাস সঠিক নয়');
    const rows=await query('SELECT p.id,p.seller_id,p.amount_paisa,p.method,p.account,p.status,p.note,p.created_at,p.decided_at,sp.shop_name FROM payouts p LEFT JOIN seller_profiles sp ON sp.user_id=p.seller_id'+(state?' WHERE p.status=?':'')+' ORDER BY p.created_at DESC,p.id DESC LIMIT ?').all(...(state?[state,limit(pageSize,200)]:[limit(pageSize,200)]));
    return rows.map(row=>({...row,amount_bdt:money(row.amount_paisa)}));
  }

  async function decidePayout({payoutId,actorId,decision,note=''}) {
    const action=String(decision||'').toUpperCase();
    if(!['APPROVE','REJECT'].includes(action)) throw fail(400,'INVALID_DECISION','পেআউট সিদ্ধান্ত সঠিক নয়');
    const cleanNote=String(note??'').trim().slice(0,300), at=stamp();
    return database.tx(async()=>{
      const payout=await query("SELECT id,seller_id,amount_paisa,status FROM payouts WHERE id=? FOR UPDATE").get(String(payoutId));
      if(!payout||payout.status!=='REQUESTED') throw fail(409,'PAYOUT_NOT_PENDING','পেআউট অনুরোধটি আর pending নেই');
      if(action==='APPROVE') {
        const totals=await query("SELECT COALESCE(SUM(amount_paisa),0) reserved FROM payouts WHERE seller_id=? AND status='APPROVED'").get(payout.seller_id);
        const earnings=await query("SELECT COALESCE(SUM(amount_paisa),0) earned FROM transactions WHERE seller_id=? AND kind IN ('SELLER_EARNING','SELLER_REVERSAL')").get(payout.seller_id);
        const reserved=integer(totals.reserved||0,'reserved'), earned=integer(earnings.earned||0,'earned'), amount=integer(payout.amount_paisa,'payout.amount_paisa');
        if(amount>earned-reserved) throw fail(409,'INSUFFICIENT_BALANCE','পেআউট অনুমোদনের জন্য পর্যাপ্ত balance নেই');
        await query("UPDATE payouts SET status='APPROVED',decided_at=?,note=? WHERE id=? AND status='REQUESTED'").run(at,cleanNote,String(payoutId));
        await query('INSERT INTO transactions(id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at) VALUES(?,?,?,?,?,?,?,?)').run(makeId(),'PAYOUT',null,null,payout.seller_id,-amount,String(payoutId),at);
        await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)').run(makeId(),payout.seller_id,'পেআউট অনুমোদিত',money(amount)+' টাকা',at);
      } else {
        await query("UPDATE payouts SET status='REJECTED',decided_at=?,note=? WHERE id=? AND status='REQUESTED'").run(at,cleanNote,String(payoutId));
        await query('INSERT INTO notifications(id,user_id,title,body,read,created_at) VALUES(?,?,?,?,0,?)').run(makeId(),payout.seller_id,'পেআউট প্রত্যাখ্যাত',cleanNote||'আপনার পেআউট অনুরোধটি অনুমোদিত হয়নি',at);
      }
      await query('INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(makeId(),String(actorId),action==='APPROVE'?'PAYOUT_APPROVED':'PAYOUT_REJECTED','payout',String(payoutId),JSON.stringify({seller_id:payout.seller_id,amount_paisa:payout.amount_paisa,note:cleanNote}),at);
      return {id:String(payoutId),status:action==='APPROVE'?'APPROVED':'REJECTED'};
    });
  }

  async function financeSummary() {
    const row=await query(`SELECT
      COALESCE((SELECT SUM(total_paisa) FROM orders WHERE status NOT IN ('CANCELLED','AWAITING_PAYMENT')),0) gross,
      COALESCE((SELECT SUM(amount_paisa) FROM refunds WHERE status='APPROVED'),0) refunds,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE kind='COMMISSION'),0) commission,
      COALESCE((SELECT SUM(amount_paisa) FROM transactions WHERE kind IN ('SELLER_EARNING','SELLER_REVERSAL')),0) seller_earnings,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE status='APPROVED'),0) paid_out,
      COALESCE((SELECT SUM(amount_paisa) FROM payouts WHERE status='REQUESTED'),0) pending_payouts,
      COALESCE((SELECT SUM(net_paisa) FROM seller_orders WHERE status IN ('CONFIRMED','PROCESSING','SHIPPED')),0) seller_pending`).get();
    const gross=integer(row.gross,'gross'),refunds=integer(row.refunds,'refunds');
    return {gross_sales_bdt:money(gross),refunds_bdt:money(refunds),net_sales_bdt:money(gross-refunds),platform_commission_bdt:money(row.commission),seller_earned_bdt:money(row.seller_earnings),seller_available_balance_bdt:money(integer(row.seller_earnings,'seller_earnings')-integer(row.paid_out,'paid_out')-integer(row.pending_payouts,'pending_payouts')),seller_pending_balance_bdt:money(row.seller_pending),paid_out_bdt:money(row.paid_out),pending_payouts_bdt:money(row.pending_payouts)};
  }

  async function listTransactions({kind,limit:pageSize=200}={}) {
    const selected=kind?String(kind).toUpperCase():null;
    const rows=await query('SELECT id,kind,order_id,seller_order_id,seller_id,amount_paisa,ref,created_at FROM transactions'+(selected?' WHERE kind=?':'')+' ORDER BY created_at DESC,id DESC LIMIT ?').all(...(selected?[selected,limit(pageSize,200)]:[limit(pageSize,200)]));
    return rows.map(row=>({...row,amount_bdt:money(row.amount_paisa)}));
  }

  async function financeReport({from='0000-01-01',to='9999-12-31'}={}) {
    const start=String(from).slice(0,10),end=String(to).slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end) throw fail(400,'INVALID_DATE_RANGE','তারিখের সীমা সঠিক নয়');
    const rows=await query("SELECT substr(created_at,1,10) day,COUNT(*) orders,COALESCE(SUM(total_paisa),0) gross FROM orders WHERE status NOT IN('CANCELLED','AWAITING_PAYMENT') AND created_at>=? AND created_at<? GROUP BY substr(created_at,1,10) ORDER BY day").all(start,end+'T99');
    return rows.map(row=>({day:row.day,orders:integer(row.orders,'orders'),gross_bdt:money(row.gross)}));
  }

  async function listAuditLogs({limit:pageSize=200}={}) {
    return query('SELECT id,actor_id,action,entity,entity_id,detail,created_at FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT ?').all(limit(pageSize,200));
  }

  async function dashboard() {
    const row=await query(`SELECT
      (SELECT COALESCE(SUM(total_paisa),0) FROM orders WHERE payment_status='PAID' AND status<>'CANCELLED') revenue,
      (SELECT COUNT(*) FROM orders WHERE status<>'AWAITING_PAYMENT') orders,
      (SELECT COUNT(*) FROM users WHERE role='CUSTOMER') customers,
      (SELECT COUNT(*) FROM seller_profiles) sellers,
      (SELECT COUNT(*) FROM seller_profiles WHERE status='PENDING') pending_sellers,
      (SELECT COUNT(*) FROM products WHERE status='PENDING_REVIEW') pending_products,
      (SELECT COUNT(*) FROM products WHERE status<>'ARCHIVED') products,
      (SELECT COUNT(*) FROM products WHERE status='ACTIVE' AND active=1) active_products,
      (SELECT COUNT(*) FROM orders WHERE status='CANCELLED') cancelled_orders,
      (SELECT COUNT(*) FROM payouts WHERE status='REQUESTED') pending_payouts,
      (SELECT COALESCE(SUM(amount_paisa),0) FROM payouts WHERE status='REQUESTED') pending_payout_amount,
      (SELECT COALESCE(SUM(amount_paisa),0) FROM transactions WHERE kind='COMMISSION') commission`).get();
    return {total_revenue_bdt:money(row.revenue),total_orders:integer(row.orders,'orders'),total_customers:integer(row.customers,'customers'),total_sellers:integer(row.sellers,'sellers'),pending_seller_applications:integer(row.pending_sellers,'pending_sellers'),pending_product_approvals:integer(row.pending_products,'pending_products'),total_products:integer(row.products,'products'),active_products:integer(row.active_products,'active_products'),cancelled_orders:integer(row.cancelled_orders,'cancelled_orders'),pending_payouts:integer(row.pending_payouts,'pending_payouts'),pending_payout_amount_bdt:money(row.pending_payout_amount),platform_commission_bdt:money(row.commission)};
  }

  return Object.freeze({listPayouts,decidePayout,financeSummary,listTransactions,financeReport,listAuditLogs,dashboard});
}
