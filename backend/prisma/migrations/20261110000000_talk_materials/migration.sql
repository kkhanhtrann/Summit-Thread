-- CreateEnum
CREATE TYPE "TalkMaterialKind" AS ENUM ('text', 'pdf');

-- CreateEnum
CREATE TYPE "TalkMaterialStatus" AS ENUM ('processing', 'ready', 'empty', 'failed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SearchIndexOperation" ADD VALUE 'index_material_passage';
ALTER TYPE "SearchIndexOperation" ADD VALUE 'delete_material';

-- AlterTable
ALTER TABLE "SearchIndexJob" ADD COLUMN     "materialId" TEXT,
ADD COLUMN     "passageId" TEXT;

-- CreateTable
CREATE TABLE "TalkMaterial" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "TalkMaterialKind" NOT NULL,
    "title" TEXT NOT NULL,
    "status" "TalkMaterialStatus" NOT NULL DEFAULT 'processing',
    "pageCount" INTEGER,
    "passageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TalkMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialPassage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "pageNumber" INTEGER,
    "text" TEXT NOT NULL,

    CONSTRAINT "MaterialPassage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalkMaterial_sessionId_createdAt_idx" ON "TalkMaterial"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "MaterialPassage_sessionId_idx" ON "MaterialPassage"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialPassage_materialId_ordinal_key" ON "MaterialPassage"("materialId", "ordinal");

-- AddForeignKey
ALTER TABLE "SearchIndexJob" ADD CONSTRAINT "SearchIndexJob_passageId_fkey" FOREIGN KEY ("passageId") REFERENCES "MaterialPassage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TalkMaterial" ADD CONSTRAINT "TalkMaterial_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialPassage" ADD CONSTRAINT "MaterialPassage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialPassage" ADD CONSTRAINT "MaterialPassage_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "TalkMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;
