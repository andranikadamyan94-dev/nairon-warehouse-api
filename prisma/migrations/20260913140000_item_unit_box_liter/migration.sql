-- Two more units of measure (2026-09-13): տուփ and լիտր.
ALTER TYPE "ItemUnit" ADD VALUE IF NOT EXISTS 'BOX';
ALTER TYPE "ItemUnit" ADD VALUE IF NOT EXISTS 'LITER';
