import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { getSolanaService } from "../services/instances";
import { verifyOnChainInstruction, getAccountBalanceDelta } from "../lib/solana-verify";

const router = Router();

// Create a stake row — only after the client has already sent a real place_stake transaction.
router.post("/", async (req, res) => {
  try {
    const { market_id, user_wallet, side, amount_lamports, on_chain_pubkey, tx_sig } = req.body;

    if (!market_id || !user_wallet || !side || amount_lamports === undefined || !tx_sig) {
      return res.status(400).json({ error: "Missing required fields (tx_sig is required — stakes must be backed by a real on-chain place_stake transaction)" });
    }

    const { data: market, error: marketError } = await supabaseAdmin
      .from("markets")
      .select("*")
      .eq("id", market_id)
      .maybeSingle();

    if (marketError || !market) {
      return res.status(404).json({ error: "Market not found" });
    }
    if (new Date() >= new Date(market.closes_at) || market.status !== "open") {
      return res.status(400).json({ error: "Staking window has closed or market is not open" });
    }

    try {
      await verifyOnChainInstruction(getSolanaService(), tx_sig, "placeStake", user_wallet);
    } catch (verifyErr: any) {
      return res.status(400).json({ error: `On-chain verification failed: ${verifyErr.message}` });
    }

    const newStake = {
      market_id,
      user_wallet,
      side,
      amount_lamports: Number(amount_lamports),
      on_chain_pubkey: on_chain_pubkey || null,
      tx_sig,
      claimed: false,
    };

    const { data: stake, error: insertError } = await supabaseAdmin
      .from("stakes")
      .insert(newStake)
      .select("*")
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message || "Database error" });
    }

    return res.status(201).json(stake);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// Public verification lookup — by stake id or its on-chain pubkey, whichever the caller has.
router.get("/verify/:stakeId", async (req, res) => {
  try {
    const { stakeId } = req.params;
    const { data: stake, error } = await supabaseAdmin
      .from("stakes")
      .select(`
        *,
        market:markets(
          id, question, outcome, market_type, status,
          match:matches(id, home_team, away_team, competition, score_home, score_away, kickoff_at)
        )
      `)
      .or(`on_chain_pubkey.eq.${stakeId},id.eq.${stakeId}`)
      .limit(1)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message || "Database error" });
    }
    if (!stake) {
      return res.status(404).json({ error: "Receipt not found" });
    }
    return res.json(stake);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.get("/wallet/:walletAddress", async (req, res) => {
  try {
    const { data: stakes, error } = await supabaseAdmin
      .from("stakes")
      .select(`*, market:markets (*, match:matches (*), stakes (*))`)
      .eq("user_wallet", req.params.walletAddress);

    if (error) {
      return res.status(500).json({ error: error.message || "Database error" });
    }
    return res.json(stakes);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.get("/by-tx/:sig", async (req, res) => {
  try {
    const { sig } = req.params;
    const { data: stakes } = await supabaseAdmin
      .from("stakes")
      .select(`
        *,
        market:markets(
          id, question, outcome, market_type, status,
          match:matches(id, home_team, away_team, competition, score_home, score_away, kickoff_at)
        )
      `)
      .or(`settlement_tx_signature.eq.${sig},tx_sig.eq.${sig}`)
      .limit(1);

    const stake = stakes?.[0];
    if (!stake) {
      return res.json(null);
    }

    const market = stake.market;
    const match = market?.match;

    const stakeSol = Number(stake.amount_lamports) / 1e9;
    const allStakes = await supabaseAdmin
      .from("stakes")
      .select("side, amount_lamports")
      .eq("market_id", stake.market_id);

    const yesL = (allStakes.data ?? []).filter((s) => s.side === "yes").reduce((sum, s) => sum + Number(s.amount_lamports), 0);
    const noL = (allStakes.data ?? []).filter((s) => s.side === "no").reduce((sum, s) => sum + Number(s.amount_lamports), 0);
    const total = yesL + noL;
    const price = stake.side === "yes" ? (total > 0 ? yesL / total : 0.5) : (total > 0 ? noL / total : 0.5);
    const potentialPayout = stakeSol * (1 / price);

    const won = !stake.cashed_out && (
      (stake.side === "yes" && market?.outcome === true) ||
      (stake.side === "no" && market?.outcome === false)
    );
    const cashoutAmt = stake.cashout_amount ? Number(stake.cashout_amount) : 0;
    const payoutSol = stake.cashed_out ? cashoutAmt : (won ? potentialPayout : 0);

    return res.json({
      id: stake.id,
      stakeAccountPubkey: stake.on_chain_pubkey ?? stake.id,
      side: stake.side,
      amountSol: stakeSol,
      payoutSol,
      outcome: stake.cashed_out ? "cashout" : (won ? "won" : "lost"),
      network: "devnet",
      settlementTx: stake.settlement_tx_signature,
      txSig: stake.tx_sig,
      nftMintAddress: stake.nft_mint_address ?? null,
      marketQuestion: market?.question ?? "",
      homeTeam: match?.home_team ?? "",
      awayTeam: match?.away_team ?? "",
      homeScore: match?.score_home ?? 0,
      awayScore: match?.score_away ?? 0,
      competition: match?.competition ?? "",
      settledAt: market?.status === "settled" ? stake.created_at : null,
    });
  } catch (err: any) {
    console.error("[/api/stakes/by-tx]", err.message);
    return res.status(500).json(null);
  }
});

// Claim a settled winning position. The claim_payout transaction is signed and sent by the
// user's own wallet client-side (the on-chain StakeAccount PDA is keyed to their pubkey, so
// the backend cannot sign on their behalf) — this route only verifies it happened and records it.
router.post("/:id/claim", async (req, res) => {
  try {
    const { id } = req.params;
    const { wallet, tx_sig } = req.body;
    if (!wallet || !tx_sig) {
      return res.status(400).json({ error: "wallet and tx_sig are required" });
    }

    const { data: stake, error: stakeError } = await supabaseAdmin
      .from("stakes")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (stakeError || !stake) {
      return res.status(404).json({ error: stakeError?.message || "Stake not found" });
    }
    if (stake.user_wallet !== wallet) {
      return res.status(403).json({ error: "wallet does not own this stake" });
    }
    if (stake.claimed) {
      return res.status(400).json({ error: "Already claimed" });
    }

    const solana = getSolanaService();
    try {
      await verifyOnChainInstruction(solana, tx_sig, "claimPayout", wallet);
    } catch (verifyErr: any) {
      return res.status(400).json({ error: `On-chain verification failed: ${verifyErr.message}` });
    }

    let payoutLamports = 0;
    try {
      payoutLamports = await getAccountBalanceDelta(solana, tx_sig, wallet);
    } catch {}

    const { data: updatedStake, error: updateError } = await supabaseAdmin
      .from("stakes")
      .update({ claimed: true, claim_tx_signature: tx_sig, claim_payout_lamports: payoutLamports > 0 ? payoutLamports : null })
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message || "Database error" });
    }
    return res.json(updatedStake);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// Early exit before settlement. Same pattern as claim: the user signs the real `cashout`
// instruction client-side, this route just verifies it landed and records the real refund.
router.post("/:id/cashout", async (req, res) => {
  try {
    const { id } = req.params;
    const { wallet, tx_sig } = req.body;
    if (!wallet || !tx_sig) {
      return res.status(400).json({ error: "wallet and tx_sig are required" });
    }

    const { data: stake, error: stakeError } = await supabaseAdmin
      .from("stakes")
      .select(`*, market:markets (*)`)
      .eq("id", id)
      .maybeSingle();

    if (stakeError || !stake) {
      return res.status(404).json({ error: stakeError?.message || "Stake not found" });
    }
    if (stake.user_wallet !== wallet) {
      return res.status(403).json({ error: "wallet does not own this stake" });
    }
    if (stake.cashed_out) {
      return res.status(400).json({ error: "Already cashed out this position" });
    }

    const solana = getSolanaService();
    try {
      await verifyOnChainInstruction(solana, tx_sig, "cashout", wallet);
    } catch (verifyErr: any) {
      return res.status(400).json({ error: `On-chain verification failed: ${verifyErr.message}` });
    }

    let refundLamports = 0;
    try {
      refundLamports = await getAccountBalanceDelta(solana, tx_sig, wallet);
    } catch {}
    const cashoutSol = refundLamports > 0 ? refundLamports / 1e9 : 0;

    const { data: updatedStake, error: updateError } = await supabaseAdmin
      .from("stakes")
      .update({ cashed_out: true, cashout_amount: cashoutSol.toString(), cashout_tx_signature: tx_sig })
      .eq("id", id)
      .select("*")
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message || "Database error" });
    }
    return res.json({ success: true, cashoutAmount: cashoutSol, stake: updatedStake });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
