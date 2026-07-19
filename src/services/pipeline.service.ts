import { supabaseAdmin } from "../lib/supabase";
import { SolanaService } from "./solana.service";
import { TxlineService } from "./txline.service";
import { mintReceiptNFT } from "./nft.service";

type MatchAlertType = "goal" | "card" | "corner" | "var" | "fulltime";

interface MatchAlertEvent {
  type: MatchAlertType;
  team?: string;
  cardType?: "yellow" | "red";
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  minute?: number;
  competition?: string;
  matchSlug: string;
}

async function pushMatchAlert(event: MatchAlertEvent): Promise<void> {
  try {
    const botUrl = process.env.BOT_INTERNAL_URL;
    const botKey = process.env.BOT_KEY;
    if (!botUrl || !botKey) return;

    let query = supabaseAdmin
      .from("telegram_notifications")
      .select("chat_id")
      .contains("event_types", [event.type]);

    query = event.team
      ? query.ilike("team", `%${event.team}%`)
      : query.or(`team.ilike.%${event.homeTeam}%,team.ilike.%${event.awayTeam}%`);

    const { data: subs } = await query;
    if (!subs || subs.length === 0) return;

    await fetch(`${botUrl}/alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": botKey,
      },
      body: JSON.stringify({
        chatIds: subs.map((r) => r.chat_id),
        event,
      }),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[Pipeline] Pushed ${event.type} alert to ${subs.length} Telegram chats`);
  } catch (e: any) {
    console.error("[Pipeline] pushMatchAlert failed:", e.message);
  }
}

export enum MatchStatus {
  SCHEDULED = "scheduled",
  LIVE = "live",
  HALFTIME = "halftime",
  FULL_TIME = "full_time",
  POSTPONED = "postponed",
}

export enum MarketStatus {
  OPEN = "open",
  LOCKED = "locked",
  SETTLED = "settled",
  VOID = "void",
}

export enum MarketType {
  GOAL = "goal",
  CARD = "card",
  CORNER = "corner",
  FULLTIME = "fulltime",
  THROWIN = "throwin",
  FREEKICK = "freekick",
}

export class PipelineService {
  private solanaService: SolanaService;
  private txlineService: TxlineService;
  private isSyncing = false;

  private streamedMatchCache = new Map<string, any>();
  private streamedEventHashes = new Map<string, Set<string>>();

  constructor(solanaService: SolanaService, txlineService: TxlineService) {
    this.solanaService = solanaService;
    this.txlineService = txlineService;
  }

  /** Starts the persistent SSE consumer. Call once at process boot — it manages its own reconnects. */
  public startLiveEventStream(): void {
    this.refreshStreamedMatchCache();
    setInterval(() => this.refreshStreamedMatchCache(), 20_000);

    this.txlineService.streamScores((ev) => {
      this.handleStreamEvent(ev).catch((err) => {
        console.error("[TxLINE Stream] Error handling event:", err.message);
      });
    });
  }

  private async refreshStreamedMatchCache(): Promise<void> {
    try {
      const { data: activeMatches, error } = await supabaseAdmin
        .from("matches")
        .select("*")
        .neq("id", "wc2026-winner")
        .in("status", [MatchStatus.LIVE, MatchStatus.SCHEDULED, MatchStatus.HALFTIME]);
      if (error || !activeMatches) return;

      const seenFixtures = new Set(activeMatches.map((m) => m.txline_fixture_id));
      for (const fixtureId of this.streamedMatchCache.keys()) {
        if (!seenFixtures.has(fixtureId)) {
          this.streamedMatchCache.delete(fixtureId);
          this.streamedEventHashes.delete(fixtureId);
        }
      }

      for (const match of activeMatches) {
        this.streamedMatchCache.set(match.txline_fixture_id, match);
        if (!this.streamedEventHashes.has(match.txline_fixture_id)) {
          const { data: existingEvents } = await supabaseAdmin
            .from("match_events")
            .select("event_hash")
            .eq("match_id", match.id);
          this.streamedEventHashes.set(match.txline_fixture_id, new Set((existingEvents || []).map((e) => e.event_hash)));
        }
      }
    } catch (err: any) {
      console.error("[TxLINE Stream] Failed to refresh match cache:", err.message);
    }
  }

  private async handleStreamEvent(ev: { eventType: string; occurredAt: string; payload: any }): Promise<void> {
    const fixtureId = ev.payload?.FixtureId != null ? String(ev.payload.FixtureId) : null;
    if (!fixtureId) return;

    const match = this.streamedMatchCache.get(fixtureId);
    if (!match) return; // Not one of ours — the stream covers every fixture TxLINE has, not just our tracked ones.

    const eventHash = this.txlineService.computeEventHash(ev.payload);
    const seenHashes = this.streamedEventHashes.get(fixtureId) || new Set<string>();
    if (seenHashes.has(eventHash)) return;
    seenHashes.add(eventHash);
    this.streamedEventHashes.set(fixtureId, seenHashes);

    const { data: nextNonce, error: rpcError } = await supabaseAdmin.rpc("next_event_nonce");
    if (rpcError) {
      console.error("[TxLINE Stream] Error fetching next nonce:", rpcError.message);
      return;
    }

    const { error: insertError } = await supabaseAdmin.from("match_events").insert({
      match_id: match.id,
      event_nonce: nextNonce,
      event_type: ev.eventType,
      event_hash: eventHash,
      payload: ev.payload,
      occurred_at: new Date(ev.occurredAt || Date.now()).toISOString(),
    });
    if (insertError) {
      console.error("[TxLINE Stream] Error inserting event:", insertError.message);
      return;
    }

    let scoreHome = match.score_home ?? 0;
    let scoreAway = match.score_away ?? 0;
    let matchStatus = match.status;
    let changed = false;

    if (ev.payload?.Score) {
      const p1IsHome = ev.payload.Participant1IsHome !== false;
      const p1Goals = ev.payload.Score.Participant1?.Total?.Goals;
      const p2Goals = ev.payload.Score.Participant2?.Total?.Goals;
      const homeGoals = p1IsHome ? p1Goals : p2Goals;
      const awayGoals = p1IsHome ? p2Goals : p1Goals;
      if (homeGoals !== undefined && homeGoals > scoreHome) { scoreHome = homeGoals; changed = true; }
      if (awayGoals !== undefined && awayGoals > scoreAway) { scoreAway = awayGoals; changed = true; }
    }

    const isFullTime = ev.eventType === "fulltime" || ev.eventType === "game_finalised";
    if (isFullTime && matchStatus !== MatchStatus.FULL_TIME) {
      matchStatus = MatchStatus.FULL_TIME;
      changed = true;
    }

    if (changed) {
      await supabaseAdmin
        .from("matches")
        .update({ status: matchStatus, score_home: scoreHome, score_away: scoreAway, updated_at: new Date().toISOString() })
        .eq("id", match.id);
      match.status = matchStatus;
      match.score_home = scoreHome;
      match.score_away = scoreAway;
      this.streamedMatchCache.set(fixtureId, match);
      console.log(`[TxLINE Stream] ${match.home_team} vs ${match.away_team}: ${scoreHome}-${scoreAway} (${matchStatus})`);
    }

    const isGoalEvent = ev.eventType === "goal" || ev.eventType === "score_update";
    const isRedCard = ev.eventType === "red_card" || ev.eventType === "redcard";
    const isYellowCard = ev.eventType === "card";
    const isCornerEvent = ev.eventType === "corner";
    const isVarEvent = ev.eventType === "var";
    if (isGoalEvent || isRedCard || isYellowCard || isCornerEvent || isVarEvent) {
      const eventTeam = ev.payload?.Participant === 2 ? match.away_team : match.home_team;
      const elapsedNow = Math.max(1, Math.min(90, Math.floor((Date.now() - new Date(match.kickoff_at).getTime()) / 60000)));
      pushMatchAlert({
        type: isGoalEvent ? "goal" : isRedCard || isYellowCard ? "card" : isCornerEvent ? "corner" : "var",
        team: eventTeam,
        cardType: isRedCard ? "red" : isYellowCard ? "yellow" : undefined,
        homeTeam: match.home_team,
        awayTeam: match.away_team,
        homeScore: scoreHome,
        awayScore: scoreAway,
        minute: elapsedNow,
        competition: match.competition,
        matchSlug: match.id,
      }).catch(() => {});
    }
  }

  public async tick(): Promise<{ eventsProcessed: number }> {
    try {
      const { data: lock, error: lockErr } = await supabaseAdmin
        .from("pipeline_state")
        .select("is_running, last_run_at")
        .eq("id", 1)
        .maybeSingle();

      if (lockErr) {
        console.error("[Pipeline] Error checking mutex lock:", lockErr.message);
      }

      if (lock?.is_running) {
        const staleSince = Date.now() - new Date(lock.last_run_at).getTime();
        if (staleSince < 55000) {
          console.log("[Pipeline] Mutex lock is active. Skipping concurrent run.");
          return { eventsProcessed: 0 };
        }
      }

      await supabaseAdmin
        .from("pipeline_state")
        .upsert({ id: 1, is_running: true, last_run_at: new Date().toISOString() });

      try {
        const res = await this.syncFeed();
        return res;
      } finally {
        await supabaseAdmin
          .from("pipeline_state")
          .upsert({ id: 1, is_running: false, last_run_at: new Date().toISOString() });
      }
    } catch (err: any) {
      console.error("[Pipeline] Tick execution failed:", err.message);
      return { eventsProcessed: 0 };
    }
  }

  public async syncFeed(): Promise<{ eventsProcessed: number }> {
    if (this.isSyncing) {
      console.log("[Pipeline] Sync already in progress, skipping concurrent run.");
      return { eventsProcessed: 0 };
    }
    this.isSyncing = true;
    let eventsProcessed = 0;
    try {
      console.log("[Pipeline] Syncing TxLINE fixtures and events...");
      console.log("[Pipeline] Ingesting new TxLINE fixtures...");
      const fixtures = await this.txlineService.getFixtures();

      for (const fix of fixtures) {
        let { data: match, error: matchError } = await supabaseAdmin
          .from("matches")
          .select("*")
          .eq("txline_fixture_id", fix.fixtureId)
          .maybeSingle();

        if (matchError) {
          console.error("[Pipeline] Error fetching match:", matchError.message);
          continue;
        }

        if (!match) {
          const startTimeMs = new Date(fix.startTime).getTime();
          const initialStatus = startTimeMs > Date.now() ? MatchStatus.SCHEDULED : MatchStatus.LIVE;

          const newMatch = {
            id: fix.fixtureId,
            txline_fixture_id: fix.fixtureId,
            home_team: fix.participant1,
            away_team: fix.participant2,
            competition: fix.competition,
            kickoff_at: new Date(fix.startTime).toISOString(),
            status: initialStatus,
            score_home: 0,
            score_away: 0,
          };

          const { data: insertedMatch, error: insertError } = await supabaseAdmin
            .from("matches")
            .insert(newMatch)
            .select("*")
            .single();

          if (insertError) {
            console.error("[Pipeline] Error inserting match:", insertError.message);
            continue;
          }

          match = insertedMatch;
          console.log(`[Pipeline] Ingested new match: ${match.home_team} vs ${match.away_team}`);
          const opensAt = new Date(Date.now() - 30 * 1000).toISOString();

          const goalMarket = {
            match_id: match.id,
            market_type: MarketType.GOAL,
            question: this.generatePredictionQuestion("goal", fix),
            opens_at: opensAt,
            closes_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            status: MarketStatus.OPEN,
          };
          const cornerMarket = {
            match_id: match.id,
            market_type: MarketType.CORNER,
            question: this.generatePredictionQuestion("corner", fix),
            opens_at: opensAt,
            closes_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
            status: MarketStatus.OPEN,
          };
          const throwinMarket = {
            match_id: match.id,
            market_type: MarketType.THROWIN,
            question: this.generatePredictionQuestion("throwin", fix),
            opens_at: opensAt,
            closes_at: new Date(Date.now() + 60 * 1000).toISOString(),
            status: MarketStatus.OPEN,
          };
          const freekickMarket = {
            match_id: match.id,
            market_type: MarketType.FREEKICK,
            question: this.generatePredictionQuestion("freekick", fix),
            opens_at: opensAt,
            closes_at: new Date(Date.now() + 120 * 1000).toISOString(),
            status: MarketStatus.OPEN,
          };

          for (const m of [goalMarket, cornerMarket, throwinMarket, freekickMarket]) {
            const { data: insertedMarket, error: mError } = await supabaseAdmin
              .from("markets")
              .insert(m)
              .select("*")
              .single();

            if (mError) {
              console.error("[Pipeline] Error creating market:", mError.message);
              continue;
            }

            try {
              await new Promise((r) => setTimeout(r, 1500));
              const txSig = await this.solanaService.createMarket(
                insertedMarket.match_id,
                insertedMarket.id,
                new Date(insertedMarket.opens_at),
                new Date(insertedMarket.closes_at)
              );
              console.log(`[Pipeline] Created on-chain market for ${insertedMarket.market_type}: ${txSig}`);
            } catch (e: any) {
              console.error(`[Pipeline] Failed to create on-chain market for ${insertedMarket.market_type}, proceeding:`, e.message);
            }

            const onChainPubkey = this.solanaService.getMarketPda(insertedMarket.match_id, insertedMarket.id).toBase58();
            await supabaseAdmin
              .from("markets")
              .update({ on_chain_pubkey: onChainPubkey })
              .eq("id", insertedMarket.id);
          }
        }
      }

      console.log("[Pipeline] Syncing events and markets for active matches...");
      // The synthetic tournament-winner match must never be treated as a fixture:
      // it has no TxLINE feed and its markets are created/settled by tournament.service.
      const { data: activeMatches, error: activeErr } = await supabaseAdmin
        .from("matches")
        .select("*")
        .neq("id", "wc2026-winner")
        .in("status", [MatchStatus.LIVE, MatchStatus.SCHEDULED, MatchStatus.HALFTIME]);

      if (!activeErr && activeMatches) {
        for (const match of activeMatches) {
          if (match.status === MatchStatus.LIVE) {
            const { data: openMarkets, error: openError } = await supabaseAdmin
              .from("markets")
              .select("*")
              .eq("match_id", match.id)
              .eq("status", MarketStatus.OPEN);

            if (!openError && openMarkets) {
              const hasOpenGoal = openMarkets.some((m) => m.market_type === MarketType.GOAL);
              const hasOpenCorner = openMarkets.some((m) => m.market_type === MarketType.CORNER);
              const hasOpenThrowin = openMarkets.some((m) => m.market_type === MarketType.THROWIN);
              const hasOpenFreekick = openMarkets.some((m) => m.market_type === MarketType.FREEKICK);

              const opensAt = new Date(Date.now() - 30 * 1000).toISOString();
              const marketsToCreate: any[] = [];
              const fixtureAdapter = {
                fixtureId: match.txline_fixture_id,
                competition: match.competition,
                participant1: match.home_team,
                participant2: match.away_team,
                startTime: match.kickoff_at,
                participant1IsHome: true,
              };

              if (!hasOpenGoal) {
                marketsToCreate.push({
                  match_id: match.id, market_type: MarketType.GOAL,
                  question: this.generatePredictionQuestion("goal", fixtureAdapter),
                  opens_at: opensAt, closes_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), status: MarketStatus.OPEN,
                });
              }
              if (!hasOpenCorner) {
                marketsToCreate.push({
                  match_id: match.id, market_type: MarketType.CORNER,
                  question: this.generatePredictionQuestion("corner", fixtureAdapter),
                  opens_at: opensAt, closes_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(), status: MarketStatus.OPEN,
                });
              }
              if (!hasOpenThrowin) {
                marketsToCreate.push({
                  match_id: match.id, market_type: MarketType.THROWIN,
                  question: this.generatePredictionQuestion("throwin", fixtureAdapter),
                  opens_at: opensAt, closes_at: new Date(Date.now() + 60 * 1000).toISOString(), status: MarketStatus.OPEN,
                });
              }
              if (!hasOpenFreekick) {
                marketsToCreate.push({
                  match_id: match.id, market_type: MarketType.FREEKICK,
                  question: this.generatePredictionQuestion("freekick", fixtureAdapter),
                  opens_at: opensAt, closes_at: new Date(Date.now() + 120 * 1000).toISOString(), status: MarketStatus.OPEN,
                });
              }

              for (const m of marketsToCreate) {
                const { data: insertedMarket, error: mError } = await supabaseAdmin
                  .from("markets")
                  .insert(m)
                  .select("*")
                  .single();

                if (mError) continue;

                try {
                  await new Promise((r) => setTimeout(r, 1500));
                  await this.solanaService.createMarket(
                    insertedMarket.match_id,
                    insertedMarket.id,
                    new Date(insertedMarket.opens_at),
                    new Date(insertedMarket.closes_at)
                  );
                } catch (e: any) {
                  console.error(`[Pipeline] Failed to create on-chain market:`, e.message);
                }

                const onChainPubkey = this.solanaService.getMarketPda(insertedMarket.match_id, insertedMarket.id).toBase58();
                await supabaseAdmin
                  .from("markets")
                  .update({ on_chain_pubkey: onChainPubkey })
                  .eq("id", insertedMarket.id);
              }
            }
          }

          const events = await this.txlineService.getMatchEvents(match.txline_fixture_id);
          let scoreHome = match.score_home ?? 0;
          let scoreAway = match.score_away ?? 0;
          let matchStatus = match.status;

          const kickoffMs = new Date(match.kickoff_at).getTime();
          const nowMs = Date.now();
          const elapsedMin = (nowMs - kickoffMs) / 60000;

          if (kickoffMs > nowMs) {
            matchStatus = MatchStatus.SCHEDULED;
          } else if (elapsedMin >= 150) {
            // Safety net independent of status: this used to only fire from SCHEDULED, so a
            // match that had genuinely transitioned to LIVE but then never received a real
            // fulltime/game_finalised signal (e.g. its feed just went quiet) stayed "live"
            // indefinitely — one sat stuck for 7+ hours before this caught it.
            matchStatus = MatchStatus.FULL_TIME;
          } else if (
            (matchStatus === MatchStatus.SCHEDULED || matchStatus === MatchStatus.HALFTIME) &&
            elapsedMin >= 0
          ) {
            matchStatus = MatchStatus.LIVE;
          }

          const { data: existingEventsData } = await supabaseAdmin
            .from("match_events")
            .select("event_hash")
            .eq("match_id", match.id);
          const existingHashes = new Set((existingEventsData || []).map((e) => e.event_hash));

          for (const ev of events) {
            // "disconnected" is the feed dropping, not the match ending — treating it as a
            // fulltime signal is what marked a still-live 3-4 match as finished with a stale
            // 0-3 score baked in.
            const isFullTime = ev.eventType === "fulltime" || ev.eventType === "game_finalised";
            if (isFullTime && matchStatus !== MatchStatus.FULL_TIME) {
              matchStatus = MatchStatus.FULL_TIME;
            }

            const payload = ev.payload;
            if (payload && payload.Score) {
              const p1Goals = payload.Score.Participant1?.Total?.Goals;
              const p2Goals = payload.Score.Participant2?.Total?.Goals;
              if (p1Goals !== undefined) scoreHome = Math.max(scoreHome, p1Goals);
              if (p2Goals !== undefined) scoreAway = Math.max(scoreAway, p2Goals);
            }

            const eventHash = this.txlineService.computeEventHash(ev.payload);

            if (!existingHashes.has(eventHash)) {
              const { data: nextNonce, error: rpcError } = await supabaseAdmin.rpc("next_event_nonce");
              if (rpcError) {
                console.error("[Pipeline] Error fetching next nonce:", rpcError.message);
                continue;
              }

              const matchEvent = {
                match_id: match.id,
                event_nonce: nextNonce,
                event_type: ev.eventType,
                event_hash: eventHash,
                payload: ev.payload,
                occurred_at: new Date(ev.occurredAt || Date.now()).toISOString(),
              };

              const { error: eventInsertError } = await supabaseAdmin.from("match_events").insert(matchEvent);

              if (eventInsertError) {
                console.error("[Pipeline] Error inserting event:", eventInsertError.message);
              } else {
                console.log(`[Pipeline] Ingested event ${ev.eventType} with nonce ${nextNonce}`);
                existingHashes.add(eventHash);
                eventsProcessed++;

                const isGoalEvent = ev.eventType === "goal" || ev.eventType === "score_update";
                const isRedCard = ev.eventType === "red_card" || ev.eventType === "redcard";
                const isYellowCard = ev.eventType === "card";
                const isCornerEvent = ev.eventType === "corner";
                const isVarEvent = ev.eventType === "var";

                if (isGoalEvent || isRedCard || isYellowCard || isCornerEvent || isVarEvent) {
                  const payload2 = ev.payload;
                  let eventTeam = match.home_team;
                  if (payload2?.Team === "away" || payload2?.Participant === 2) {
                    eventTeam = match.away_team;
                  }

                  const elapsedNow = Math.max(1, Math.min(90, Math.floor(
                    (Date.now() - new Date(match.kickoff_at).getTime()) / 60000
                  )));

                  const alertType: MatchAlertType = isGoalEvent
                    ? "goal"
                    : isRedCard || isYellowCard
                    ? "card"
                    : isCornerEvent
                    ? "corner"
                    : "var";

                  pushMatchAlert({
                    type: alertType,
                    team: eventTeam,
                    cardType: isRedCard ? "red" : isYellowCard ? "yellow" : undefined,
                    homeTeam: match.home_team,
                    awayTeam: match.away_team,
                    homeScore: scoreHome,
                    awayScore: scoreAway,
                    minute: elapsedNow,
                    competition: match.competition,
                    matchSlug: match.id,
                  }).catch(() => {});
                }
              }
            }
          }

          // Cross-check against the snapshot endpoint, which returns full score history in
          // one call (unlike the historical/streaming endpoint above, which can silently
          // miss events after any downtime) — this is what keeps the recorded score correct
          // even when the event log itself has gaps.
          try {
            const snapshot = await this.txlineService.getScoreSnapshot(match.txline_fixture_id);
            if (snapshot) {
              if (snapshot.home > scoreHome) scoreHome = snapshot.home;
              if (snapshot.away > scoreAway) scoreAway = snapshot.away;
            }
          } catch (snapErr: any) {
            console.error(`[Pipeline] Score snapshot check failed for ${match.txline_fixture_id}, continuing with event-derived score:`, snapErr.message);
          }

          if (matchStatus !== match.status || scoreHome !== (match.score_home ?? 0) || scoreAway !== (match.score_away ?? 0)) {
            await supabaseAdmin
              .from("matches")
              .update({
                status: matchStatus,
                score_home: scoreHome,
                score_away: scoreAway,
                updated_at: new Date().toISOString(),
              })
              .eq("id", match.id);
            console.log(`[Pipeline] Updated match ${match.home_team} vs ${match.away_team}: status=${matchStatus}, score=${scoreHome}-${scoreAway}`);

            if (matchStatus === MatchStatus.FULL_TIME && match.status !== MatchStatus.FULL_TIME) {
              pushMatchAlert({
                type: "fulltime",
                homeTeam: match.home_team,
                awayTeam: match.away_team,
                homeScore: scoreHome,
                awayScore: scoreAway,
                competition: match.competition,
                matchSlug: match.id,
              }).catch(() => {});
            }
          }
        }
      }
      await this.settleExpiredMarkets();
      await this.settleStreakPicks();
    } catch (error: any) {
      console.error("[Pipeline] Error in syncFeed loop:", error.message);
    } finally {
      this.isSyncing = false;
    }
    return { eventsProcessed };
  }

  /** Grades unsettled daily-streak picks once their match reaches full time. */
  public async settleStreakPicks(): Promise<void> {
    const { data: picks, error } = await supabaseAdmin
      .from("streak_picks")
      .select("id, pick, match:matches(status, score_home, score_away)")
      .eq("settled", false);

    // Table may not exist yet (migration pending) — stay quiet rather than spam every tick.
    if (error || !picks) return;

    for (const p of picks as any[]) {
      const match = p.match;
      if (!match || match.status !== MatchStatus.FULL_TIME) continue;

      const sh = Number(match.score_home ?? 0);
      const sa = Number(match.score_away ?? 0);
      const result = sh > sa ? "home" : sa > sh ? "away" : "draw";

      await supabaseAdmin
        .from("streak_picks")
        .update({ settled: true, correct: p.pick === result })
        .eq("id", p.id);
      console.log(`[Streak] Settled pick ${p.id}: picked ${p.pick}, result ${result}`);
    }
  }

  public async settleExpiredMarkets(): Promise<void> {
    const graceTime = new Date(Date.now() - 15000).toISOString();
    // Tournament-winner markets close at the final's kickoff but must settle with
    // the real winner (via tournament.service), not auto-NO on expiry.
    const { data: expiredMarkets, error } = await supabaseAdmin
      .from("markets")
      .select("*")
      .eq("status", MarketStatus.OPEN)
      .neq("match_id", "wc2026-winner")
      .lte("closes_at", graceTime);

    if (error || !expiredMarkets) return;

    for (const market of expiredMarkets) {
      console.log(`[Pipeline] Market ${market.id} (${market.market_type}) has expired. Settling as NO.`);

      const { data: nextNonce } = await supabaseAdmin.rpc("next_event_nonce");
      const dummyPayload = { type: "timeout", market_id: market.id, closes_at: market.closes_at };
      const eventHash = this.txlineService.computeEventHash(dummyPayload);
      const occurredAt = new Date(new Date(market.opens_at).getTime() + 1000).toISOString();

      const newEvent = {
        match_id: market.match_id,
        event_nonce: nextNonce,
        event_type: "fulltime",
        event_hash: eventHash,
        payload: dummyPayload,
        occurred_at: occurredAt,
      };

      const { data: resolvingEvent } = await supabaseAdmin.from("match_events").insert(newEvent).select("*").single();

      if (!resolvingEvent) {
        console.error(`[Pipeline] Failed to insert timeout event for market ${market.id}, skipping.`);
        continue;
      }

      let anchoredOnChain = false;
      try {
        const FULLTIME_TYPE_INT = 3;
        const anchorTxSig = await this.solanaService.anchorEvent(
          market.match_id,
          Number(resolvingEvent.event_nonce),
          FULLTIME_TYPE_INT,
          resolvingEvent.event_hash,
          new Date(resolvingEvent.occurred_at)
        );
        await supabaseAdmin
          .from("match_events")
          .update({ on_chain_tx_sig: anchorTxSig, anchored_at: new Date().toISOString() })
          .eq("id", resolvingEvent.id);
        console.log(`[Pipeline] Anchored per-market timeout event on-chain: ${anchorTxSig}`);
        anchoredOnChain = true;
      } catch (anchorErr: any) {
        console.error("[Pipeline] Failed to anchor timeout event on-chain:", anchorErr.message);
      }

      let settleTxSig: string | null = null;
      if (anchoredOnChain) {
        try {
          settleTxSig = await this.solanaService.settleMarket(
            market.match_id,
            market.id,
            Number(resolvingEvent.event_nonce),
            false
          );
          console.log(`[Pipeline] Settled expired market on-chain: ${settleTxSig}`);
        } catch (e: any) {
          console.error("[Pipeline] On-chain settlement failed:", e.message);
        }
      }

      await supabaseAdmin
        .from("markets")
        .update({
          status: MarketStatus.SETTLED,
          outcome: false,
          resolution_event_hash: settleTxSig,
        })
        .eq("id", market.id);

      await this.mintNFTsForMarket(market, settleTxSig ?? "");
    }
  }

  public async mintNFTsForMarket(market: any, settlementTxSig: string): Promise<void> {
    const { data: stakes, error } = await supabaseAdmin.from("stakes").select("*").eq("market_id", market.id);
    if (error || !stakes) return;

    for (const stake of stakes) {
      if (stake.nft_mint_address) {
        console.log(`[NFT] Stake ${stake.id} already has NFT: ${stake.nft_mint_address}`);
        continue;
      }

      await supabaseAdmin
        .from("stakes")
        .update({ settlement_tx_signature: settlementTxSig })
        .eq("id", stake.id);

      try {
        const { data: fullMarket } = await supabaseAdmin
          .from("markets")
          .select(`*, match:matches(*), stakes(*)`)
          .eq("id", market.id)
          .single();

        if (!fullMarket || !fullMarket.match) continue;

        const stakeData = {
          id: stake.id,
          user_wallet: stake.user_wallet,
          side: stake.side,
          amount_lamports: stake.amount_lamports.toString(),
          settlement_tx_signature: settlementTxSig,
          market: {
            id: fullMarket.id,
            question: fullMarket.question,
            outcome: fullMarket.outcome,
            market_type: fullMarket.market_type,
            match: {
              id: fullMarket.match.id,
              home_team: fullMarket.match.home_team,
              away_team: fullMarket.match.away_team,
              competition: fullMarket.match.competition,
              score_home: fullMarket.match.score_home,
              score_away: fullMarket.match.score_away,
              kickoff_at: new Date(fullMarket.match.kickoff_at),
            },
            stakes: fullMarket.stakes || [],
          },
        };

        const { mintAddress, metadataUri } = await mintReceiptNFT(stakeData as any);

        await supabaseAdmin
          .from("stakes")
          .update({ nft_mint_address: mintAddress, nft_metadata_uri: metadataUri })
          .eq("id", stake.id);

        console.log(`[NFT] Minted receipt for stake ${stake.id}: ${mintAddress}`);
      } catch (e: any) {
        console.error(`[NFT] Failed to mint NFT for stake ${stake.id}:`, e.message);
      }
    }
  }

  private generatePredictionQuestion(
    marketType: string,
    fixture: {
      participant1: string;
      participant2: string;
      competition: string;
      scoreHome?: number;
      scoreAway?: number;
      minute?: number;
      startTime: string;
    }
  ): string {
    const home = fixture.participant1;
    const away = fixture.participant2;
    const competition = fixture.competition;

    const minuteMs = Date.now() - new Date(fixture.startTime).getTime();
    const minute = fixture.minute ?? Math.max(1, Math.min(90, Math.floor(minuteMs / 60000)));

    const scoreHome = fixture.scoreHome ?? 0;
    const scoreAway = fixture.scoreAway ?? 0;
    const scoreline = `${scoreHome}–${scoreAway}`;
    const isDrawing = scoreHome === scoreAway;
    const leader = scoreHome > scoreAway ? home : scoreAway > scoreHome ? away : null;

    if (marketType === "goal") {
      if (isDrawing) {
        return `${home} and ${away} are level at ${scoreline} in the ${minute}′ — will either side break the deadlock in the next 10 minutes?`;
      }
      return `${leader} lead ${home} vs ${away} ${scoreline} at the ${minute}′ — will there be another goal in the next 10 minutes of this ${competition} clash?`;
    }
    if (marketType === "corner") {
      return `${home} vs ${away} (${scoreline}, ${minute}′) — will either side win a corner kick in the next 2 minutes of this ${competition} fixture?`;
    }
    if (marketType === "throwin") {
      return `${home} vs ${away} (${scoreline}, ${minute}′) — will play result in a throw-in within the next 60 seconds?`;
    }
    if (marketType === "freekick") {
      return `${home} vs ${away} (${scoreline}, ${minute}′) — will the referee award a free-kick in the next 120 seconds of ${competition} action?`;
    }
    return `${home} vs ${away} — will there be a ${marketType} event in the next few minutes?`;
  }
}
