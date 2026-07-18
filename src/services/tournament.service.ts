import { supabaseAdmin } from "../lib/supabase";
import { SolanaService } from "./solana.service";
import { MarketStatus } from "./pipeline.service";

export const TOURNAMENT_MATCH_ID = "wc2026-winner";
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
    .select("id, question, status, opens_at, closes_at")
    .eq("match_id", TOURNAMENT_MATCH_ID);

  const existingByQuestion = new Map((existingMarkets || []).map((m) => [m.question, m]));

  for (const team of TOURNAMENT_TEAMS) {
    const question = tournamentQuestion(team);
    const existing = existingByQuestion.get(question);

    // A row already exists and its on-chain market was confirmed created — nothing to do.
    if (existing && existing.status !== MarketStatus.VOID) continue;

    let marketRow = existing;
    if (!marketRow) {
      const { data: inserted, error: mErr } = await supabaseAdmin
        .from("markets")
        .insert({
          match_id: TOURNAMENT_MATCH_ID,
          market_type: "fulltime",
          question,
          opens_at: new Date(Date.now() - 30_000).toISOString(),
          closes_at: TOURNAMENT_CLOSES_AT,
          status: MarketStatus.VOID,
        })
        .select("*")
        .single();

      if (mErr || !inserted) {
        console.error(`[Tournament] Failed to create market row for ${team}:`, mErr?.message);
        continue;
      }
      marketRow = inserted;
    } else {
      console.log(`[Tournament] Retrying on-chain market creation for ${team} (previously void)`);
    }
    if (!marketRow) continue;

    try {
      await new Promise((r) => setTimeout(r, 1500));
      const txSig = await solanaService.createMarket(
        TOURNAMENT_MATCH_ID,
        marketRow.id,
        new Date(marketRow.opens_at),
        new Date(marketRow.closes_at)
      );
      const onChainPubkey = solanaService.getMarketPda(TOURNAMENT_MATCH_ID, marketRow.id).toBase58();
      await supabaseAdmin
        .from("markets")
        .update({ status: MarketStatus.OPEN, on_chain_pubkey: onChainPubkey })
        .eq("id", marketRow.id);
      console.log(`[Tournament] Created on-chain winner market for ${team}: ${txSig}`);
    } catch (e: any) {
      console.error(`[Tournament] On-chain market creation failed for ${team}, will retry next run:`, e.message);
    }
  }
}

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
