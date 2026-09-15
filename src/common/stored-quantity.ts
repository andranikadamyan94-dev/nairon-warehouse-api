/**
 * Prisma's increment/decrement runs the arithmetic in double precision, so a
 * stock of 9.8 minus 0.1 lands as 9.700000000000001 in the row itself, and
 * every later sum inherits the residue. Until the columns become exact
 * decimals, each stock mutation calls this afterwards to settle the stored
 * value on the three decimals the warehouse measures (see quantity.ts).
 */
export async function settleStoredQty(
  tx: any,
  target: { itemId?: number | null; warehouseId?: number | null; reservationId?: number | null },
): Promise<void> {
  if (target.itemId) {
    if (target.warehouseId) {
      await tx.$executeRaw`UPDATE "WarehouseStock" SET "quantity" = ROUND("quantity"::numeric, 3) WHERE "itemId" = ${target.itemId} AND "warehouseId" = ${target.warehouseId}`;
    } else {
      await tx.$executeRaw`UPDATE "Item" SET "quantity" = ROUND("quantity"::numeric, 3) WHERE "id" = ${target.itemId}`;
    }
  }
  if (target.reservationId) {
    await tx.$executeRaw`UPDATE "ResourceReservation" SET "quantity" = ROUND("quantity"::numeric, 3), "acceptedQuantity" = ROUND("acceptedQuantity"::numeric, 3) WHERE "id" = ${target.reservationId}`;
  }
}
