-- CreateTable
CREATE TABLE "WriteOperation" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "entityId" INTEGER,
    "route" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_FLIGHT',
    "result" JSONB,
    "resourceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WriteOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WriteOperation_key_key" ON "WriteOperation"("key");

-- CreateIndex
CREATE INDEX "WriteOperation_userId_idx" ON "WriteOperation"("userId");

-- CreateIndex
CREATE INDEX "WriteOperation_createdAt_idx" ON "WriteOperation"("createdAt");
