-- Migration: Add coupon_type column to menus
-- Stores the HPB coupon target type: 'new', 'repeat', 'all', or NULL for regular menus
ALTER TABLE menus ADD COLUMN coupon_type TEXT;
