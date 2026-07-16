import { PublicKey } from "@solana/web3.js";

export const NETWORK = "devnet" as const;

export const CONFIG = {
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    apiOrigin: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlTokenMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
    serviceLevelId: 12,  // real-time World Cup
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    apiOrigin: "https://txline-dev.txodds.com",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlTokenMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    serviceLevelId: 1,   // free World Cup tier (60-second delay)
  },
} as const;

export const ACTIVE_CONFIG = CONFIG[NETWORK];
export const API_BASE = `${ACTIVE_CONFIG.apiOrigin}/api`;

/** Resolution-worthy event types — only these get anchored on-chain */
export const ANCHOR_EVENT_TYPES = ["goal", "card", "corner", "fulltime", "var", "throwin", "freekick"] as const;
export type AnchorEventType = typeof ANCHOR_EVENT_TYPES[number];
export const ANCHOR_EVENT_TYPE_MAP: Record<AnchorEventType, number> = {
  goal: 0, card: 1, corner: 2, fulltime: 3, var: 4, throwin: 5, freekick: 6,
};

/** Our own Ninety program ID (deployed to devnet) */
export const NINETY_PROGRAM_ID = "BmzkArt64NDhxRA8CMqmkETbhtM6HaGJdWpFbzkUwNkw";

/** Keeper authority pubkey — must match ~/.config/solana/id.json */
export const KEEPER_PUBKEY = "GP4vEquiGYPrw42WETmRBeyAUNA59pRR8WUD9TKUYsMG";

