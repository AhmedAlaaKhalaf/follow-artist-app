-- CreateTable
CREATE TABLE "ProductEmailLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "artistGid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductEmailLog_shop_productGid_key" ON "ProductEmailLog"("shop", "productGid");
