import { randomBytes } from 'node:crypto';

export const COURIERS = ['PATHAO', 'STEADFAST', 'REDX'];
export const SHIPMENT_STATUSES = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED'];
const isDhaka = area => /dhaka|ঢাকা/i.test(area || '');
function liveGuard(provider) {
  if ((process.env.COURIER_MODE || 'sandbox') === 'sandbox') return;
  if (!process.env[provider + '_API_KEY']) {
    const error = new Error(provider + ' API credentials কনফিগার করা নেই'); error.status = 503; throw error;
  }
  const error = new Error(provider + ' লাইভ adapter এখনও যাচাইকৃত নয়; Sandbox mode ব্যবহার করুন'); error.status = 501; throw error;
}
export function courierQuote(provider, area) {
  if (!COURIERS.includes(provider)) { const error = new Error('অজানা কুরিয়ার'); error.status = 400; throw error; }
  liveGuard(provider);
  return (isDhaka(area) ? 6000 : 12000) + { PATHAO: 0, STEADFAST: -1000, REDX: 500 }[provider];
}
export function courierBook(provider, area) {
  const charge = courierQuote(provider, area);
  return { trackingId: provider.slice(0, 2) + '-' + randomBytes(5).toString('hex').toUpperCase(), status: 'BOOKED', charge };
}
