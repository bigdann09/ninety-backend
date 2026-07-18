import { PublicKey } from "@solana/web3.js";
import { BorshInstructionCoder } from "@anchor-lang/core";
import { SolanaService } from "../services/solana.service";
import ninetyIdl from "../config/ninety.json";

const coder = new BorshInstructionCoder(ninetyIdl as any);
const PROGRAM_ID = new PublicKey((ninetyIdl as any).address);

function toCamelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export interface VerifiedInstruction {
  name: string;
  data: Record<string, any>;
  accountKeys: string[];
}

export async function fetchProgramInstructions(
  solana: SolanaService,
  signature: string
): Promise<VerifiedInstruction[]> {
  const connection = solana.getConnection();
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    throw new Error(`Transaction ${signature} not found (not yet confirmed, or invalid signature)`);
  }
  if (tx.meta?.err) {
    throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(tx.meta.err)}`);
  }

  const accountKeys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const allKeys: PublicKey[] = [];
  for (let i = 0; i < accountKeys.length; i++) {
    allKeys.push(accountKeys.get(i)!);
  }

  const compiledIxs = tx.transaction.message.compiledInstructions;
  const results: VerifiedInstruction[] = [];

  for (const ix of compiledIxs) {
    const programId = allKeys[ix.programIdIndex];
    if (!programId || !programId.equals(PROGRAM_ID)) continue;

    const decoded = coder.decode(Buffer.from(ix.data));
    if (!decoded) continue;

    results.push({
      name: toCamelCase(decoded.name),
      data: decoded.data as Record<string, any>,
      accountKeys: ix.accountKeyIndexes.map((idx) => allKeys[idx]!.toBase58()),
    });
  }

  if (results.length === 0) {
    throw new Error(`Transaction ${signature} does not contain any instruction for program ${PROGRAM_ID.toBase58()}`);
  }

  return results;
}

/**
 * Verifies that `signature` contains a successful `instructionName` call against our program,
 * with `walletBase58` present among the instruction's accounts (i.e. they actually signed it,
 * not just pasted someone else's signature). Throws with a descriptive message on any mismatch.
 */
/**
 * Returns the net lamport change for `walletBase58` within an already-confirmed transaction —
 * used to record the real cashout/claim amount instead of recomputing it off-chain (the contract
 * doesn't return instruction results, so this is the only reliable source for "how much moved").
 */
export async function getAccountBalanceDelta(
  solana: SolanaService,
  signature: string,
  walletBase58: string
): Promise<number> {
  const connection = solana.getConnection();
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) {
    throw new Error(`Transaction ${signature} not found or missing metadata`);
  }

  const accountKeys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  for (let i = 0; i < accountKeys.length; i++) {
    if (accountKeys.get(i)?.toBase58() === walletBase58) {
      return tx.meta.postBalances[i] - tx.meta.preBalances[i];
    }
  }
  throw new Error(`Wallet ${walletBase58} is not an account in transaction ${signature}`);
}

export async function verifyOnChainInstruction(
  solana: SolanaService,
  signature: string,
  instructionName: string,
  walletBase58: string
): Promise<VerifiedInstruction> {
  const instructions = await fetchProgramInstructions(solana, signature);
  const match = instructions.find((ix) => ix.name === instructionName);

  if (!match) {
    const found = instructions.map((ix) => ix.name).join(", ");
    throw new Error(`Expected a "${instructionName}" instruction in ${signature}, found: [${found}]`);
  }
  if (!match.accountKeys.includes(walletBase58)) {
    throw new Error(`Wallet ${walletBase58} is not a party to the "${instructionName}" instruction in ${signature}`);
  }

  return match;
}
