import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { GroqService } from "../services/groq.service";

const router = Router();

// GET /users/:walletAddress/loyalty
router.get("/:walletAddress/loyalty", async (req, res) => {
  const { walletAddress } = req.params;
  try {
    const { data: stakes, error: stakesError } = await supabaseAdmin
      .from("stakes")
      .select(`
        *,
        market:markets (
          *
        )
      `)
      .eq("user_wallet", walletAddress);

    if (stakesError || !stakes) {
      res.status(500).json({ error: stakesError?.message || "Database error" });
      return;
    }

    let totalPoints = 0;
    let stakesCount = stakes.length;
    let winsCount = 0;

    const stakesBreakdown = stakes.map((st: any) => {
      const stakeSol = Number(st.amount_lamports) / 1e9;
      let pointsEarned = Math.round(stakeSol * 100);
      let multiplier = 1;
      let won = false;

      if (st.cashed_out) {
        pointsEarned = Math.round(stakeSol * 50);
      } else if (st.market?.status === "settled") {
        won = (st.side === "yes" && st.market.outcome === true) ||
              (st.side === "no" && st.market.outcome === false);
        if (won) {
          winsCount++;
          multiplier = 2;
          pointsEarned = Math.round(stakeSol * 100 * multiplier);
        }
      }

      totalPoints += pointsEarned;

      return {
        id: st.id,
        marketQuestion: st.market?.question || "P2P/Custom Market",
        stakeSol,
        side: st.side,
        status: st.cashed_out ? "cashed_out" : st.market?.status || "open",
        won,
        points: pointsEarned,
        multiplier
      };
    });

    const { data: p2pChallenges } = await supabaseAdmin
      .from("p2p_challenges")
      .select("*")
      .or(`creator_wallet.eq.${walletAddress},challenger_wallet.eq.${walletAddress}`);

    if (p2pChallenges) {
      p2pChallenges.forEach((chal: any) => {
        if (chal.status === "settled") {
          const isCreator = chal.creator_wallet === walletAddress;
          const won = (isCreator && chal.outcome === true) || (!isCreator && chal.outcome === false);
          const stakeSol = Number(chal.amount_lamports) / 1e9;

          let points = Math.round(stakeSol * 100);
          if (won) {
            winsCount++;
            points = Math.round(stakeSol * 200);
          }
          totalPoints += points;
        }
      });
    }

    let tier = "Bronze";
    let nextTierPoints = 500;
    let progress = 0;
    let badges: string[] = [];

    if (totalPoints >= 10000) {
      tier = "Diamond"; nextTierPoints = 10000; progress = 100;
      badges = ["Oracle Master", "Whale Bettor", "Solana Sage"];
    } else if (totalPoints >= 4000) {
      tier = "Platinum"; nextTierPoints = 10000;
      progress = Math.round(((totalPoints - 4000) / 6000) * 100);
      badges = ["Oracle Master", "Solana Sage"];
    } else if (totalPoints >= 1500) {
      tier = "Gold"; nextTierPoints = 4000;
      progress = Math.round(((totalPoints - 1500) / 2500) * 100);
      badges = ["Solana Sage"];
    } else if (totalPoints >= 500) {
      tier = "Silver"; nextTierPoints = 1500;
      progress = Math.round(((totalPoints - 500) / 1000) * 100);
      badges = ["Rookie Bettor"];
    } else {
      progress = Math.round((totalPoints / 500) * 100);
      badges = ["Newcomer"];
    }

    res.json({ totalPoints, stakesCount, winsCount, tier, nextTierPoints, progress, badges, stakesBreakdown });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// GET /users/:walletAddress/recommendations
router.get("/:walletAddress/recommendations", async (req, res) => {
  const { walletAddress } = req.params;
  try {
    const { data: stakes, error: stakesError } = await supabaseAdmin
      .from("stakes")
      .select(`
        *,
        market:markets (
          *
        )
      `)
      .eq("user_wallet", walletAddress);

    if (stakesError) {
      res.status(500).json({ error: stakesError.message || "Database error" });
      return;
    }

    const { data: activeMatches, error: matchesError } = await supabaseAdmin
      .from("matches")
      .select(`
        *,
        markets:markets (
          *,
          stakes (
            *
          )
        )
      `)
      .eq("status", "live");

    if (matchesError) {
      res.status(500).json({ error: matchesError.message || "Database error" });
      return;
    }

    try {
      const recommendations = await GroqService.generateRecommendations(
        walletAddress,
        stakes || [],
        activeMatches || []
      );

      res.json(recommendations);
    } catch (e: any) {
      console.warn("Groq recommendations generation failed, using fallback recommendations:", e.message);
      res.status(500).json({ error: e.message || "Groq recommendations error" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
