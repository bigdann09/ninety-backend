-- p2p.router.ts has always written these columns (accept/confirm-stake/settle/claim flows)
-- but the table was created ad-hoc without them, so every accept beyond the initial
-- insert has been failing with "Could not find the 'market_id' column ... in the schema
-- cache" ever since those endpoints were written.
alter table p2p_challenges
  add column if not exists market_id text,
  add column if not exists market_pda text,
  add column if not exists creator_tx_sig text,
  add column if not exists challenger_tx_sig text,
  add column if not exists winner_wallet text,
  add column if not exists settlement_event_nonce bigint,
  add column if not exists ai_reasoning text,
  add column if not exists payout_tx_sig text;
