import { randomBytes } from 'node:crypto';
import { config, HttpError, hmac, safeEq } from './core.mjs';

export const PAYMENT_METHODS = ['COD', 'BKASH', 'NAGAD', 'ROCKET', 'SSLCOMMERZ'];
export const COURIERS = ['PATHAO', 'STEADFAST', 'REDX'];
const isDhaka = area => /dhaka|ঢাকা/i.test(area || '');

export function shippingFor(area, subtotalPaisa) {
  if (config.freeShippingPaisa > 0 && subtotalPaisa >= config.freeShippingPaisa) return 0;
  return isDhaka(area) ? 6000 : 12000;
}

// ---- Payment adapters. Sandbox mode is fully simulated; live mode needs real merchant credentials. ----
export function initiateGateway(method, payment) {
  if (config.paymentMode !== 'sandbox') {
    const need = { BKASH: 'BKASH_APP_KEY', NAGAD: 'NAGAD_MERCHANT_ID', ROCKET: 'ROCKET_MERCHANT_ID', SSLCOMMERZ: 'SSLCOMMERZ_STORE_ID' }[method];
    if (!process.env[need]) throw new HttpError(503, method + ' লাইভ গেটওয়ে কনফিগার করা নেই (merchant credentials প্রয়োজন)');
    throw new HttpError(501, method + ' লাইভ adapter এখনও যাচাইকৃত নয়; Sandbox mode ব্যবহার করুন');
  }
  return { gatewayTxnId: 'SBX-' + method + '-' + randomBytes(6).toString('hex').toUpperCase(), redirectUrl: '/api/v1/payments/sandbox/' + payment.id, sandbox: true };
}
export const signCallback = ({ gatewayTxnId, amountPaisa, status }) => hmac(config.webhookSecret, [gatewayTxnId, amountPaisa, status].join('|'));
export const verifySignature = (p, sig) => typeof sig === 'string' && safeEq(signCallback(p), sig);

// ---- Courier adapters (Pathao / Steadfast / RedX) ----
function liveGuard(provider) {
  if (config.courierMode === 'sandbox') return;
  if (!process.env[provider + '_API_KEY']) throw new HttpError(503, provider + ' API credentials কনফিগার করা নেই');
  throw new HttpError(501, provider + ' লাইভ adapter এখনও যাচাইকৃত নয়; Sandbox mode ব্যবহার করুন');
}
export function courierQuote(provider, area) {
  if (!COURIERS.includes(provider)) throw new HttpError(400, 'অজানা কুরিয়ার');
  liveGuard(provider);
  return (isDhaka(area) ? 6000 : 12000) + { PATHAO: 0, STEADFAST: -1000, REDX: 500 }[provider];
}
export function courierBook(provider, area) {
  const charge = courierQuote(provider, area);
  return { trackingId: provider.slice(0, 2) + '-' + randomBytes(5).toString('hex').toUpperCase(), status: 'BOOKED', charge };
}
export const SHIPMENT_STATUSES = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED'];
