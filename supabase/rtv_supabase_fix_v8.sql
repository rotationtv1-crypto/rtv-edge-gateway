-- ============================================================
-- rtv_supabase_fix_v8.sql
-- Full Scale Deployment — Supabase Brain Wiring
-- Authority: Darrel-Spell-Living-Trust
-- Project: xynkgaxfwvpcixissxdz
-- Convention: PascalCase tables
-- ============================================================

-- ─── CORE TABLES ───────────────────────────────────────────

-- Vault Balances (PascalCase)
CREATE TABLE IF NOT EXISTS "VaultBalances" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL REFERENCES auth.users(id),
  "tokenSymbol" TEXT NOT NULL DEFAULT 'RTVS',
  "balance" BIGINT NOT NULL DEFAULT 0,
  "lockedBalance" BIGINT NOT NULL DEFAULT 0,
  "lastUpdated" TIMESTAMPTZ DEFAULT now(),
  "createdAt" TIMESTAMPTZ DEFAULT now(),
  UNIQUE("userId", "tokenSymbol")
);

-- Transfer History
CREATE TABLE IF NOT EXISTS "TransferHistory" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "senderId" UUID NOT NULL REFERENCES auth.users(id),
  "receiverId" UUID NOT NULL REFERENCES auth.users(id),
  "amountRtv" BIGINT NOT NULL,
  "transferType" TEXT NOT NULL CHECK ("transferType" IN ('gift', 'payment', 'withdrawal', 'deposit', 'burn')),
  "description" TEXT,
  "referenceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'completed' CHECK ("status" IN ('pending', 'completed', 'failed', 'reversed')),
  "createdAt" TIMESTAMPTZ DEFAULT now()
);

-- Live Rooms
CREATE TABLE IF NOT EXISTS "LiveRooms" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "creatorId" UUID NOT NULL REFERENCES auth.users(id),
  "title" TEXT NOT NULL,
  "streamUid" TEXT,
  "streamKey" TEXT,
  "whipUrl" TEXT,
  "whepUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'offline' CHECK ("status" IN ('offline', 'live', 'ended')),
  "connectionState" TEXT DEFAULT 'disconnected',
  "viewerCount" INT DEFAULT 0,
  "rtvEarnedSession" BIGINT DEFAULT 0,
  "startedAt" TIMESTAMPTZ,
  "endedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT now()
);

-- Gifts Catalog
CREATE TABLE IF NOT EXISTS "Gifts" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "name" TEXT NOT NULL,
  "emoji" TEXT NOT NULL,
  "rtvCost" BIGINT NOT NULL,
  "isActive" BOOLEAN DEFAULT true,
  "category" TEXT DEFAULT 'standard',
  "createdAt" TIMESTAMPTZ DEFAULT now()
);

-- Gift Transactions
CREATE TABLE IF NOT EXISTS "GiftTransactions" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "senderId" UUID NOT NULL REFERENCES auth.users(id),
  "receiverId" UUID NOT NULL REFERENCES auth.users(id),
  "roomId" UUID REFERENCES "LiveRooms"(id),
  "giftId" UUID REFERENCES "Gifts"(id),
  "giftName" TEXT NOT NULL,
  "giftEmoji" TEXT,
  "rtvAmount" BIGINT NOT NULL,
  "message" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT now()
);

-- Jetton Masters (Token Registry)
CREATE TABLE IF NOT EXISTS "JettonMasters" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "contractAddress" TEXT NOT NULL UNIQUE,
  "symbol" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "decimals" INT NOT NULL DEFAULT 9,
  "totalSupply" TEXT,
  "isActive" BOOLEAN DEFAULT true,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT now()
);

-- Jetton Wallets (Owner Mapping)
CREATE TABLE IF NOT EXISTS "JettonWallets" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL REFERENCES auth.users(id),
  "jettonMasterId" UUID REFERENCES "JettonMasters"(id),
  "walletAddress" TEXT NOT NULL,
  "ownerAddress" TEXT NOT NULL,
  "balance" TEXT DEFAULT '0',
  "lastSynced" TIMESTAMPTZ DEFAULT now(),
  "createdAt" TIMESTAMPTZ DEFAULT now(),
  UNIQUE("userId", "jettonMasterId")
);

-- Deposit Transactions (Immutable On-Chain Log)
CREATE TABLE IF NOT EXISTS "DepositTransactions" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL REFERENCES auth.users(id),
  "jettonMasterId" UUID REFERENCES "JettonMasters"(id),
  "txHash" TEXT NOT NULL UNIQUE,
  "fromAddress" TEXT NOT NULL,
  "toAddress" TEXT NOT NULL,
  "amount" TEXT NOT NULL,
  "queryId" TEXT,
  "forwardPayload" TEXT,
  "status" TEXT DEFAULT 'confirmed' CHECK ("status" IN ('pending', 'confirmed', 'failed')),
  "processedAt" TIMESTAMPTZ DEFAULT now(),
  "createdAt" TIMESTAMPTZ DEFAULT now()
);

-- Pillar Registry
CREATE TABLE IF NOT EXISTS "PillarRegistry" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "pillarNumber" INT NOT NULL UNIQUE CHECK ("pillarNumber" BETWEEN 1 AND 8),
  "name" TEXT NOT NULL,
  "division" TEXT NOT NULL,
  "repoUrl" TEXT,
  "workerUrl" TEXT,
  "status" TEXT DEFAULT 'initialized' CHECK ("status" IN ('initialized', 'building', 'live', 'maintenance')),
  "createdAt" TIMESTAMPTZ DEFAULT now(),
  "updatedAt" TIMESTAMPTZ DEFAULT now()
);

-- ─── RPC FUNCTIONS ─────────────────────────────────────────

-- Atomic RTV Transfer
CREATE OR REPLACE FUNCTION transfer_rtv(
  p_sender_id UUID,
  p_receiver_id UUID,
  p_amount_rtv BIGINT,
  p_transfer_type TEXT DEFAULT 'gift',
  p_description TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_sender_balance BIGINT;
  v_transfer_id UUID;
BEGIN
  -- Lock sender row
  SELECT "balance" INTO v_sender_balance
  FROM "VaultBalances"
  WHERE "userId" = p_sender_id AND "tokenSymbol" = 'RTVS'
  FOR UPDATE;

  IF v_sender_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'failed', 'message', 'Sender has no vault');
  END IF;

  IF v_sender_balance < p_amount_rtv THEN
    RETURN jsonb_build_object('status', 'failed', 'message', 'Insufficient balance');
  END IF;

  -- Debit sender
  UPDATE "VaultBalances"
  SET "balance" = "balance" - p_amount_rtv, "lastUpdated" = now()
  WHERE "userId" = p_sender_id AND "tokenSymbol" = 'RTVS';

  -- Credit receiver (upsert)
  INSERT INTO "VaultBalances" ("userId", "tokenSymbol", "balance", "lastUpdated")
  VALUES (p_receiver_id, 'RTVS', p_amount_rtv, now())
  ON CONFLICT ("userId", "tokenSymbol")
  DO UPDATE SET "balance" = "VaultBalances"."balance" + p_amount_rtv, "lastUpdated" = now();

  -- Log transfer
  INSERT INTO "TransferHistory" ("senderId", "receiverId", "amountRtv", "transferType", "description", "referenceId")
  VALUES (p_sender_id, p_receiver_id, p_amount_rtv, p_transfer_type, p_description, p_reference_id)
  RETURNING "id" INTO v_transfer_id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'transfer_id', v_transfer_id,
    'amount', p_amount_rtv
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── ROW LEVEL SECURITY ────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE "VaultBalances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransferHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveRooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Gifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GiftTransactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JettonMasters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JettonWallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DepositTransactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PillarRegistry" ENABLE ROW LEVEL SECURITY;

-- VaultBalances: Users see own balance
CREATE POLICY "vault_own_read" ON "VaultBalances"
  FOR SELECT USING (auth.uid() = "userId");

-- TransferHistory: Users see own transfers
CREATE POLICY "transfers_own_read" ON "TransferHistory"
  FOR SELECT USING (auth.uid() = "senderId" OR auth.uid() = "receiverId");

-- LiveRooms: Anyone can read live rooms, creators can update own
CREATE POLICY "rooms_public_read" ON "LiveRooms"
  FOR SELECT USING (true);
CREATE POLICY "rooms_creator_update" ON "LiveRooms"
  FOR UPDATE USING (auth.uid() = "creatorId");
CREATE POLICY "rooms_creator_insert" ON "LiveRooms"
  FOR INSERT WITH CHECK (auth.uid() = "creatorId");

-- Gifts: Public read
CREATE POLICY "gifts_public_read" ON "Gifts"
  FOR SELECT USING (true);

-- GiftTransactions: Users see own
CREATE POLICY "gift_tx_own_read" ON "GiftTransactions"
  FOR SELECT USING (auth.uid() = "senderId" OR auth.uid() = "receiverId");

-- JettonMasters: Public read
CREATE POLICY "jetton_masters_read" ON "JettonMasters"
  FOR SELECT USING (true);

-- JettonWallets: Own wallets
CREATE POLICY "jetton_wallets_own" ON "JettonWallets"
  FOR SELECT USING (auth.uid() = "userId");

-- DepositTransactions: Own deposits
CREATE POLICY "deposits_own_read" ON "DepositTransactions"
  FOR SELECT USING (auth.uid() = "userId");

-- PillarRegistry: Public read
CREATE POLICY "pillars_public_read" ON "PillarRegistry"
  FOR SELECT USING (true);

-- ─── SEED PILLAR DATA ──────────────────────────────────────

INSERT INTO "PillarRegistry" ("pillarNumber", "name", "division", "repoUrl", "status")
VALUES
  (1, 'RotationTV Network', 'Media', 'https://github.com/rotationtv1-crypto/rtv-telegram-wallet', 'live'),
  (2, 'RotationTV AI', 'Neural Layer', 'https://github.com/rotationtv1-crypto/rtv-ai-gateway', 'live'),
  (3, 'RotationPay', 'Treasury/Hub', 'https://github.com/rotationtv1-crypto/rtv-edge-gateway', 'live'),
  (4, 'AI University', 'Education', NULL, 'initialized'),
  (5, 'White Logistics', 'Supply Chain', 'https://github.com/rotationtv1-crypto/white-logistics', 'initialized'),
  (6, 'Pretrial USA', 'Legal/Gov', 'https://github.com/rotationtv1-crypto/pretrial-usa', 'initialized'),
  (7, 'Hydro-OS', 'Decentralized OS', 'https://github.com/rotationtv1-crypto/hydro-os', 'initialized'),
  (8, 'Token Tech', '$RTVS Infra', 'https://github.com/rotationtv1-crypto/ton-assets', 'live')
ON CONFLICT ("pillarNumber") DO UPDATE SET
  "repoUrl" = EXCLUDED."repoUrl",
  "status" = EXCLUDED."status",
  "updatedAt" = now();

-- ─── SEED GIFTS ────────────────────────────────────────────

INSERT INTO "Gifts" ("name", "emoji", "rtvCost", "category") VALUES
  ('Heart', '❤️', 10, 'basic'),
  ('Fire', '🔥', 25, 'basic'),
  ('Diamond', '💎', 100, 'premium'),
  ('Rocket', '🚀', 250, 'premium'),
  ('Crown', '👑', 500, 'legendary'),
  ('Lightning', '⚡', 1000, 'legendary')
ON CONFLICT DO NOTHING;

-- ============================================================
-- END OF rtv_supabase_fix_v8.sql
-- Apply with: psql or Supabase SQL Editor
-- ============================================================
