import { HttpError } from './postgres-shared.mjs';

// Pure order lifecycle policy shared by SQLite and PostgreSQL adapters.
export const TRANSITIONS = Object.freeze({
  AWAITING_PAYMENT: Object.freeze(['CONFIRMED', 'CANCELLED']),
  CONFIRMED: Object.freeze(['PROCESSING', 'CANCELLED']),
  PROCESSING: Object.freeze(['SHIPPED', 'CANCELLED']),
  SHIPPED: Object.freeze(['DELIVERED'])
});

export const conflict = () => new HttpError(409, 'এই অর্ডারের বর্তমান অবস্থা থেকে এই পরিবর্তন করা যাবে না');
export const canTransition = (current, next) => (TRANSITIONS[current] || []).includes(next);
