import axios from "axios";
import * as anchor from "@coral-xyz/anchor";
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
