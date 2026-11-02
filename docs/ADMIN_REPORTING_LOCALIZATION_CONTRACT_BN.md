# Admin Reporting ও Bengali/English Localization Contract

> **পরিধি:** Admin reporting ও localization-এর implementation specification; এটি কোনো live reporting dashboard যোগ করে না।

## Reporting source of truth
- Orders, seller sub-orders, payment records, immutable transaction ledger, refunds, courier remittance ও payout records পৃথক source।
- Gross sales, net sales, platform commission, seller payable, refund, COD collected ও payout—প্রতিটি metric-এর formula ও inclusion rule documentation-এ প্রকাশ করতে হবে।
- Order created date, delivered date, payment captured date ও payout date আলাদা dimension; report filter-এ কোন timestamp ব্যবহৃত হচ্ছে তা স্পষ্ট label করতে হবে।
- Cancelled, returned, partially refunded এবং unpaid COD order-কে একক sales total-এ অস্পষ্টভাবে মেশানো যাবে না।

## Bangladesh reporting defaults
- Currency: BDT; persist integer paisa, UI-তে locale-aware ৳ formatting।
- Business reporting timezone: `Asia/Dhaka`; database timestamp UTC-তে persist।
- Day boundary server-side timezone library/explicit timezone-aware calculation দিয়ে নির্ধারণ করতে হবে; browser local timezone-এর ওপর নির্ভর নয়।
- Daily report-এ date range inclusive/exclusive semantics স্পষ্ট করতে হবে।

## Admin report controls
- Date range, order status, seller, payment method, fulfilment status এবং refund state filter।
- Pagination ও server-side aggregation; বড় report browser memory-তে সম্পূর্ণ load নয়।
- CSV export-এ UTF-8 BOM বা spreadsheet-compatible encoding, stable column names এবং formula-injection protection।
- Export action actor, filter, timestamp ও row count-সহ audit হবে।
- PII শুধু role প্রয়োজন অনুযায়ী দেখাতে হবে; export permission আলাদা হতে পারে।

## Localization contract
- UI string key-based; Bengali ও English text আলাদা locale resource-এ থাকবে।
- User language preference persist হবে; fallback English/Bengali policy explicit।
- Product title/description-এর bn/en fields আলাদা; missing translation-এ controlled fallback ও language indicator।
- Date, number, currency এবং plural formatting locale-aware।
- Status-এর canonical enum language-neutral; UI label translation map থেকে আসবে।
- Validation error, empty state, loading, confirmation, email/SMS template—সব user-facing copy bilingual review পাবে।
- বাংলা font fallback, line-height, wrapping এবং long product names mobile width-এ test করতে হবে।

## Accessibility & responsive acceptance
- Report filter-এর visible label ও keyboard access।
- Table header semantic; narrow viewport-এ responsive horizontal scroll বা card summary।
- Chart-এর পাশাপাশি textual summary/table alternative।
- Status শুধু color দিয়ে বোঝানো যাবে না।
- Loading/error/empty state screen reader live region-এ ঘোষণা করতে হবে।

## Acceptance criteria
- Dhaka timezone-এ midnight boundary report date সঠিক।
- Refund/return ও unpaid COD metric formula tests-এ আলাদা।
- Currency aggregation integer paisa-তে overflow-safe।
- CSV formula payload spreadsheet formula হিসেবে execute হবে না।
- Bengali ও English একই canonical status enum থেকে consistent label পাবে।
- Seller role অন্য seller-এর finance report/export access করতে পারবে না।

## Integration boundary
বর্তমান README/STATUS নথিতে admin order/product workflow আছে, কিন্তু পূর্ণ financial reporting formula, role-scoped exports ও localization test suite এখনো আলাদা implementation কাজ।