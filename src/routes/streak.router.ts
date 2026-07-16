import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { TOURNAMENT_MATCH_ID } from "../services/tournament.service";

const router = Router();

const XP_PER_CORRECT = 10;

/**
 * Streak/XP is derived from settled picks on demand instead of being kept in a
 * stats table — one less table to migrate, and impossible to drift out of sync.
 * Picks are keyed by wallet address with no signature check: XP is a free,
 * non-monetary score, so the worst abuse is padding a leaderboard.
 */
function computeStats(picks: { settled: boolean; correct: boolean | null; created_at: string }[]) {
  const settled = picks
    .filter((p) => p.settled)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  let current = 0;
  let best = 0;
  let correctCount = 0;
  for (const p of settled) {
    if (p.correct) {
      current++;
      correctCount++;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return {
    currentStreak: current,
    bestStreak: best,
    correctCount,
    settledCount: settled.length,
    xp: correctCount * XP_PER_CORRECT + best * 5,
  };
}

// GET /api/streak/fixtures — upcoming fixtures eligible for a pick (next 72h)
router.get("/fixtures", async (_req, res) => {
  try {
    const cutoff = new Date(Date.now() + 72 * 3600000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("matches")
      .select("id, home_team, away_team, competition, kickoff_at, status")
      .neq("id", TOURNAMENT_MATCH_ID)
      .eq("status", "scheduled")
      .gt("kickoff_at", new Date().toISOString())
      .lte("kickoff_at", cutoff)
      .order("kickoff_at", { ascending: true })
      .limit(10);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data ?? []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/streak/pick — { wallet, match_id, pick: "home" | "draw" | "away" }
router.post("/pick", async (req, res) => {
  const { wallet, match_id, pick } = req.body || {};
  if (!wallet || !match_id || !["home", "draw", "away"].includes(pick)) {
    res.status(400).json({ error: "wallet, match_id and pick (home|draw|away) are required" });
    return;
  }

  try {
    const { data: match } = await supabaseAdmin
      .from("matches")
      .select("id, status, kickoff_at")
      .eq("id", match_id)
      .maybeSingle();

    if (!match || match.id === TOURNAMENT_MATCH_ID) {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    if (match.status !== "scheduled" || new Date(match.kickoff_at).getTime() <= Date.now()) {
      res.status(400).json({ error: "Picks close at kickoff" });
      return;
    }

    // One pick per wallet per UTC day keeps it a *daily* streak game.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { data: todaysPicks } = await supabaseAdmin
      .from("streak_picks")
      .select("id")
      .eq("wallet", wallet)
      .gte("created_at", dayStart.toISOString());

    if (todaysPicks && todaysPicks.length > 0) {
      res.status(409).json({ error: "You already made today's pick — come back tomorrow" });
      return;
    }

    const { data: inserted, error } = await supabaseAdmin
      .from("streak_picks")
      .insert({ wallet, match_id, pick })
      .select("*")
      .single();

    if (error) {
      const isDup = error.message.includes("duplicate") || error.code === "23505";
      res.status(isDup ? 409 : 500).json({ error: isDup ? "Already picked this match" : error.message });
      return;
    }
    res.json(inserted);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/streak/me/:wallet — my picks + derived streak/xp
router.get("/me/:wallet", async (req, res) => {
  try {
    const { data: picks, error } = await supabaseAdmin
      .from("streak_picks")
      .select("*, match:matches(home_team, away_team, kickoff_at, score_home, score_away, status)")
      .eq("wallet", req.params.wallet)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const stats = computeStats(picks ?? []);
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const pickedToday = (picks ?? []).some((p) => new Date(p.created_at) >= dayStart);

    res.json({ ...stats, pickedToday, picks: picks ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/streak/leaderboard — top wallets by current streak, then XP
router.get("/leaderboard", async (_req, res) => {
  try {
    const { data: picks, error } = await supabaseAdmin
      .from("streak_picks")
      .select("wallet, settled, correct, created_at")
      .eq("settled", true);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const byWallet = new Map<string, typeof picks>();
    (picks ?? []).forEach((p) => {
      const list = byWallet.get(p.wallet) ?? [];
      list.push(p);
      byWallet.set(p.wallet, list);
    });

    const rows = Array.from(byWallet.entries()).map(([wallet, walletPicks]) => ({
      wallet,
      ...computeStats(walletPicks),
    }));

    rows.sort((a, b) => b.currentStreak - a.currentStreak || b.xp - a.xp);
    res.json(rows.slice(0, 20));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
