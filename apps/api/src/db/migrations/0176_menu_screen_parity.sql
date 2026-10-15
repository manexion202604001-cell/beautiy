-- =====================================================================
-- 0176 Menu screens (SALOGIC parity, docs/salogic-parity.md)
--   menu_categories.parent_id   two-level categories. A child's name is stored in full as
--                               「親：子」 (the screens group menus by the part before 「：」);
--                               a child always carries its parent's colour.
--   menus.menu_type             'regular' (通常メニュー) / 'coupon' (クーポン = a bookable menu with
--                               its own price and duration, as on HotPepper). Not to be confused
--                               with the discount `coupons` table, which is unchanged.
--   menus.coupon_type           'all' 全員 / 'new' 新規 / 'repeat' 再来 (coupon menus only)
--   menus.presentation_condition 提示条件 (予約時 / 来店時), menus.usage_condition 利用条件
--   menus.expiry_date           有効期限 (shop-local date, inclusive). Expired menus are not bookable.
--   menus.price_tilde           show 「～」 after the price (price is "from")
--   menus.sub_category_ids      every category ticked on the edit form; category_id is the first one
--   menus.image_file_id         (already existed, unused) now references files(id), purpose 'menu_image'
-- =====================================================================
ALTER TABLE menu_categories ADD COLUMN parent_id uuid REFERENCES menu_categories(id);
CREATE INDEX menu_categories_parent_idx ON menu_categories(parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE menus
  ADD COLUMN menu_type text NOT NULL DEFAULT 'regular' CHECK (menu_type IN ('regular','coupon')),
  ADD COLUMN coupon_type text CHECK (coupon_type IS NULL OR coupon_type IN ('all','new','repeat')),
  ADD COLUMN presentation_condition text,
  ADD COLUMN usage_condition text,
  ADD COLUMN expiry_date date,
  ADD COLUMN price_tilde boolean NOT NULL DEFAULT false,
  ADD COLUMN sub_category_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE menus ADD CONSTRAINT menus_image_file_id_fkey FOREIGN KEY (image_file_id) REFERENCES files(id);
