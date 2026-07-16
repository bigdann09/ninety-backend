import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { getTxlineService, getSolanaService } from "../services/instances";
import {
  TOURNAMENT_MATCH_ID,
  TOURNAMENT_TEAMS,
  teamFromQuestion,
  settleTournament,
} from "../services/tournament.service";

const router = Router();

// GET /stats
router.get("/stats", async (req, res) => {
  try {
    const [stakesRes, marketsRes, walletsRes] = await Promise.all([
      supabaseAdmin
        .from("stakes")
        .select("amount_lamports"),
      supabaseAdmin
        .from("markets")
        .select("id", { count: "exact", head: true })
        .eq("status", "settled"),
      supabaseAdmin
        .from("stakes")
        .select("user_wallet")
        .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
    ]);

    const totalLamports = (stakesRes.data ?? []).reduce(
      (sum, s) => sum + Number(s.amount_lamports ?? 0),
      0
    );
    const totalStakedSol = totalLamports / 1e9;
    const marketsSettled = marketsRes.count ?? 0;

    // Count distinct wallets from last 24h
    const walletSet = new Set(
      (walletsRes.data ?? []).map((s) => s.user_wallet)
    );
    const activeWallets24h = walletSet.size;

    res.json({
      totalStakedSol,
      marketsSettled,
      activeWallets24h,
    });
  } catch (err: any) {
    console.error("[/api/stats]", err.message);
    res.status(200).json(
      { totalStakedSol: 0, marketsSettled: 0, activeWallets24h: 0 }
    );
  }
});

// GET /tournament
router.get("/tournament", async (req, res) => {
  try {
    const { data: matches, error: matchesErr } = await supabaseAdmin
      .from("matches")
      .select("id, home_team, away_team, status, score_home, score_away");

    if (matchesErr) {
      res.status(500).json({ error: matchesErr.message });
      return;
    }

    // Baseline tournament teams & strengths
    const baseProbs: Record<string, number> = {
      France: 0.22,
      Brazil: 0.18,
      Argentina: 0.16,
      England: 0.13,
      Spain: 0.11,
      Germany: 0.09,
      Portugal: 0.07,
      Belgium: 0.06,
      Netherlands: 0.06,
      Italy: 0.05,
      Croatia: 0.05,
      Uruguay: 0.05,
      Switzerland: 0.04,
      USA: 0.04,
      Mexico: 0.04,
      Morocco: 0.04,
      Japan: 0.03,
      Australia: 0.03,
      Norway: 0.03,
      Senegal: 0.03,
      Canada: 0.02,
      Cameroon: 0.02,
      Ecuador: 0.02,
      Korea: 0.02,
    };

    const teams = Object.keys(baseProbs);
    const { data: stakes, error: stakesErr } = await supabaseAdmin
      .from("stakes")
      .select(`
        amount_lamports,
        side,
        market:markets (
          market_type,
          match:matches (
            home_team,
            away_team
          )
        )
      `);

    const teamStakes: Record<string, number> = {};
    teams.forEach(t => { teamStakes[t] = 0; });

    let totalStakesAll = 0;
    stakes?.forEach((s: any) => {
      const amt = Number(s.amount_lamports || 0);
      const home = s.market?.match?.home_team;
      const away = s.market?.match?.away_team;
      if (!home || !away) return;

      if (teams.includes(home)) {
        teamStakes[home] = (teamStakes[home] || 0) + amt;
        totalStakesAll += amt;
      }
      if (teams.includes(away)) {
        teamStakes[away] = (teamStakes[away] || 0) + amt;
        totalStakesAll += amt;
      }
    });

    const performanceModifiers: Record<string, number> = {};
    teams.forEach(t => { performanceModifiers[t] = 1.0; });

    matches?.forEach(m => {
      const home = m.home_team;
      const away = m.away_team;
      if (!home || !away) return;

      const isHomeT = teams.includes(home);
      const isAwayT = teams.includes(away);
      if (!isHomeT && !isAwayT) return;

      const sh = Number(m.score_home || 0);
      const sa = Number(m.score_away || 0);

      if (m.status === "full_time" || m.status === "ended") {
        if (sh > sa) {
          if (isHomeT) performanceModifiers[home] *= 1.3;
          if (isAwayT) performanceModifiers[away] *= 0.5;
        } else if (sa > sh) {
          if (isAwayT) performanceModifiers[away] *= 1.3;
          if (isHomeT) performanceModifiers[home] *= 0.5;
        } else {
          // Draw
          if (isHomeT) performanceModifiers[home] *= 0.9;
          if (isAwayT) performanceModifiers[away] *= 0.9;
        }
      } else if (m.status === "live" || m.status === "ht") {
        if (sh > sa) {
          if (isHomeT) performanceModifiers[home] *= 1.15;
          if (isAwayT) performanceModifiers[away] *= 0.75;
        } else if (sa > sh) {
          if (isAwayT) performanceModifiers[away] *= 1.15;
          if (isHomeT) performanceModifiers[home] *= 0.75;
        }
      }
    });

    const result = teams.map(team => {
      const base = baseProbs[team];
      const modifier = performanceModifiers[team];
      const liveStrength = base * modifier;

      const stakeWeight = totalStakesAll > 0 ? (teamStakes[team] / totalStakesAll) : 0;

      const rawProb = 0.6 * liveStrength + 0.4 * (stakeWeight > 0 ? stakeWeight : liveStrength);
      return { name: team, prob: rawProb };
    });

    const totalProb = result.reduce((sum, item) => sum + item.prob, 0);
    const normalized = result.map(item => ({
      name: item.name,
      prob: totalProb > 0 ? (item.prob / totalProb) : (1 / result.length)
    }));

    normalized.sort((a, b) => b.prob - a.prob);

    // Attach the real stakeable winner market per team (created by tournament.service)
    // so the frontend card can place actual on-chain stakes instead of being display-only.
    const { data: winnerMarkets } = await supabaseAdmin
      .from("markets")
      .select("id, question, status, outcome, stakes(side, amount_lamports)")
      .eq("match_id", TOURNAMENT_MATCH_ID);

    const marketByTeam: Record<string, any> = {};
    (winnerMarkets || []).forEach((mk: any) => {
      const team = teamFromQuestion(mk.question);
      if (!team) return;
      const stakeRows = mk.stakes || [];
      const yesLamports = stakeRows
        .filter((s: any) => s.side === "yes")
        .reduce((sum: number, s: any) => sum + Number(s.amount_lamports), 0);
      marketByTeam[team] = {
        marketId: mk.id,
        marketStatus: mk.status,
        outcome: mk.outcome,
        yesVotes: stakeRows.filter((s: any) => s.side === "yes").length,
        yesPoolSol: yesLamports / 1e9,
      };
    });

    const enriched = normalized.map((t) => ({
      ...t,
      matchId: TOURNAMENT_MATCH_ID,
      ...(marketByTeam[t.name] ?? {}),
    }));

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /tournament/settle — keeper-only: settles every winner market at once.
router.post("/tournament/settle", async (req, res) => {
  const { winner, key } = req.body || {};
  if (!process.env.BOT_KEY || key !== process.env.BOT_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!winner || !TOURNAMENT_TEAMS.includes(winner)) {
    res.status(400).json({ error: `winner must be one of: ${TOURNAMENT_TEAMS.join(", ")}` });
    return;
  }
  try {
    const solana = getSolanaService();
    const txline = await getTxlineService();
    const result = await settleTournament(solana, (p) => txline.computeEventHash(p), winner);
    res.json({ ok: true, winner, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/db-status
const EXPECTED_TABLES = ["matches", "markets", "stakes", "match_events", "p2p_challenges", "chat_messages"];

router.get("/admin/db-status", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("information_schema.tables" as any)
      .select("table_name")
      .eq("table_schema", "public")
      .eq("table_type", "BASE TABLE");

    if (error) {
      const { error: match_error } = await supabaseAdmin.from("matches").select("id").limit(1);
      if (match_error) {
        res.json({
          connected: false,
          tables: [],
          error: match_error.message,
        });
        return;
      }
      const found: string[] = [];
      for (const tbl of EXPECTED_TABLES) {
        const { error: tblErr } = await supabaseAdmin.from(tbl as any).select("*").limit(0);
        if (!tblErr) found.push(tbl);
      }
      res.json({ connected: true, tables: found });
      return;
    }

    const table_names = (data || [])
      .map((row: any) => row.table_name as string)
      .filter((t: string) => EXPECTED_TABLES.includes(t));

    res.json({ connected: true, tables: table_names });
  } catch (err: any) {
    res.json({ connected: false, tables: [], error: err.message });
  }
});

// POST /notifications/telegram
router.post("/notifications/telegram", async (req, res) => {
  try {
    const { chatId, team } = req.body ?? {};
    if (!chatId || !team) {
      res.status(400).json({ error: "chatId and team required" });
      return;
    }

    await supabaseAdmin
      .from("telegram_notifications")
      .upsert(
        { chat_id: String(chatId), team: team.trim().toLowerCase() },
        { onConflict: "chat_id,team" }
      );

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[/api/notifications/telegram]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /notifications/telegram
router.delete("/notifications/telegram", async (req, res) => {
  try {
    const { chatId, team } = req.body ?? {};
    if (!chatId || !team) {
      res.status(400).json({ error: "chatId and team required" });
      return;
    }

    await supabaseAdmin
      .from("telegram_notifications")
      .delete()
      .eq("chat_id", String(chatId))
      .eq("team", team.trim().toLowerCase());

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /proof/:fixtureId/:nonce
router.get("/proof/:fixtureId/:nonce", async (req, res) => {
  const { fixtureId, nonce } = req.params;
  try {
    const txline = await getTxlineService();

    const proof = await txline.getEventProof(fixtureId, parseInt(nonce) || 0);
    res.json(proof);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch proof" });
  }
});

// GET /receipts/:walletAddress
router.get("/receipts/:walletAddress", async (req, res) => {
  const { walletAddress } = req.params;
  try {
    const { data: stakes, error } = await supabaseAdmin
      .from("stakes")
      .select(`
        *,
        market:markets (
          *,
          match:matches (
            *
          ),
          stakes (
            *
          )
        )
      `)
      .eq("user_wallet", walletAddress);

    if (error || !stakes) {
      res.status(500).json({ error: error?.message || "No stakes found" });
      return;
    }

    const receipts = stakes
      .filter((s: any) => s.market?.status === "settled")
      .map((s: any) => {
        const stakeSol = Number(s.amount_lamports) / 1e9;
        const won = (s.side === "yes" && s.market.outcome === true) ||
                    (s.side === "no" && s.market.outcome === false);

        const dbStakes = s.market?.stakes || [];
        const yesDbSol = dbStakes.filter((st: any) => st.side === "yes").reduce((sum: number, st: any) => sum + Number(st.amount_lamports), 0) / 1e9;
        const noDbSol = dbStakes.filter((st: any) => st.side === "no").reduce((sum: number, st: any) => sum + Number(st.amount_lamports), 0) / 1e9;
        const yesPoolSol = yesDbSol;
        const noPoolSol = noDbSol;
        const price = s.side === "yes" ? (yesPoolSol / (yesPoolSol + noPoolSol || 1)) : (noPoolSol / (yesPoolSol + noPoolSol || 1));
        const payoutSol = won ? stakeSol / price : 0;

        const isMockSig = !s.settlement_tx_signature || s.settlement_tx_signature.startsWith("mock-");

        return {
          id: s.id,
          market_id: s.market_id,
          user_wallet: s.user_wallet,
          side: s.side,
          stake_sol: stakeSol,
          won,
          payout_sol: payoutSol,
          outcome: s.market.outcome,
          market_question: s.market.question,
          market_type: s.market.market_type,
          competition: s.market.match?.competition || "Unknown",
          home_team: s.market.match?.home_team || "Home",
          away_team: s.market.match?.away_team || "Away",
          score_home: s.market.match?.score_home ?? 0,
          score_away: s.market.match?.score_away ?? 0,
          kickoff_at: s.market.match?.kickoff_at,
          settlement_tx_signature: s.settlement_tx_signature,
          settlement_tx_is_real: !isMockSig,
          nft_mint_address: s.nft_mint_address,
          nft_metadata_uri: s.nft_metadata_uri,
          claimed: s.claimed,
          cashed_out: s.cashed_out,
          created_at: s.created_at,
        };
      });

    res.json(receipts);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
