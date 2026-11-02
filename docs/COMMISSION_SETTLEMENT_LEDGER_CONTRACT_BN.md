# Commission ও Seller Settlement Ledger Contract

> **পরিধি:** Financial domain specification। কোনো live bank/MFS payout বা settlement automation চালু করে না।

## হিসাবের ভিত্তি
সব monetary amount integer paisa-তে persist হবে। BDT display-তে 100 paisa = ৳1। হিসাবের পথে JavaScript floating-point ব্যবহার করা যাবে না।

প্রতি seller sub-order:
- `gross_merchandise_paisa`
- `discount_share_paisa`
- `commission_rate_bps`
- `commission_paisa`
- `seller_net_paisa`
- `shipping_fee_paisa` এবং `shipping_subsidy_paisa` (যদি প্রযোজ্য)
- `refund_paisa`, `adjustment_paisa`

Commission basis ও discount allocation policy versioned হতে হবে; historical order-এ পরবর্তী rate change retroactively প্রযোজ্য নয়।

## Immutable ledger
প্রতিটি financial event append-only ledger entry হবে:
`id, seller_id, order_id, seller_order_id, event_type, amount_paisa, currency, reference, idempotency_key, actor_id, created_at`।

- Earning credit, commission debit, refund reversal, courier fee, payout hold/release এবং payout debit আলাদা event type।
- Ledger row edit/delete নয়; correction reversal entry দিয়ে হবে।
- Unique idempotency key duplicate posting ঠেকাবে।
- Ledger balance sum করে derive হবে; cached balance থাকলে transaction-এর মধ্যে reconcile করতে হবে।

## Settlement eligibility
Seller earning payable হবে policy-defined delivery confirmation এবং payment/COD reconciliation সম্পন্ন হলে। শুধুমাত্র seller DELIVERED status বা courier scan যথেষ্ট নয়, যদি customer payment বা courier remittance pending থাকে।

Hold কারণ:
- refund/dispute window
- customer complaint বা fraud review
- courier COD remittance mismatch
- seller KYC/bank/MFS verification pending
- negative balance বা prior adjustment

## Payout lifecycle
`REQUESTED → UNDER_REVIEW → APPROVED → PROCESSING → PAID`; ব্যতিক্রম `REJECTED`, `FAILED`, `CANCELLED`।
প্রতিটি transition actor, timestamp, reason এবং provider reference-সহ audit হবে। Duplicate payout request একই eligible balance reserve অতিক্রম করতে পারবে না।

## Refund ও chargeback
- Refund seller net earning ও platform commission-এ policy অনুযায়ী proportional reversal তৈরি করবে।
- আগে payout হয়ে গেলে seller-এর negative balance/next settlement hold policy প্রয়োগ করতে হবে।
- একই refund provider reference দ্বিতীয়বার ledger posting করতে পারবে না।
- Dispute outcome না আসা পর্যন্ত contested amount hold করা যাবে।

## Reconciliation
Daily reconciliation-এ opening balance + credits - debits = closing balance যাচাই করতে হবে। Order ledger, payment provider, courier COD statement এবং payout provider statement আলাদা source হিসেবে compare করতে হবে। Unmatched item queue-তে থাকবে; নীরবে auto-adjust নয়।

## Acceptance criteria
- Commission rate পরিবর্তনের পর পুরনো order-এর recorded rate অপরিবর্তিত।
- Duplicate delivery/refund/payout event duplicate ledger তৈরি করবে না।
- একই seller-এর concurrent payout request available balance অতিক্রম করবে না।
- Refund seller payable কমাবে এবং audit trail অক্ষুণ্ণ থাকবে।
- Daily ledger equation mismatch হলে settlement batch fail-closed হবে।

## Integration boundary
PostgreSQL checkout/order repositories commission ও earning ledger-এর groundwork রাখে। Full payout request/approval, balance reservation, bank/MFS provider, reconciliation worker এবং live finance tests এখনো প্রয়োজন।