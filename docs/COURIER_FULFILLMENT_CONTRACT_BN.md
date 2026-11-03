# Courier Fulfilment ও Tracking Contract

> **পরিধি:** Pathao, Steadfast, RedX বা অন্য কোনো courier-এর live API integration নয়; এটি provider-neutral contract।

## Fulfilment ownership
- Seller নিজের sub-order-এর প্রস্তুতি ও handoff status পরিচালনা করবেন।
- Admin courier provider, service type ও exception policy configure করবেন।
- System parent order-এর aggregate status seller sub-order থেকে derive করবে।
- Seller অন্য seller-এর sub-order বা courier consignment পরিবর্তন করতে পারবেন না।

## Lifecycle
`CONFIRMED → PROCESSING → READY_FOR_HANDOFF → HANDED_TO_COURIER → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED`

ব্যতিক্রম: `DELIVERY_FAILED`, `RETURN_REQUESTED`, `RETURN_IN_TRANSIT`, `RETURNED`, `CANCELLED`। Invalid transition reject হবে। Provider event-এর raw status সরাসরি internal status হিসেবে সংরক্ষণ করা যাবে না; adapter mapping ব্যবহার করতে হবে।

## Consignment creation
- Seller order ID, verified delivery name/phone/address, parcel dimensions/weight, COD amount এবং declared value server-side derive হবে।
- COD amount হবে unpaid collectible balance; already-paid amount পুনরায় courier-কে দেওয়া যাবে না।
- Consignment create করার আগে seller order-এর status এবং address completeness যাচাই করতে হবে।
- Provider API call-এর আগে idempotency key persist; retry করলে একই consignment reference recover করতে হবে।

## Webhook ও tracking
- Provider webhook signature/secret verification বাধ্যতামূলক।
- Provider event ID unique; duplicate event tracking history-তে duplicate row তৈরি করবে না।
- Event timestamp, received timestamp, provider status, mapped status, consignment ID ও sanitized payload metadata সংরক্ষণ করতে হবে।
- Out-of-order event এলে history রাখা যাবে, কিন্তু terminal state থেকে invalid backward transition করা যাবে না।
- Customer tracking view-এ শুধুমাত্র নিরাপদ public status ও timestamp দেখাতে হবে; internal phone/address বা courier credentials নয়।

## COD ও settlement
- Courier COD collection এবং seller payable একই জিনিস নয়।
- COD collected amount, courier fee, return fee, adjustment ও remittance আলাদা ledger component হবে।
- Courier remittance statement-এর সঙ্গে internal order/consignment reconciliation করতে হবে।
- Delivery event একা seller payout trigger করবে না; COD remittance reconciliation policy অনুসরণ করতে হবে।

## Exception handling
- Failed delivery-এর reason code, attempt count এবং next action record করতে হবে।
- Return-to-origin stock restoration admin/seller policy ও physical receipt confirmation-এর পরে হবে; courier status alone stock পুনরায় available করবে না।
- Address change delivery handoff-এর পরে হলে audit ও provider capability check বাধ্যতামূলক।

## Acceptance criteria
- Duplicate consignment request একই provider reference ফেরত দেবে।
- অন্য seller-এর order-এ seller action reject হবে।
- Forged webhook tracking/order state বদলাতে পারবে না।
- COD collectible amount order-এর unpaid balance অতিক্রম করবে না।
- Returned parcel physical receipt confirm না হওয়া পর্যন্ত stock available হবে না।

## Integration boundary
বর্তমানে sandbox courier adapter-এর groundwork README-তে উল্লেখ আছে; live provider credentials, webhook verification, production tracking UI, COD remittance reconciliation ও operational runbook আলাদা implementation scope।