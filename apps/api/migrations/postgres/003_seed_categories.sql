-- Initial marketplace taxonomy. Safe to re-run.
INSERT INTO categories(id,slug,name_bn,name_en) VALUES
('cat-electronics','electronics','ইলেকট্রনিক্স','Electronics'),
('cat-fashion','fashion','ফ্যাশন','Fashion'),
('cat-home','home','ঘর ও জীবন','Home & Living'),
('cat-beauty','beauty','বিউটি ও পার্সোনাল কেয়ার','Beauty & Personal Care'),
('cat-grocery','grocery','গ্রোসারি','Grocery'),
('cat-kids','kids','শিশু ও বেবি','Kids & Baby'),
('cat-sports','sports','খেলাধুলা ও আউটডোর','Sports & Outdoors'),
('cat-books','books','বই ও স্টেশনারি','Books & Stationery')
ON CONFLICT(slug) DO UPDATE SET name_bn=EXCLUDED.name_bn,name_en=EXCLUDED.name_en;
