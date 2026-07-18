import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { GroqService } from "../services/groq.service";
import { getTxlineService } from "../services/instances";
import { TOURNAMENT_MATCH_ID } from "../services/tournament.service";
import { cachedGroqCall } from "../lib/groq-cache";
import { computeTeamStats, computeMomentum, computeTimeline, computeWinProbability } from "../services/match-pulse.service";

const router = Router();

function buildRationale(m: any): string {
  const isLive = m.status === "live" || m.status === "halftime";
  const openCount = Number(m.open_markets_count ?? 0);
  const totalPool = Number(m.total_pool_lamports ?? 0) / 1e9;

  if (isLive) {
    if (m.minute && m.minute > 75)
      return `${90 - m.minute} min left — high-volatility window`;
    if (totalPool > 10)
      return `${totalPool.toFixed(1)} SOL pooled · ${openCount} open markets`;
    if (openCount > 0)
      return `${openCount} market${openCount !== 1 ? "s" : ""} open · ${m.competition}`;
    return `Live now · ${m.competition}`;
  }

  // upcoming
  const hoursUntil = (new Date(m.kickoff_at).getTime() - Date.now()) / 3600000;
  if (hoursUntil < 1)
    return `Kicks off in ${Math.round(hoursUntil * 60)} min — markets open at whistle`;
  if (hoursUntil < 24)
    return `World Cup fixture — markets open at kickoff`;
  const days = Math.floor(hoursUntil / 24);
  return `Kicks off in ${days}d — World Cup 2026`;
}

const WC_LABELS = ["world cup", "fifa world cup", "world cup 2026"];
function isWorldCup(comp: string) {
  return WC_LABELS.some((l) => comp?.toLowerCase().includes(l));
}

// GET /matches/recommended
router.get("/recommended", async (req, res) => {
  try {
    // Fetch live matches
    const { data: liveMatches } = await supabaseAdmin
      .from("matches")
      .select(`
        *,
        markets(id, status)
      `)
      .neq("id", TOURNAMENT_MATCH_ID)
      .in("status", ["live", "halftime"])
      .order("kickoff_at", { ascending: true });

    // Fetch upcoming WC matches within 7 days
    const cutoff = new Date(Date.now() + 7 * 86400000).toISOString();
    const { data: upcomingMatches } = await supabaseAdmin
      .from("matches")
      .select(`
        *,
        markets(id, status)
      `)
      .neq("id", TOURNAMENT_MATCH_ID)
      .eq("status", "scheduled")
      .lte("kickoff_at", cutoff)
      .order("kickoff_at", { ascending: true })
      .limit(10);

    const allLive = (liveMatches ?? []);
    const allUpcoming = (upcomingMatches ?? []).filter((m) =>
      isWorldCup(m.competition)
    );

    // If nothing live or upcoming WC, fall back to next 5 WC fixtures regardless of timing
    let candidates = [...allLive, ...allUpcoming];
    if (candidates.length === 0) {
      const { data: fallback } = await supabaseAdmin
        .from("matches")
        .select(`*, markets(id, status)`)
        .neq("id", TOURNAMENT_MATCH_ID)
        .in("status", ["scheduled", "live", "halftime"])
        .order("kickoff_at", { ascending: true })
        .limit(10);

      candidates = (fallback ?? []).filter((m) => isWorldCup(m.competition)).slice(0, 5);
      // If still nothing, just take any upcoming
      if (candidates.length === 0) {
        candidates = (fallback ?? []).slice(0, 5);
      }
    }

    const recommended = candidates.slice(0, 5).map((m) => {
      const openCount = (m.markets ?? []).filter(
        (mk: any) => mk.status === "open"
      ).length;
      return {
        id: m.id,
        home_team: m.home_team,
        away_team: m.away_team,
        competition: m.competition,
        kickoff_at: m.kickoff_at,
        status: m.status,
        score_home: m.score_home,
        score_away: m.score_away,
        open_markets_count: openCount,
        rationale: buildRationale({ ...m, open_markets_count: openCount }),
      };
    });

    res.json(recommended);
  } catch (err: any) {
    console.error("[/api/matches/recommended]", err.message);
    res.status(200).json([]);
  }
});

// GET /matches/search
router.get("/search", async (req, res) => {
  const team = typeof req.query.team === "string" ? req.query.team : null;

  if (!team) {
    res.status(400).json(null);
    return;
  }

  try {
    // Search live matches first, then any match
    const { data: matches } = await supabaseAdmin
      .from("matches")
      .select(`
        *,
        markets(id, status, market_type, question, stakes(side, amount_lamports))
      `)
      .neq("id", TOURNAMENT_MATCH_ID)
      .or(
        `home_team.ilike.%${team}%,away_team.ilike.%${team}%`
      )
      .order("kickoff_at", { ascending: false })
      .limit(5);

    if (!matches || matches.length === 0) {
      res.json(null);
      return;
    }

    // Prefer live match, then most recent
    const match =
      matches.find((m) => m.status === "live" || m.status === "halftime") ??
      matches[0];

    const openMarkets = (match.markets ?? []).filter(
      (mk: any) => mk.status === "open"
    );

    // Build market odds
    const markets = openMarkets.slice(0, 4).map((mk: any) => {
      const stakes = mk.stakes ?? [];
      const yesL = stakes
        .filter((s: any) => s.side === "yes")
        .reduce((sum: number, s: any) => sum + Number(s.amount_lamports), 0);
      const noL = stakes
        .filter((s: any) => s.side === "no")
        .reduce((sum: number, s: any) => sum + Number(s.amount_lamports), 0);
      const total = yesL + noL;
      return {
        id: mk.id,
        question: mk.question,
        market_type: mk.market_type,
        yesProbability: total > 0 ? yesL / total : 0.5,
        noProbability: total > 0 ? noL / total : 0.5,
      };
    });

    // Last event
    const { data: events } = await supabaseAdmin
      .from("match_events")
      .select("event_type, occurred_at, payload")
      .eq("match_id", match.id)
      .order("occurred_at", { ascending: false })
      .limit(1);

    const lastEvent = events?.[0]
      ? {
          type: events[0].event_type,
          occurredAt: events[0].occurred_at,
        }
      : null;

    // Compute elapsed minute
    let minute: number | null = null;
    if (match.status === "live") {
      const diffMs = Date.now() - new Date(match.kickoff_at).getTime();
      minute = Math.max(1, Math.min(90, Math.floor(diffMs / 60000)));
    }

    res.json({
      id: match.id,
      slug: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      homeScore: match.score_home ?? 0,
      awayScore: match.score_away ?? 0,
      competition: match.competition,
      status: match.status,
      kickoffAt: match.kickoff_at,
      minute,
      openMarketsCount: openMarkets.length,
      markets,
      lastEvent,
    });
  } catch (err: any) {
    console.error("[/api/matches/search]", err.message);
    res.status(500).json(null);
  }
});

// GET /matches
router.get("/", async (req, res) => {
  try {
    const { data: matches, error } = await supabaseAdmin
      .from("matches")
      .select(`
        *,
        markets (
          *,
          stakes (
            *
          )
        )
      `)
      .neq("id", TOURNAMENT_MATCH_ID)
      .order("kickoff_at", { ascending: true });

    if (error) {
      res.status(500).json({ error: error.message || "Database error" });
      return;
    }

    const seen = new Set<string>();
    const unique = (matches ?? []).filter((m: any) => {
      const key = `${m.home_team}::${m.away_team}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json(unique);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// GET /matches/:id
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: match, error: matchError } = await supabaseAdmin
      .from("matches")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (matchError) {
      res.status(500).json({ error: matchError.message || "Database error" });
      return;
    }

    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    const { data: markets, error: marketsError } = await supabaseAdmin
      .from("markets")
      .select(`
        *,
        stakes (
          *
        )
      `)
      .eq("match_id", id)
      .order("opens_at", { ascending: true });

    if (marketsError) {
      res.status(500).json({ error: marketsError.message || "Database error" });
      return;
    }

    const { data: events, error: eventsError } = await supabaseAdmin
      .from("match_events")
      .select("*")
      .eq("match_id", id)
      .order("occurred_at", { ascending: true });

    if (eventsError) {
      res.status(500).json({ error: eventsError.message || "Database error" });
      return;
    }

    res.json({ ...match, markets, events });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// GET /matches/:id/copilot
router.get("/:id/copilot", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: match, error: matchError } = await supabaseAdmin
      .from("matches")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (matchError || !match) {
      console.warn("Match query for copilot failed, using mock copilot fallback:", matchError?.message);
      res.status(404).json({ error: matchError?.message || "Match not found" });
      return;
    }

    const { data: events, error: eventsError } = await supabaseAdmin
      .from("match_events")
      .select("*")
      .eq("match_id", id)
      .order("occurred_at", { ascending: true });

    if (eventsError) {
      console.warn("Events query for copilot failed, using mock copilot fallback:", eventsError.message);
      res.status(500).json({ error: eventsError.message || "Database error" });
      return;
    }

    const diffMs = Date.now() - new Date(match.kickoff_at).getTime();
    const minute = Math.max(1, Math.min(90, Math.floor(diffMs / 60000)));
    // Finished matches never change — cache their copilot read forever. Live ones get a
    // short TTL so the "live commentary" feel survives while still absorbing the
    // frontend's 6s poll (each poll no longer means a fresh Groq call).
    const isFinished = match.status === "full_time";

    try {
      const copilotInfo = await cachedGroqCall(
        `copilot:${id}`,
        isFinished ? null : 20_000,
        () =>
          GroqService.generateCopilotInfo(
            match.home_team,
            match.away_team,
            match.score_home ?? 0,
            match.score_away ?? 0,
            minute,
            events || [],
            match.competition
          )
      );

      res.json({ ...copilotInfo, updatedAt: Date.now() });
    } catch (e: any) {
      console.warn("Groq copilot generation failed, using mock copilot fallback:", e.message);
      res.status(500).json({ error: e.message || "Groq copilot error" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// GET /matches/:id/pulse
router.get("/:id/pulse", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: match, error: matchError } = await supabaseAdmin
      .from("matches")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (matchError || !match) {
      res.status(404).json({ error: matchError?.message || "Match not found" });
      return;
    }

    const { data: events, error: eventsError } = await supabaseAdmin
      .from("match_events")
      .select("*")
      .eq("match_id", id)
      .order("occurred_at", { ascending: true });

    if (eventsError) {
      res.status(500).json({ error: eventsError.message || "Database error" });
      return;
    }

    const allEvents = events || [];
    const kickoffMs = new Date(match.kickoff_at).getTime();
    const diffMs = Date.now() - kickoffMs;
    const minute = Math.max(1, Math.min(90, Math.floor(diffMs / 60000)));
    const isFinished = match.status === "full_time";

    const stats = computeTeamStats(allEvents);
    const { points: momentum, current: momentumCurrent } = computeMomentum(allEvents, kickoffMs, isFinished ? 90 : minute);
    const timeline = computeTimeline(allEvents, kickoffMs);
    const winProbability = computeWinProbability(
      match.status,
      match.score_home ?? 0,
      match.score_away ?? 0,
      minute,
      momentumCurrent
    );

    const keyEventsForPrompt = timeline
      .filter((t) => t.type === "goal" || t.type === "red_card" || t.type === "redcard")
      .map((t) => ({ type: t.type, minute: t.minute, team: t.team }));

    let narrative: { summary: string; keyMoments: string[] };
    try {
      narrative = await cachedGroqCall(
        `pulse:${id}`,
        isFinished ? null : 30_000,
        () =>
          GroqService.generateMatchPulseNarrative(
            match.home_team,
            match.away_team,
            match.score_home ?? 0,
            match.score_away ?? 0,
            match.status,
            minute,
            keyEventsForPrompt,
            match.competition
          )
      );
    } catch (e: any) {
      console.warn("Match Pulse narrative unavailable, omitting:", e.message);
      narrative = { summary: "", keyMoments: [] };
    }

    res.json({
      status: match.status,
      minute,
      score: { home: match.score_home ?? 0, away: match.score_away ?? 0 },
      teams: { home: match.home_team, away: match.away_team },
      stats,
      momentum,
      momentumCurrent,
      winProbability,
      timeline,
      summary: narrative.summary,
      keyMoments: narrative.keyMoments,
      updatedAt: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// GET /matches/:id/history
router.get("/:id/history", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: match, error: matchError } = await supabaseAdmin
      .from("matches")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (matchError || !match) {
      res.status(404).json({ error: matchError?.message || "Match not found" });
      return;
    }

    const txline = await getTxlineService();

    const events = await txline.getMatchEvents(match.txline_fixture_id);

    let goals = 0;
    let corners = 0;
    let cards = 0;

    const scoreEvent = [...events].reverse().find((e: any) => e.payload && e.payload.Score);
    if (scoreEvent && scoreEvent.payload.Score) {
      const s = scoreEvent.payload.Score;
      const p1 = s.Participant1?.Total || {};
      const p2 = s.Participant2?.Total || {};

      goals = (p1.Goals ?? 0) + (p2.Goals ?? 0);
      corners = (p1.Corners ?? 0) + (p2.Corners ?? 0);
      cards = (p1.YellowCards ?? 0) + (p1.RedCards ?? 0) + (p2.YellowCards ?? 0) + (p2.RedCards ?? 0);
    }

    const { data: pastMatches } = await supabaseAdmin
      .from("matches")
      .select("*")
      .or(`and(home_team.eq."${match.home_team}",away_team.eq."${match.away_team}"),and(home_team.eq."${match.away_team}",away_team.eq."${match.home_team}")`)
      .eq("status", "full_time")
      .order("kickoff_at", { ascending: false });

    const h2h = (pastMatches || []).map((m: any) => {
      const year = new Date(m.kickoff_at).getFullYear();
      return `${m.home_team} ${m.score_home || 0}-${m.score_away || 0} ${m.away_team} (${year})`;
    });

    // Form guides
    const { data: homePast } = await supabaseAdmin
      .from("matches")
      .select("*")
      .or(`home_team.eq."${match.home_team}",away_team.eq."${match.home_team}"`)
      .eq("status", "full_time")
      .order("kickoff_at", { ascending: false })
      .limit(5);

    const homeForm = (homePast || []).map((m: any) => {
      const isHome = m.home_team === match.home_team;
      const myScore = isHome ? m.score_home : m.score_away;
      const oppScore = isHome ? m.score_away : m.score_home;
      if (myScore > oppScore) return "W";
      if (myScore < oppScore) return "L";
      return "D";
    });

    const { data: awayPast } = await supabaseAdmin
      .from("matches")
      .select("*")
      .or(`home_team.eq."${match.away_team}",away_team.eq."${match.away_team}"`)
      .eq("status", "full_time")
      .order("kickoff_at", { ascending: false })
      .limit(5);

    const awayForm = (awayPast || []).map((m: any) => {
      const isHome = m.home_team === match.away_team;
      const myScore = isHome ? m.score_home : m.score_away;
      const oppScore = isHome ? m.score_away : m.score_home;
      if (myScore > oppScore) return "W";
      if (myScore < oppScore) return "L";
      return "D";
    });

    res.json({
      h2h,
      form: {
        home: homeForm,
        away: awayForm
      },
      stats: {
        goals: goals.toString(),
        corners: corners.toString(),
        cards: cards.toString()
      },
      updatedAt: Date.now()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
