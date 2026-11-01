import { HttpError, config, bdt, orderNo } from './core.mjs';
import { initiateGateway, signCallback, verifySignature } from './gateways.mjs';
import { createPostgresInventoryRepository } from './postgres-inventory.mjs';
import { createPostgresCheckoutRepository } from './postgres-checkout.mjs';
import { createPostgresOrdersPaymentsRepository } from './postgres-orders-payments.mjs';
import { createPostgresCustomerRepository } from './postgres-customer.mjs';

function toHttpError(error) {
  if (error instanceof HttpError) return error;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    return new HttpError(error.status, error.message, { code: error.code });
  }
  if (error instanceof TypeError) return new HttpError(400, error.message);
  return error;
}
function invoke(ok, callback, status = 200) {
  return async context => {
    try { return ok(await callback(context), status); }
    catch (error) { throw toHttpError(error); }
  };
}
function orderCard(order) {
  return {
    id: order.id,
    orderNumber: orderNo(order.id),
    total_bdt: bdt(Number(order.total_paisa)),
    subtotal_bdt: bdt(Number(order.subtotal_paisa)),
    shipping_bdt: bdt(Number(order.shipping_paisa)),
    discount_bdt: bdt(Number(order.discount_paisa)),
    status: order.status,
    payment: { method: order.payment_method, status: order.payment_status },
    created_at: order.created_at
  };
}
function sellerOrderCard(order) {
  return {
    id: order.id,
    orderNumber: orderNo(order.order_id),
    status: order.status,
    subtotal_bdt: bdt(Number(order.subtotal_paisa)),
    commission_bdt: bdt(Number(order.commission_paisa)),
    net_bdt: bdt(Number(order.net_paisa)),
    created_at: order.created_at,
    payment: { method: order.payment_method, status: order.payment_status },
    customer: { name: order.customer_name, phone: order.customer_phone },
    delivery: {
      name: order.delivery_name,
      phone: order.delivery_phone,
      address: order.delivery_address,
      area: order.delivery_area,
      note: order.customer_note
    }
  };
}
function onlineMethod(value) {
  const method = String(value || '').toUpperCase();
  if (!['BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ'].includes(method)) throw new HttpError(400, 'অনলাইন পেমেন্ট পদ্ধতি দিন');
  return method;
}

export function createPostgresDomainRepositories(database, options = {}) {
  return Object.freeze({
    inventory: options.inventoryRepository || createPostgresInventoryRepository(database, options.inventoryOptions),
    checkout: options.checkoutRepository || createPostgresCheckoutRepository(database, {
      shippingForPaisa: options.shippingForPaisa,
      ...(options.checkoutOptions || {})
    }),
    orders: options.ordersRepository || createPostgresOrdersPaymentsRepository(database, options.ordersOptions),
    customer: options.customerRepository || createPostgresCustomerRepository(database)
  });
}

export default function registerPostgresDomain(route, ok, {
  repositories,
  gatewayInitiate = initiateGateway,
  gatewayVerify = verifySignature,
  gatewaySign = signCallback,
  paymentMode = config.paymentMode
} = {}) {
  if (!repositories?.inventory || !repositories?.checkout || !repositories?.orders) {
    throw new TypeError('PostgreSQL domain repositories are required');
  }
  const { inventory, checkout, orders, customer } = repositories;
  if (!customer) throw new TypeError('PostgreSQL customer repository is required');

  // ----- customer addresses, wishlist and verified-purchase reviews -----
  route('GET', '/api/v1/customer/addresses', ['CUSTOMER'], invoke(ok, async ({ user }) => customer.listAddresses(user.id)));
  route('POST', '/api/v1/customer/addresses', ['CUSTOMER'], invoke(ok, async ({ user, body }) => customer.createAddress({ user, body }), 201));
  route('PUT', '/api/v1/customer/addresses/:id', ['CUSTOMER'], invoke(ok, async ({ user, params, body }) => customer.updateAddress({ user, addressId: params[0], body })));
  route('DELETE', '/api/v1/customer/addresses/:id', ['CUSTOMER'], invoke(ok, async ({ user, params }) => customer.deleteAddress(user.id, params[0])));
  route('GET', '/api/v1/customer/wishlist', ['CUSTOMER'], invoke(ok, async ({ user }) => customer.listWishlist(user.id)));
  route('POST', '/api/v1/customer/wishlist', ['CUSTOMER'], invoke(ok, async ({ user, body }) => customer.addWishlist(user.id, body.productId), 201));
  route('DELETE', '/api/v1/customer/wishlist/:pid', ['CUSTOMER'], invoke(ok, async ({ user, params }) => customer.removeWishlist(user.id, params[0])));
  route('POST', '/api/v1/customer/products/:id/reviews', ['CUSTOMER'], invoke(ok, async ({ user, params, body }) => customer.saveReview({ userId: user.id, productId: params[0], body }), 201));

  // ----- shared stock ledger / seller inventory -----
  route('GET', '/api/v1/seller/products/:id/inventory', ['SELLER'], invoke(ok, async ({ user, params }) => {
    const stock = await inventory.getStock(params[0]);
    if (!stock || stock.seller_id !== user.id) throw new HttpError(404, 'Product not found');
    return stock;
  }));
  route('PATCH', '/api/v1/seller/products/:id/stock', ['SELLER'], invoke(ok, async ({ user, params, body }) => {
    const current = await inventory.getStock(params[0]);
    if (!current || current.seller_id !== user.id) throw new HttpError(404, 'Product not found');
    const result = await inventory.setStock({
      productId: params[0], stock: body.stock, reason: 'SELLER_STOCK_SET',
      actorId: user.id, reference: body.reference
    });
    return { id: params[0], stock: result.stock };
  }));
  route('GET', '/api/v1/admin/inventory/:productId', ['ADMIN'], invoke(ok, async ({ params }) => {
    const stock = await inventory.getStock(params[0]);
    if (!stock) throw new HttpError(404, 'Product not found');
    return stock;
  }));
  route('GET', '/api/v1/admin/inventory/:productId/movements', ['ADMIN'], invoke(ok, async ({ params, url }) => ({
    items: await inventory.listMovements({
      productId: params[0], limit: Number(url.searchParams.get('limit') || 50),
      beforeCreatedAt: url.searchParams.get('before_created_at') || undefined,
      beforeId: url.searchParams.get('before_id') || undefined
    })
  })));
  route('POST', '/api/v1/admin/inventory/:productId/adjust', ['ADMIN'], invoke(ok, async ({ user, params, body }) =>
    inventory.adjustStock({
      productId: params[0], delta: body.delta, reason: body.reason,
      actorId: user.id, reference: body.reference
    }), 201));
  route('PATCH', '/api/v1/admin/products/:id/stock', ['ADMIN'], invoke(ok, async ({ user, params, body }) => {
    const result = await inventory.setStock({
      productId: params[0], stock: body.stock, reason: 'ADMIN_STOCK_SET',
      actorId: user.id, reference: body.reference
    });
    return { id: params[0], stock: result.stock };
  }));

  // ----- customer cart -----
  const cartView = cart => ({
    items: cart.items.map(item => ({
      ...item,
      unit_price_bdt: bdt(item.unit_price_paisa),
      line_total_bdt: bdt(item.line_total_paisa)
    })),
    subtotal_bdt: bdt(cart.subtotal_paisa),
    item_count: cart.item_count
  });
  route('GET', '/api/v1/customer/cart', ['CUSTOMER'], invoke(ok, async ({ user }) => cartView(await checkout.getCart(user.id))));
  route('PUT', '/api/v1/customer/cart', ['CUSTOMER'], invoke(ok, async ({ user, body }) => {
    const quantity = Number(body.quantity);
    const cart = quantity === 0
      ? await checkout.removeItem(user.id, body.productId)
      : await checkout.setItemQuantity(user.id, body.productId, quantity);
    return cartView(cart);
  }));
  route('DELETE', '/api/v1/customer/cart/:pid', ['CUSTOMER'], invoke(ok, async ({ user, params }) =>
    cartView(await checkout.removeItem(user.id, params[0]))));
  route('DELETE', '/api/v1/customer/cart', ['CUSTOMER'], invoke(ok, async ({ user }) =>
    cartView(await checkout.clearCart(user.id))));

  // ----- coupons / checkout -----
  route('POST', '/api/v1/coupons/validate', ['CUSTOMER'], invoke(ok, async ({ body }) => {
    const subtotal = Math.round(Number(body.subtotal_bdt || 0) * 100);
    if (!Number.isSafeInteger(subtotal) || subtotal < 0) throw new HttpError(400, 'সাবটোটাল সঠিক নয়');
    const coupon = await checkout.validateCoupon(body.code, subtotal);
    return { code: coupon.code, discount_bdt: bdt(coupon.discount_paisa) };
  }));
  route('POST', '/api/v1/checkout', ['CUSTOMER'], invoke(ok, async ({ user, body }) => {
    const method = String(body.payment_method || 'COD').toUpperCase();
    const created = await checkout.checkout({
      userId: user.id,
      items: Array.isArray(body.items) ? body.items : undefined,
      delivery: body.delivery,
      paymentMethod: method,
      couponCode: body.coupon_code || null
    });
    let payment = { method, status: 'PENDING' };
    if (method !== 'COD') {
      const selected = onlineMethod(method);
      const gateway = gatewayInitiate(selected, { id: created.payment_id, total_paisa: created.total_paisa });
      await orders.setPaymentInitiated({
        userId: user.id, paymentId: created.payment_id,
        gatewayTxnId: gateway.gatewayTxnId,
        raw: { sandbox: Boolean(gateway.sandbox), redirect_url: gateway.redirectUrl }
      });
      payment = {
        id: created.payment_id, method: selected, status: 'INITIATED',
        gateway_txn_id: gateway.gatewayTxnId,
        redirect_url: gateway.sandbox
          ? '/api/v1/payments/sandbox/' + created.payment_id + '/simulate'
          : gateway.redirectUrl,
        sandbox: Boolean(gateway.sandbox)
      };
    }
    return {
      id: created.id, orderNumber: orderNo(created.id),
      total_bdt: bdt(created.total_paisa),
      subtotal_bdt: bdt(created.subtotal_paisa),
      shipping_bdt: bdt(created.shipping_paisa),
      discount_bdt: bdt(created.discount_paisa),
      status: created.status, payment
    };
  }, 201));

  // ----- customer order history and status -----
  route('GET', '/api/v1/customer/orders', ['CUSTOMER'], invoke(ok, async ({ user }) =>
    (await orders.listCustomerOrders(user.id)).map(order => ({
      ...order,
      total_bdt: bdt(order.total_paisa),
      subtotal_bdt: bdt(order.subtotal_paisa),
      shipping_bdt: bdt(order.shipping_paisa),
      discount_bdt: bdt(order.discount_paisa)
    }))));
  route('GET', '/api/v1/customer/orders/:id', ['CUSTOMER'], invoke(ok, async ({ user, params }) => {
    const order = await orders.getCustomerOrder(user.id, params[0]);
    if (!order) throw new HttpError(404, 'Order not found');
    return {
      ...orderCard(order),
      delivery: order.delivery,
      items: order.items.map(item => ({ ...item, unit_price_bdt: bdt(item.unit_price_paisa) })),
      suborders: order.seller_orders.map(seller => ({
        id: seller.id, shop: seller.shop_name, status: seller.status,
        subtotal_bdt: bdt(Number(seller.subtotal_paisa))
      }))
    };
  }));
  route('GET', '/api/v1/customer/orders/:id/tracking', ['CUSTOMER'], invoke(ok, async ({ user, params }) => {
    const result = await orders.getTracking(user.id, params[0]);
    if (!result) throw new HttpError(404, 'Order not found');
    return result;
  }));
  route('POST', '/api/v1/customer/orders/:id/cancel', ['CUSTOMER'], invoke(ok, async ({ user, params, body }) =>
    orders.cancelCustomerOrder({
      userId: user.id, orderId: params[0], actorId: user.id,
      note: String(body.reason || '').slice(0, 300)
    })));
  route('POST', '/api/v1/customer/orders/:id/pay', ['CUSTOMER'], invoke(ok, async ({ user, params, body }) => {
    const method = onlineMethod(body.method);
    const pending = await orders.prepareCustomerPayment({ userId: user.id, orderId: params[0], method });
    const gateway = gatewayInitiate(method, { id: pending.id, total_paisa: pending.amount_paisa });
    const initiated = await orders.setPaymentInitiated({
      userId: user.id, paymentId: pending.id,
      gatewayTxnId: gateway.gatewayTxnId,
      raw: { sandbox: Boolean(gateway.sandbox), redirect_url: gateway.redirectUrl }
    });
    return {
      id: initiated.id, method, status: initiated.status,
      gateway_txn_id: initiated.gateway_txn_id,
      redirect_url: gateway.sandbox
        ? '/api/v1/payments/sandbox/' + pending.id + '/simulate'
        : gateway.redirectUrl,
      sandbox: Boolean(gateway.sandbox)
    };
  }));

  // ----- seller and admin order operations -----
  route('GET', '/api/v1/seller/orders', ['SELLER'], invoke(ok, async ({ user, url }) => {
    const rows = await orders.listSellerOrders(user.id, {
      status: url.searchParams.get('status') || undefined,
      limit: Number(url.searchParams.get('limit') || 100)
    });
    return rows.map(row => ({
      ...sellerOrderCard(row),
      items: row.items || undefined
    }));
  }));
  route('GET', '/api/v1/seller/orders/:id', ['SELLER'], invoke(ok, async ({ user, params }) => {
    const row = await orders.getSellerOrder(user.id, params[0]);
    if (!row) throw new HttpError(404, 'Order not found');
    return {
      ...sellerOrderCard(row),
      items: row.items.map(item => ({
        name_bn: item.product_name_bn, quantity: item.quantity,
        unit_price_bdt: bdt(item.unit_price_paisa), variant: item.variant
      })),
      shipment: row.shipment,
      history: row.events
    };
  }));
  route('POST', '/api/v1/seller/orders/:id/status', ['SELLER'], invoke(ok, async ({ user, params, body }) => {
    const status = String(body.status || '').toUpperCase();
    if (!['CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED'].includes(status)) {
      throw new HttpError(400, 'Invalid order status');
    }
    return orders.transitionSellerOrder({
      sellerId: user.id, sellerOrderId: params[0], nextStatus: status,
      actorId: user.id, note: String(body.note || '').slice(0, 300)
    });
  }));
  route('GET', '/api/v1/admin/orders', ['ADMIN'], invoke(ok, async ({ url }) =>
    (await orders.listAdminOrders({
      status: url.searchParams.get('status') || undefined,
      query: url.searchParams.get('q') || undefined,
      limit: Number(url.searchParams.get('limit') || 100)
    })).map(order => ({
      ...orderCard(order),
      customer: { name: order.customer_name, phone: order.customer_phone }
    }))));
  route('GET', '/api/v1/admin/orders/:id', ['ADMIN'], invoke(ok, async ({ params }) => {
    const order = await orders.getAdminOrder(params[0]);
    if (!order) throw new HttpError(404, 'Order not found');
    return {
      ...orderCard(order),
      admin_note: order.admin_note,
      customer: { name: order.customer_name, phone: order.customer_phone },
      history: order.events,
      payments: order.payments.map(payment => ({ ...payment, amount_bdt: bdt(payment.amount_paisa) })),
      sellers: order.seller_orders.map(seller => ({
        id: seller.id, shop: seller.shop_name, status: seller.status,
        subtotal_bdt: bdt(Number(seller.subtotal_paisa)),
        commission_bdt: bdt(Number(seller.commission_paisa))
      }))
    };
  }));
  route('POST', '/api/v1/admin/orders/:id/status', ['ADMIN'], invoke(ok, async ({ user, params, body }) => {
    const status = String(body.status || '').toUpperCase();
    if (!['CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED'].includes(status)) throw new HttpError(400, 'Invalid order status');
    return orders.transitionParentOrder({
      orderId: params[0], nextStatus: status, actorId: user.id,
      note: String(body.note || '').slice(0, 300)
    });
  }));

  // ----- payment lifecycle -----
  route('POST', '/api/v1/payments/callback/:gateway', null, invoke(ok, async ({ params, body }) => {
    const method = String(params[0] || '').toUpperCase();
    if (!['BKASH','NAGAD','ROCKET','SSLCOMMERZ'].includes(method)) throw new HttpError(404, 'Unknown gateway');
    const gatewayTxnId = String(body.gateway_txn_id || '');
    const status = String(body.status || '').toUpperCase();
    const amountPaisa = Math.round(Number(body.amount_bdt) * 100);
    if (!gatewayTxnId || !Number.isSafeInteger(amountPaisa) || amountPaisa <= 0 || !['SUCCESS','FAILED'].includes(status)) {
      throw new HttpError(400, 'Invalid callback payload');
    }
    if (!gatewayVerify({ gatewayTxnId, amountPaisa, status }, body.signature)) {
      throw new HttpError(401, 'Invalid gateway signature');
    }
    return orders.recordVerifiedPaymentCallback({ method, gatewayTxnId, amountPaisa, status });
  }));
  route('GET', '/api/v1/payments/:id/status', ['CUSTOMER'], invoke(ok, async ({ user, params }) => {
    const payment = await orders.getCustomerPayment(user.id, params[0]);
    if (!payment) throw new HttpError(404, 'Payment not found');
    return { id: payment.id, method: payment.method, status: payment.status, amount_bdt: bdt(payment.amount_paisa) };
  }));
  route('POST', '/api/v1/payments/sandbox/:id/simulate', ['CUSTOMER'], invoke(ok, async ({ user, params, body }) => {
    if (paymentMode !== 'sandbox') throw new HttpError(404, 'Not found');
    const payment = await orders.getCustomerPayment(user.id, params[0]);
    if (!payment) throw new HttpError(404, 'Payment not found');
    if (payment.status !== 'INITIATED' || !payment.gateway_txn_id) throw new HttpError(409, 'এই পেমেন্ট আর চালু নেই');
    const status = body.outcome === 'fail' ? 'FAILED' : 'SUCCESS';
    const amountPaisa = payment.amount_paisa;
    const signature = gatewaySign({ gatewayTxnId: payment.gateway_txn_id, amountPaisa, status });
    if (!gatewayVerify({ gatewayTxnId: payment.gateway_txn_id, amountPaisa, status }, signature)) {
      throw new HttpError(401, 'Invalid gateway signature');
    }
    return { sandbox: true, ...await orders.recordVerifiedPaymentCallback({
      method: payment.method, gatewayTxnId: payment.gateway_txn_id, amountPaisa, status
    }) };
  }));
}
