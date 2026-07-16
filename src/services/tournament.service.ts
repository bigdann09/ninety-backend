import { supabaseAdmin } from "../lib/supabase";
import { SolanaService } from "./solana.service";
import { MarketStatus } from "./pipeline.service";

/**
 * The tournament-winner market lives under a synthetic "match" row so it can reuse
 * the existing matches/markets tables, the on-chain market program, and the whole
 * stake/receipt flow — no schema changes. Every matches/pipeline consumer must
 * exclude this id so it never renders as a fixture or gets auto-market'd.
 */
export const TOURNAMENT_MATCH_ID = "wc2026-winner";

/** Betting closes when the final kicks off. */
export const TOURNAMENT_CLOSES_AT = "2026-07-19T19:00:00Z";

export const TOURNAMENT_TEAMS = [
  "France",
  "Brazil",
  "Argentina",
  "England",
  "Spain",
  "Germany",
  "Portugal",
  "Morocco",
] as const;

export function tournamentQuestion(team: string): string {
  return `Will ${team} win the 2026 World Cup?`;
}

export function teamFromQuestion(question: string): string | null {
  const m = question.match(/^Will (.+) win the 2026 World Cup\?$/);
  return m ? m[1] : null;
}

/**
 * Idempotent bootstrap: creates the synthetic tournament match and one open
 * yes/no market per team (with its on-chain counterpart). Safe to run on every
 * startup — existing rows are left untouched.
 */
export async function ensureTournamentMarkets(solanaService: SolanaService): Promise<void> {
  const { data: existingMatch } = await supabaseAdmin
    .from("matches")
    .select("id")
    .eq("id", TOURNAMENT_MATCH_ID)
    .maybeSingle();

  if (!existingMatch) {
    const { error: matchErr } = await supabaseAdmin.from("matches").insert({
      id: TOURNAMENT_MATCH_ID,
      txline_fixture_id: TOURNAMENT_MATCH_ID,
      home_team: "World Cup 2026",
      away_team: "Tournament Winner",
      competition: "World Cup",
      kickoff_at: TOURNAMENT_CLOSES_AT,
      status: "scheduled",
      score_home: 0,
      score_away: 0,
    });
    if (matchErr) {
      console.error("[Tournament] Failed to create synthetic match:", matchErr.message);
      return;
    }
    console.log("[Tournament] Created synthetic tournament match");
  }

  const { data: existingMarkets } = await supabaseAdmin
    .from("markets")
    .select("id, question")
    .eq("match_id", TOURNAMENT_MATCH_ID);

  const existingQuestions = new Set((existingMarkets || []).map((m) => m.question));

  for (const team of TOURNAMENT_TEAMS) {
    const question = tournamentQuestion(team);
    if (existingQuestions.has(question)) continue;

    const { data: inserted, error: mErr } = await supabaseAdmin
      .from("markets")
      .insert({
        match_id: TOURNAMENT_MATCH_ID,
        market_type: "fulltime",
        question,
        opens_at: new Date(Date.now() - 30_000).toISOString(),
        closes_at: TOURNAMENT_CLOSES_AT,
        status: MarketStatus.OPEN,
      })
      .select("*")
      .single();

    if (mErr || !inserted) {
      console.error(`[Tournament] Failed to create market for ${team}:`, mErr?.message);
      continue;
    }

    try {
      await new Promise((r) => setTimeout(r, 1500));
      const txSig = await solanaService.createMarket(
        TOURNAMENT_MATCH_ID,
        inserted.id,
        new Date(inserted.opens_at),
        new Date(inserted.closes_at)
      );
      console.log(`[Tournament] Created on-chain winner market for ${team}: ${txSig}`);
    } catch (e: any) {
      console.error(`[Tournament] On-chain market creation failed for ${team}, proceeding:`, e.message);
    }

    const onChainPubkey = solanaService.getMarketPda(TOURNAMENT_MATCH_ID, inserted.id).toBase58();
    await supabaseAdmin.from("markets").update({ on_chain_pubkey: onChainPubkey }).eq("id", inserted.id);
  }
}

/**
 * Settles every tournament market at once: the winner's market as YES, all others
 * as NO. On-chain anchoring/settlement is best-effort per market (same posture as
 * the pipeline's expiry settlement); the DB outcome is always written.
 */
export async function settleTournament(
  solanaService: SolanaService,
  computeEventHash: (payload: any) => string,
  winner: string
): Promise<{ settled: number }> {
  const { data: markets } = await supabaseAdmin
    .from("markets")
    .select("*")
    .eq("match_id", TOURNAMENT_MATCH_ID)
    .eq("status", MarketStatus.OPEN);

  if (!markets || markets.length === 0) return { settled: 0 };

  let settled = 0;
  for (const market of markets) {
    const team = teamFromQuestion(market.question);
    const outcome = team === winner;

    let settleTxSig: string | null = null;
    try {
      const { data: nextNonce } = await supabaseAdmin.rpc("next_event_nonce");
      const payload = { type: "tournament_winner", winner, market_id: market.id };
      const eventHash = computeEventHash(payload);
      const occurredAt = new Date().toISOString();

      const { data: ev } = await supabaseAdmin
        .from("match_events")
        .insert({
          match_id: TOURNAMENT_MATCH_ID,
          event_nonce: nextNonce,
          event_type: "fulltime",
          event_hash: eventHash,
          payload,
          occurred_at: occurredAt,
        })
        .select("*")
        .single();

      if (ev) {
        const FULLTIME_TYPE_INT = 3;
        await solanaService.anchorEvent(
          TOURNAMENT_MATCH_ID,
          Number(ev.event_nonce),
          FULLTIME_TYPE_INT,
          ev.event_hash,
          new Date(ev.occurred_at)
        );
        settleTxSig = await solanaService.settleMarket(
          TOURNAMENT_MATCH_ID,
          market.id,
          Number(ev.event_nonce),
          outcome
        );
      }
    } catch (e: any) {
      console.error(`[Tournament] On-chain settlement failed for market ${market.id}:`, e.message);
    }

    await supabaseAdmin
      .from("markets")
      .update({
        status: MarketStatus.SETTLED,
        outcome,
        resolution_event_hash: settleTxSig,
      })
      .eq("id", market.id);
    settled++;
  }

  return { settled };
}
