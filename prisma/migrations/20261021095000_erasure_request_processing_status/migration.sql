-- Add PROCESSING in its own migration so PostgreSQL commits the enum value
-- before a later migration references it in a partial index.
ALTER TYPE "ErasureRequestStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
