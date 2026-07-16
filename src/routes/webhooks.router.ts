import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { getSolanaService, getPipelineService } from "../services/instances";
import { ANCHOR_EVENT_TYPES, ANCHOR_EVENT_TYPE_MAP, AnchorEventType } from "../config/constants";

const router = Router();

// Supabase DB webhook target — fires on every INSERT into match_events. Anchors resolution-worthy
// event types on-chain (keeper-signed) and settles any open market whose market_type matches the
// event type. Note: markets that never see a matching event are settled separately by
// PipelineService.settleExpiredMarkets() (outcome=false) once their closes_at passes — this route
// only ever settles outcome=true, by design (an event firing means "yes, it happened").
router.post("/anchor", async (req, res) => {
  try {
    const body = req.body;
    console.log("[Webhook Anchor] Received webhook payload:", JSON.stringify(body));

    if (body.type !== "INSERT" || body.table !== "match_events") {
      return res.json({ success: true, message: "Ignored non-INSERT or non-match_events event" });
    }

    const record = body.record;
    if (!record) {
      return res.status(400).json({ error: "Missing record data" });
    }

    const { id, match_id, event_nonce, event_type, event_hash, occurred_at } = record;

    const isAnchorable = ANCHOR_EVENT_TYPES.includes(event_type as AnchorEventType);
    if (!isAnchorable) {
      return res.json({ success: true, message: `Event ${event_type} is not anchorable` });
    }

    const solanaService = getSolanaService();
    const pipelineService = await getPipelineService();

    let anchorTxSig = "";
    try {
      const typeInt = ANCHOR_EVENT_TYPE_MAP[event_type as AnchorEventType];
      anchorTxSig = await solanaService.anchorEvent(match_id, Number(event_nonce), typeInt, event_hash, new Date(occurred_at));
      console.log(`[Webhook Anchor] Anchored event ${event_type} on-chain: ${anchorTxSig}`);
    } catch (err: any) {
      console.error(`[Webhook Anchor] Solana anchor failed:`, err.message);
      throw new Error(`On-chain anchoring failed: ${err.message}`);
    }

    await supabaseAdmin
      .from("match_events")
      .update({ on_chain_tx_sig: anchorTxSig, anchored_at: new Date().toISOString() })
      .eq("id", id);

    const { data: matchingMarkets, error: marketsError } = await supabaseAdmin
      .from("markets")
      .select("*")
      .eq("match_id", match_id)
      .eq("market_type", event_type)
      .eq("status", "open");

    if (marketsError || !matchingMarkets || matchingMarkets.length === 0) {
      return res.json({ success: true, message: `Anchored event ${event_type}, no open markets resolved` });
    }

    for (const market of matchingMarkets) {
      console.log(`[Webhook Settle] Settling market ${market.id} (${market.market_type}) as YES due to event.`);

      let settleTxSig = "";
      try {
        settleTxSig = await solanaService.settleMarket(match_id, market.id, Number(event_nonce), true);
        console.log(`[Webhook Settle] Settled market ${market.id} on Solana: ${settleTxSig}`);
      } catch (err: any) {
        console.error(`[Webhook Settle] Solana settle failed:`, err.message);
        throw new Error(`On-chain settlement failed: ${err.message}`);
      }

      await supabaseAdmin
        .from("markets")
        .update({
          status: "settled",
          outcome: true,
          resolution_event_hash: settleTxSig,
          updated_at: new Date().toISOString(),
        })
        .eq("id", market.id);

      await pipelineService.mintNFTsForMarket(market, settleTxSig);
    }

    return res.json({ success: true, anchored: true, settledMarkets: matchingMarkets.length });
  } catch (err: any) {
    console.error("[Webhook Anchor] Internal error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
