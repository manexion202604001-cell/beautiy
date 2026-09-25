-- AlterTable
ALTER TABLE "Appointment" ALTER COLUMN "manageToken" SET DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

