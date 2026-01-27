-- AlterTable
ALTER TABLE "public"."auth_user" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "permissions" JSONB,
ADD COLUMN     "role" TEXT;
