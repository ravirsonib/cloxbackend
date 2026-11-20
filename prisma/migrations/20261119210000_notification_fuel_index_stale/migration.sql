-- W3.6 — Ops inbox type for stale diesel index alerts.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FUEL_INDEX_STALE';
