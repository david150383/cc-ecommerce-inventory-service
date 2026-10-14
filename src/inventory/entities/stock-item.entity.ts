import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * Stock for one SKU. `available` = on_hand - reserved and is never stored.
 * The CHECKs make overselling impossible at the database level, whatever the code does.
 */
@Entity("stock_items")
@Check("ck_stock_items_on_hand_non_negative", `"on_hand" >= 0`)
@Check("ck_stock_items_reserved_non_negative", `"reserved" >= 0`)
@Check("ck_stock_items_reserved_within_on_hand", `"reserved" <= "on_hand"`)
@Check("ck_stock_items_sku_format", `"sku" ~ '^[A-Z0-9][A-Z0-9-]{2,63}$'`)
export class StockItem {
  @PrimaryColumn({ type: "varchar", length: 64, primaryKeyConstraintName: "pk_stock_items" })
  sku!: string;

  @Column({ name: "on_hand", type: "integer", default: 0 })
  onHand!: number;

  @Column({ type: "integer", default: 0 })
  reserved!: number;

  @Column({ name: "low_stock_threshold", type: "integer", default: 5 })
  lowStockThreshold!: number;

  @Column({ type: "integer", default: 1 })
  version!: number;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
