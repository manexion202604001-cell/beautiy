-- Add owner type and company info columns to staff table
ALTER TABLE staff ADD COLUMN owner_type TEXT DEFAULT NULL;
ALTER TABLE staff ADD COLUMN company_name TEXT DEFAULT NULL;
ALTER TABLE staff ADD COLUMN company_postal_code TEXT DEFAULT NULL;
ALTER TABLE staff ADD COLUMN company_phone TEXT DEFAULT NULL;
ALTER TABLE staff ADD COLUMN company_address TEXT DEFAULT NULL;
ALTER TABLE staff ADD COLUMN company_email TEXT DEFAULT NULL;
