import axios from "axios";
import * as anchor from "@anchor-lang/core";
import { PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { SolanaService } from "./solana.service";
import { ACTIVE_CONFIG } from "../config/constants";
import txoracleIdl from "../config/txoracle.json";
import crypto from "crypto";

/**
 * Thrown when TxODDS authentication fails. This used to silently fall back to a fake
 * "mock mode" (fabricated JWT/token) which masked broken integrations — the hackathon
 * requires a real TxODDS integration, so a failure here must be loud, not invisible.
 */
export class TxlineAuthError extends Error {}

export class TxlineService {
  private jwt: string | null = null;
  private apiToken: string | null = null;
  private solanaService: SolanaService;

  constructor(solanaService: SolanaService) {
    this.solanaService = solanaService;
  }

  public async initialize(): Promise<void> {
    const envJwt = process.env.TX_ODDS_JWT || process.env.TXLINE_JWT;
    const envApiToken = process.env.TX_ODDS_API_TOKEN || process.env.TXLINE_API_TOKEN;

    if (envJwt && envApiToken) {
      this.jwt = envJwt;
      this.apiToken = envApiToken;
      console.log("[TxLINE] Loaded TxODDS auth directly from environment variables.");
      return;
    }

    console.log("[TxLINE] Starting on-chain TxODDS authentication flow...");
    try {
      const authResponse = await axios.post(`${ACTIVE_CONFIG.apiOrigin}/auth/guest/start`);
      this.jwt = authResponse.data.token;
      if (!this.jwt) throw new Error("Failed to get guest JWT.");

      const devnetConnection = new Connection(ACTIVE_CONFIG.rpcUrl, "confirmed");
      const keeperKeypair = (this.solanaService as any).keeperKeypair;
      if (!keeperKeypair) {
        throw new Error("Keeper keypair not found in SolanaService.");
      }
      const wallet = {
        publicKey: keeperKeypair.publicKey,
        signTransaction: async (tx: any) => {
          tx.partialSign(keeperKeypair);
          return tx;
        },
        signAllTransactions: async (txs: any[]) => {
          txs.forEach((tx) => tx.partialSign(keeperKeypair));
          return txs;
        },
      };
      const provider = new anchor.AnchorProvider(devnetConnection, wallet as any, { commitment: "confirmed" });
      const program = new anchor.Program(txoracleIdl as any, provider);

      const balance = await devnetConnection.getBalance(wallet.publicKey);
      console.log(`[TxLINE] Keeper devnet balance: ${balance / 1e9} SOL`);
      if (balance === 0) {
        throw new Error("Keeper has 0 SOL on devnet. Cannot subscribe on-chain.");
      }

      const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_treasury_v2")],
        program.programId
      );
      const tokenTreasuryVault = getAssociatedTokenAddressSync(
        ACTIVE_CONFIG.txlTokenMint,
        tokenTreasuryPda,
        true,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pricing_matrix")],
        program.programId
      );
      const userTokenAccount = getAssociatedTokenAddressSync(
        ACTIVE_CONFIG.txlTokenMint,
        wallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      console.log("[TxLINE] Subscribing on-chain...");
      const txSig = await program.methods
        .subscribe(ACTIVE_CONFIG.serviceLevelId, 4) // 4 weeks
        .accounts({
          user: wallet.publicKey,
          pricingMatrix: pricingMatrixPda,
          tokenMint: ACTIVE_CONFIG.txlTokenMint,
          userTokenAccount,
          tokenTreasuryVault,
          tokenTreasuryPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("[TxLINE] Subscription txSig:", txSig);

      const messageString = `${txSig}::${this.jwt}`;
      const message = new TextEncoder().encode(messageString);
      const signatureBytes = nacl.sign.detached(message, keeperKeypair.secretKey);
      const walletSignature = Buffer.from(signatureBytes).toString("base64");

      console.log("[TxLINE] Activating API token...");
      const activationResponse = await axios.post(
        `${ACTIVE_CONFIG.apiOrigin}/api/token/activate`,
        { txSig, walletSignature, leagues: [] },
        { headers: { Authorization: `Bearer ${this.jwt}` } }
      );

      this.apiToken = activationResponse.data.token || activationResponse.data;
      console.log("[TxLINE] Successfully activated TxLINE API token.");
    } catch (error: any) {
      const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      throw new TxlineAuthError(
        `TxODDS authentication failed: ${detail}. Set TX_ODDS_JWT + TX_ODDS_API_TOKEN directly, or ensure the keeper wallet has devnet SOL and a valid TxODDS subscription. Refusing to start in a fake mock mode — this hackathon requires a real TxODDS integration.`
      );
    }
  }

  // --- API Methods ---

  public async getFixtures(): Promise<any[]> {
    const response = await axios.get(`${ACTIVE_CONFIG.apiOrigin}/api/fixtures/snapshot`, {
      headers: { Authorization: `Bearer ${this.jwt}`, "X-Api-Token": this.apiToken },
    });

    const data = response.data;
    if (!Array.isArray(data)) return [];

    return data.map((fix: any) => ({
      fixtureId: (fix.FixtureId || fix.fixtureId || "").toString(),
      competition: fix.Competition || fix.competition || "",
      participant1: fix.Participant1 || fix.participant1 || "",
      participant2: fix.Participant2 || fix.participant2 || "",
      startTime: fix.StartTime || fix.startTime || new Date().toISOString(),
      participant1IsHome: fix.Participant1IsHome !== undefined ? fix.Participant1IsHome : fix.participant1IsHome,
    }));
  }

  public async getMatchEvents(fixtureId: string): Promise<any[]> {
    const response = await axios.get(`${ACTIVE_CONFIG.apiOrigin}/api/scores/historical/${fixtureId}`, {
      headers: { Authorization: `Bearer ${this.jwt}`, "X-Api-Token": this.apiToken },
    });

    const data = response.data;
    if (!data) return [];

    let rawEvents: any[] = [];
    if (typeof data === "string") {
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            rawEvents.push(JSON.parse(line.substring(6)));
          } catch {}
        }
      }
    } else if (Array.isArray(data)) {
      rawEvents = data;
    }

    return rawEvents.map((ev: any) => ({
      eventType: ev.eventType || ev.EventType || ev.Action || ev.type || ev.Type || ev.eventTypeNum || "",
      occurredAt: ev.occurredAt || ev.OccurredAt || ev.occurred_at || (ev.Ts ? new Date(ev.Ts).toISOString() : new Date().toISOString()),
      payload: ev.payload || ev.Payload || ev,
    }));
  }

  /**
   * The historical/streaming events endpoint (getMatchEvents, /api/scores/historical) is
   * NOT a stable full-replay — confirmed empirically it can return zero records even when
   * dozens of real score updates exist for a fixture. After any pipeline downtime (crash,
   * network outage) it only picks up events from wherever it reconnects, silently losing
   * every goal that happened in between while the match's recorded score stays stale.
   *
   * The snapshot endpoint doesn't have that gap — it returns the fixture's full score
   * history in one shot, so the true current score can always be recovered from it
   * regardless of what the event stream missed. Callers should use this as a floor/
   * cross-check on top of event-derived scores, not as a replacement for the event log
   * (which still drives the per-event market settlement and timeline).
   */
  public async getScoreSnapshot(fixtureId: string): Promise<{ home: number; away: number } | null> {
    const response = await axios.get(`${ACTIVE_CONFIG.apiOrigin}/api/scores/snapshot/${fixtureId}`, {
      headers: { Authorization: `Bearer ${this.jwt}`, "X-Api-Token": this.apiToken },
      params: { asOf: Date.now() },
    });

    const data = response.data;
    if (!Array.isArray(data) || data.length === 0) return null;

    const withScore = data.filter((r: any) => r.Score);
    if (withScore.length === 0) return null;
    const latest = withScore[withScore.length - 1];

    const participant1IsHome = latest.Participant1IsHome !== false;
    const p1Goals = latest.Score.Participant1?.Total?.Goals ?? 0;
    const p2Goals = latest.Score.Participant2?.Total?.Goals ?? 0;

    return participant1IsHome ? { home: p1Goals, away: p2Goals } : { home: p2Goals, away: p1Goals };
  }

  /**
   * Persistent SSE consumer for /api/scores/stream — the only genuinely real-time TxLINE
   * data source. getMatchEvents()/getScoreSnapshot() above are REST polling against slower,
   * lagging materialized views (confirmed empirically: the snapshot endpoint served a
   * 3-goal read for several minutes after the real score had already moved to 3-5). This
   * is what actually keeps scores live.
   *
   * The stream sends bare `data: {...}` + `id: ...` frames with no SSE-level `event:` type
   * (confirmed by direct capture) — each record self-describes via its own `Action` field,
   * so onEvent gets the same {eventType, occurredAt, payload} shape getMatchEvents() produces.
   *
   * Reconnects on any drop/error with backoff, sending `Last-Event-ID` (the SSE spec's own
   * gap-fill mechanism) so a reconnect resumes rather than silently restarting the firehose.
   * Never throws out of this function — a permanently-failing stream degrades to "no live
   * updates" rather than taking the caller down with it.
   */
  public streamScores(onEvent: (event: { eventType: string; occurredAt: string; payload: any }) => void): void {
    let lastEventId: string | null = null;
    let stopped = false;
    let retryDelayMs = 1000;
    const maxRetryDelayMs = 30000;

    const connect = async () => {
      if (stopped) return;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.jwt}`,
          "X-Api-Token": this.apiToken || "",
          Accept: "text/event-stream",
        };
        if (lastEventId) headers["Last-Event-ID"] = lastEventId;

        const response = await fetch(`${ACTIVE_CONFIG.apiOrigin}/api/scores/stream`, { headers });
        if (!response.ok || !response.body) {
          throw new Error(`Stream connect failed: ${response.status}`);
        }
        console.log("[TxLINE Stream] Connected" + (lastEventId ? ` (resuming from ${lastEventId})` : ""));
        retryDelayMs = 1000;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const messages = buffer.split("\n\n");
          buffer = messages.pop() || "";

          for (const raw of messages) {
            let dataLine: string | null = null;
            for (const line of raw.split("\n")) {
              if (line.startsWith("data:")) dataLine = line.slice(5).trim();
              else if (line.startsWith("id:")) lastEventId = line.slice(3).trim();
            }
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine);
              onEvent({
                eventType: ev.eventType || ev.EventType || ev.Action || ev.type || ev.Type || "",
                occurredAt: ev.occurredAt || ev.OccurredAt || (ev.Ts ? new Date(ev.Ts).toISOString() : new Date().toISOString()),
                payload: ev,
              });
            } catch (parseErr) {
              // Malformed frame — skip it, don't let one bad message stall the stream.
            }
          }
        }
        console.log("[TxLINE Stream] Connection closed, reconnecting...");
      } catch (err: any) {
        console.error("[TxLINE Stream] Error, reconnecting:", err.message);
      }

      if (!stopped) {
        setTimeout(connect, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
      }
    };

    connect();
  }

  public async getEventProof(fixtureId: string, eventNonce: number): Promise<any> {
    const response = await axios.get(`${ACTIVE_CONFIG.apiOrigin}/api/scores/proof/${fixtureId}/${eventNonce}`, {
      headers: { Authorization: `Bearer ${this.jwt}`, "X-Api-Token": this.apiToken },
    });
    return response.data;
  }

  /** Normalizes a payload to an event hash */
  public computeEventHash(payload: any): string {
    const canonical = JSON.stringify(payload);
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }
}
