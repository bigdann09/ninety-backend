import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction
} from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@anchor-lang/core";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import ninetyIdl from "../config/ninety.json";
import { ACTIVE_CONFIG } from "../config/constants";

dotenv.config();

function loadKeeperKeypair(): Keypair {
  const envSecret = process.env.KEEPER_KEYPAIR_SECRET;
  if (envSecret) {
    try {
      const parsed = JSON.parse(envSecret.trim());
      if (Array.isArray(parsed)) {
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
      }
    } catch {}
  }
  return Keypair.generate();
}

export class SolanaService {
  private connection: Connection;
  private keeperKeypair: Keypair;
  private provider: AnchorProvider;
  private program: Program;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || ACTIVE_CONFIG.rpcUrl;
    this.connection = new Connection(rpcUrl, "confirmed");

    this.keeperKeypair = loadKeeperKeypair();
    console.log("Solana Service initialized with keeper:", this.keeperKeypair.publicKey.toBase58());

    const wallet = {
      publicKey: this.keeperKeypair.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(this.keeperKeypair);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((tx) => tx.partialSign(this.keeperKeypair));
        return txs;
      },
    };
    this.provider = new AnchorProvider(this.connection, wallet as any, {
      commitment: "confirmed",
    });

    this.program = new Program(ninetyIdl as any, this.provider);
  }

  public getConnection(): Connection {
    return this.connection;
  }

  public getProgram(): Program {
    return this.program;
  }

  public getKeeperPubkey(): PublicKey {
    return this.keeperKeypair.publicKey;
  }

  private toBytes32(str: string): number[] {
    const buf = Buffer.alloc(32);
    buf.write(str, "utf-8");
    return Array.from(buf);
  }

  public getMarketPda(matchId: string, marketId: string): PublicKey {
    const matchBytes = Buffer.from(this.toBytes32(matchId));
    const marketBytes = Buffer.from(this.toBytes32(marketId));
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), matchBytes, marketBytes],
      this.program.programId
    );
    return pda;
  }

  public getVaultPda(marketPda: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      this.program.programId
    );
    return pda;
  }

  public getStakePda(marketPda: PublicKey, owner: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), marketPda.toBuffer(), owner.toBuffer()],
      this.program.programId
    );
    return pda;
  }

  public getEventPda(matchId: string, eventNonce: number): PublicKey {
    const matchBytes = Buffer.from(this.toBytes32(matchId));
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(eventNonce));
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("event"), matchBytes, nonceBuf],
      this.program.programId
    );
    return pda;
  }

  private async withRpcRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      const errorStr = (error.message || "") + " " + JSON.stringify(error);
      const isRateLimit = errorStr.includes("429") ||
        errorStr.toLowerCase().includes("too many requests") ||
        errorStr.includes("rate limit");
      if (isRateLimit && retries > 0) {
        console.warn(`[Solana RPC Retry] Rate limit (429) hit. Retrying in ${delay}ms... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.withRpcRetry(fn, retries - 1, delay * 2);
      }
      throw error;
    }
  }

  /** Invokes the create_market instruction on Solana (keeper-signed). */
  public async createMarket(
    matchId: string,
    marketId: string,
    opensAt: Date,
    closesAt: Date
  ): Promise<string> {
    const marketPda = this.getMarketPda(matchId, marketId);
    const vaultPda = this.getVaultPda(marketPda);
    const opensAtBn = new BN(Math.floor(opensAt.getTime() / 1000));
    const closesAtBn = new BN(Math.floor(closesAt.getTime() / 1000));
    const matchBytes = this.toBytes32(matchId);
    const marketBytes = this.toBytes32(marketId);

    return this.withRpcRetry(() =>
      this.program.methods
        .createMarket(matchBytes, marketBytes, opensAtBn, closesAtBn)
        .accounts({
          authority: this.keeperKeypair.publicKey,
          market: marketPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }

  /** Invokes the anchor_event instruction on Solana (keeper-signed). */
  public async anchorEvent(
    matchId: string,
    eventNonce: number,
    eventType: number,
    eventHashHex: string,
    occurredAt: Date
  ): Promise<string> {
    const eventPda = this.getEventPda(matchId, eventNonce);
    const matchBytes = this.toBytes32(matchId);
    const hashBytes = Array.from(Buffer.from(eventHashHex, "hex"));
    const occurredAtBn = new BN(Math.floor(occurredAt.getTime() / 1000));

    return this.withRpcRetry(() =>
      this.program.methods
        .anchorEvent(matchBytes, new BN(eventNonce), eventType, hashBytes, occurredAtBn)
        .accounts({
          authority: this.keeperKeypair.publicKey,
          eventAnchor: eventPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }

  /** Invokes the settle_market instruction on Solana (keeper-signed). */
  public async settleMarket(
    matchId: string,
    marketId: string,
    eventNonce: number,
    outcome: boolean
  ): Promise<string> {
    const marketPda = this.getMarketPda(matchId, marketId);
    const eventPda = this.getEventPda(matchId, eventNonce);

    return this.withRpcRetry(() =>
      this.program.methods
        .settleMarket(outcome)
        .accounts({
          authority: this.keeperKeypair.publicKey,
          market: marketPda,
          eventAnchor: eventPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }
}
