import { Router } from "express";
import crypto from "crypto";
import { supabaseAdmin } from "../lib/supabase";
import { getSolanaService } from "../services/instances";
import { GroqService, AIUndeterminedError } from "../services/groq.service";
import { verifyOnChainInstruction } from "../lib/solana-verify";

const router = Router();

// P2P challenges settle through the SAME contract instructions as pool markets
// (create_market / place_stake / settle_market / claim_payout) against a synthetic
// 2-outcome market keyed by the challenge id — no new contract code needed for this.
function marketIdForChallenge(challengeId: string): string {
  // Anchor's market_id is a fixed 32-byte array — a UUID's hex digits (no hyphens) is
  // exactly 32 characters, so this fits with no truncation or padding surprises.
  return challengeId.replace(/-/g, "");
}

router.post("/", async (req, res) => {
  try {
    const { creator_wallet, challenger_wallet, match_id, question, amount_sol, creator_side } = req.body;
    if (!creator_wallet || !challenger_wallet || !match_id || !question || !amount_sol || !creator_side) {
      return res.status(400).json({ error: "Missing required P2P fields" });
    }

    const newChallenge = {
      creator_wallet,
      challenger_wallet,
      match_id,
      question,
      amount_lamports: Math.round(Number(amount_sol) * 1e9),
      creator_side,
      status: "pending",
    };

    const { data: challenge, error } = await supabaseAdmin
      .from("p2p_challenges")
      .insert(newChallenge)
      .select("*")
      .single();

    if (error) {
      return res.status(500).json({ error: error.message || "Database error" });
    }
    return res.status(201).json(challenge);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.get("/wallet/:wallet", async (req, res) => {
  try {
    const { data: challenges, error } = await supabaseAdmin
      .from("p2p_challenges")
      .select("*")
      .or(`creator_wallet.eq.${req.params.wallet},challenger_wallet.eq.${req.params.wallet}`)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message || "Database error" });
    }
    return res.json(challenges);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// Opponent agrees to the wager — this is when real escrow starts: the backend creates a
// synthetic on-chain market for the two parties to stake into (keeper-signed create_market;
// nobody's funds move yet). The response carries what the frontend needs to build each side's
// place_stake transaction.
router.post("/:id/accept", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: challenge, error: fetchErr } = await supabaseAdmin
      .from("p2p_challenges")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr || !challenge) {
      return res.status(404).json({ error: fetchErr?.message || "P2P Challenge not found" });
    }
    if (challenge.status !== "pending") {
      return res.status(400).json({ error: `Cannot accept a challenge in status "${challenge.status}"` });
    }

    const solana = getSolanaService();
    const marketId = marketIdForChallenge(id);
    const opensAt = new Date();
    const closesAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days — generous window to stake + resolve

    let marketPda: string;
    try {
      await solana.createMarket(challenge.match_id, marketId, opensAt, closesAt);
      marketPda = solana.getMarketPda(challenge.match_id, marketId).toBase58();
    } catch (chainErr: any) {
      return res.status(502).json({ error: `Failed to create on-chain escrow market: ${chainErr.message}` });
    }

    const { data: updatedChallenge, error: updateError } = await supabaseAdmin
      .from("p2p_challenges")
      .update({ status: "accepted", market_id: marketId, market_pda: marketPda })
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message || "Database error" });
    }
    return res.json(updatedChallenge);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// Each side calls this after sending their own real place_stake transaction. Once both
// creator and challenger have a verified stake on-chain, the challenge is fully escrowed.
router.post("/:id/confirm-stake", async (req, res) => {
  try {
    const { id } = req.params;
    const { wallet, tx_sig } = req.body;
    if (!wallet || !tx_sig) {
      return res.status(400).json({ error: "wallet and tx_sig are required" });
    }

    const { data: challenge, error: fetchErr } = await supabaseAdmin
      .from("p2p_challenges")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr || !challenge) {
      return res.status(404).json({ error: fetchErr?.message || "P2P Challenge not found" });
    }
    if (challenge.status !== "accepted" && challenge.status !== "staked") {
      return res.status(400).json({ error: `Cannot confirm a stake for a challenge in status "${challenge.status}"` });
    }
    if (wallet !== challenge.creator_wallet && wallet !== challenge.challenger_wallet) {
      return res.status(403).json({ error: "wallet is not a party to this challenge" });
    }

    try {
      await verifyOnChainInstruction(getSolanaService(), tx_sig, "placeStake", wallet);
    } catch (verifyErr: any) {
      return res.status(400).json({ error: `On-chain verification failed: ${verifyErr.message}` });
    }

    const isCreator = wallet === challenge.creator_wallet;
    const update: Record<string, any> = isCreator
      ? { creator_tx_sig: tx_sig }
      : { challenger_tx_sig: tx_sig };

    const bothStaked = isCreator
      ? !!challenge.challenger_tx_sig
      : !!challenge.creator_tx_sig;
    if (bothStaked) {
      update.status = "staked";
    }

    const { data: updatedChallenge, error: updateError } = await supabaseAdmin
      .from("p2p_challenges")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message || "Database error" });
    }
    return res.json(updatedChallenge);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

async function settleChallengeOnChain(challenge: any, outcome: boolean, reasoning: string) {
  const solana = getSolanaService();
  const { data: nextNonce, error: rpcError } = await supabaseAdmin.rpc("next_event_nonce");
  if (rpcError || nextNonce === null) {
    throw new Error(`Failed to allocate event nonce: ${rpcError?.message}`);
  }

  const payload = { type: "p2p-resolution", challenge_id: challenge.id, question: challenge.question, outcome };
  const eventHash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const occurredAt = new Date();
  const FULLTIME_TYPE_INT = 3; // generic "resolution reached" marker — see ANCHOR_EVENT_TYPE_MAP

  await supabaseAdmin.from("match_events").insert({
    match_id: challenge.match_id,
    event_nonce: nextNonce,
    event_type: "fulltime",
    event_hash: eventHash,
    payload,
    occurred_at: occurredAt.toISOString(),
  });

  const anchorTxSig = await solana.anchorEvent(challenge.match_id, Number(nextNonce), FULLTIME_TYPE_INT, eventHash, occurredAt);
  await supabaseAdmin.from("match_events").update({ on_chain_tx_sig: anchorTxSig, anchored_at: new Date().toISOString() }).eq("event_hash", eventHash);

  const settleTxSig = await solana.settleMarket(challenge.match_id, challenge.market_id, Number(nextNonce), outcome);

  const creatorPickedYes = challenge.creator_side === "yes";
  const winnerWallet = (creatorPickedYes === outcome) ? challenge.creator_wallet : challenge.challenger_wallet;

  const { data: updatedChallenge, error: updateError } = await supabaseAdmin
    .from("p2p_challenges")
    .update({
      status: "settled",
      outcome,
      winner_wallet: winnerWallet,
      settlement_event_nonce: nextNonce,
      ai_reasoning: reasoning,
    })
    .eq("id", challenge.id)
    .select("*")
    .single();

  if (updateError) throw new Error(updateError.message);
  return { updatedChallenge, settleTxSig };
}

// Manual/admin resolution — used when the AI can't confidently determine an outcome.
router.post("/:id/resolve", async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome } = req.body;
    if (outcome === undefined) {
      return res.status(400).json({ error: "Missing outcome parameter" });
    }

    const { data: challenge, error: chalError } = await supabaseAdmin
      .from("p2p_challenges")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (chalError || !challenge) {
      return res.status(404).json({ error: chalError?.message || "Challenge not found" });
    }
    if (challenge.status !== "staked" && challenge.status !== "disputed") {
      return res.status(400).json({ error: `Only fully-staked or disputed challenges can be resolved (current: "${challenge.status}")` });
    }

    const { updatedChallenge } = await settleChallengeOnChain(challenge, !!outcome, "Resolved by admin.");
    return res.json(updatedChallenge);
  } catch (err: any) {
    console.error("[P2P resolve] error:", err.message);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// AI-driven resolution. Never guesses on real money — if the AI referee (and its event-log
// heuristic fallback) can't confidently determine an outcome, the challenge goes to "disputed"
// for manual admin review via /resolve instead of settling on a coin flip.
router.post("/:id/ai-settle", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: challenge, error: chalError } = await supabaseAdmin
      .from("p2p_challenges")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (chalError || !challenge) {
      return res.status(404).json({ error: chalError?.message || "Challenge not found" });
    }
    if (challenge.status !== "staked") {
      return res.status(400).json({ error: `Only fully-staked challenges can be AI-settled (current: "${challenge.status}")` });
    }

    const { data: match, error: matchError } = await supabaseAdmin
      .from("matches")
      .select("*")
      .eq("id", challenge.match_id)
      .maybeSingle();
    if (matchError || !match) {
      return res.status(404).json({ error: matchError?.message || "Match not found" });
    }

    const { data: events, error: eventsError } = await supabaseAdmin
      .from("match_events")
      .select("*")
      .eq("match_id", challenge.match_id)
      .order("occurred_at", { ascending: true });
    if (eventsError) {
      return res.status(500).json({ error: eventsError.message || "Failed to fetch match events" });
    }

    try {
      const { outcome, reasoning } = await GroqService.evaluateP2pChallenge(
        challenge.question, match.home_team, match.away_team, events || []
      );
      const { updatedChallenge } = await settleChallengeOnChain(challenge, outcome, reasoning);
      return res.json(updatedChallenge);
    } catch (err: any) {
      if (err instanceof AIUndeterminedError) {
        const { data: disputed } = await supabaseAdmin
          .from("p2p_challenges")
          .update({ status: "disputed", ai_reasoning: err.message })
          .eq("id", id)
          .select("*")
          .single();
        return res.status(200).json(disputed);
      }
      throw err;
    }
  } catch (err: any) {
    console.error("AI P2P Settle error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// Winner calls this after sending their own real claim_payout transaction.
router.post("/:id/confirm-claim", async (req, res) => {
  try {
    const { id } = req.params;
    const { wallet, tx_sig } = req.body;
    if (!wallet || !tx_sig) {
      return res.status(400).json({ error: "wallet and tx_sig are required" });
    }

    const { data: challenge, error: fetchErr } = await supabaseAdmin
      .from("p2p_challenges")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr || !challenge) {
      return res.status(404).json({ error: fetchErr?.message || "P2P Challenge not found" });
    }
    if (challenge.status !== "settled") {
      return res.status(400).json({ error: "Challenge is not settled yet" });
    }
    if (challenge.winner_wallet !== wallet) {
      return res.status(403).json({ error: "wallet is not the winner of this challenge" });
    }

    try {
      await verifyOnChainInstruction(getSolanaService(), tx_sig, "claimPayout", wallet);
    } catch (verifyErr: any) {
      return res.status(400).json({ error: `On-chain verification failed: ${verifyErr.message}` });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("p2p_challenges")
      .update({ payout_tx_sig: tx_sig })
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message || "Database error" });
    }
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
