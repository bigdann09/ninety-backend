import axios from "axios";
import { Keypair } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplCore, create } from "@metaplex-foundation/mpl-core";
import { keypairIdentity, generateSigner, publicKey as umiPublicKey } from "@metaplex-foundation/umi";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const PINATA_JWT = process.env.PINATA_JWT;
if (!PINATA_JWT) {
  throw new Error("PINATA_JWT environment variable is required (NFT receipt minting cannot run without it)");
}
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

interface SVGData {
  homeTeam: string;
  awayTeam: string;
  score: string;
  minute: number;
  competition: string;
  marketQuestion: string;
  position: string;
  stake: string;
  outcome: "WON" | "LOST";
  payout: string;
  txSignature: string;
  settledAt: string;
}

export interface SettledStakeData {
  id: string;
  user_wallet: string;
  side: string;
  amount_lamports: string;
  settlement_tx_signature: string;
  market: {
    id: string;
    question: string;
    outcome: boolean | null;
    market_type: string;
    match: {
      id: string;
      home_team: string;
      away_team: string;
      competition: string;
      score_home: number | null;
      score_away: number | null;
      kickoff_at: Date;
    };
    stakes: { side: string; amount_lamports: string }[];
  };
}

function generateReceiptSVG(data: SVGData): string {
  const outcomeColor = data.outcome === "WON" ? "#00D4AA" : "#C0392B";
  const shortSig = `${data.txSignature.slice(0, 6)}...${data.txSignature.slice(-6)}`;

  const words = data.marketQuestion.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length > 42) {
      lines.push(current.trim());
      current = w;
    } else {
      current = (current + " " + w).trim();
    }
    if (lines.length >= 2) { current = "..."; break; }
  }
  if (current) lines.push(current.trim());

  const questionLines = lines
    .map((l, i) => `<text x="200" y="${135 + i * 16}" fill="#B0C4B0" font-size="11" text-anchor="middle" font-family="'Courier New', monospace">${l}</text>`)
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560" font-family="'Courier New', monospace">
  <rect width="400" height="560" fill="#0B1410"/>
  <line x1="20" y1="30" x2="380" y2="30" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="6,4"/>
  <text x="200" y="22" fill="#F97316" font-size="11" text-anchor="middle" letter-spacing="4">NINETY</text>
  <text x="200" y="75" fill="#FFFFFF" font-size="18" text-anchor="middle" font-weight="bold">${data.homeTeam} ${data.score} ${data.awayTeam}</text>
  <text x="200" y="95" fill="#6B7C6B" font-size="11" text-anchor="middle">${data.competition} · ${data.minute}'</text>
  <line x1="40" y1="115" x2="360" y2="115" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  ${questionLines}
  <text x="200" y="210" fill="#FFFFFF" font-size="14" text-anchor="middle">${data.position} · ${data.stake}</text>
  <text x="200" y="260" fill="${outcomeColor}" font-size="28" text-anchor="middle" font-weight="bold" letter-spacing="3">${data.outcome}</text>
  <text x="200" y="285" fill="${outcomeColor}" font-size="16" text-anchor="middle">${data.payout}</text>
  <line x1="40" y1="310" x2="360" y2="310" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="200" y="335" fill="#6B7C6B" font-size="9" text-anchor="middle" letter-spacing="3">ON-CHAIN PROOF</text>
  <text x="200" y="360" fill="#8B9E8B" font-size="11" text-anchor="middle">${shortSig}</text>
  <text x="200" y="380" fill="#F97316" font-size="10" text-anchor="middle">explorer.solana.com ↗</text>
  <text x="200" y="420" fill="#4A5E4A" font-size="10" text-anchor="middle">${data.settledAt}</text>
  <line x1="20" y1="445" x2="380" y2="445" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="6,4"/>
  <text x="200" y="465" fill="#2A3E2A" font-size="9" text-anchor="middle" letter-spacing="2">SOLANA DEVNET</text>
</svg>`;
}

async function uploadSvgToPinata(svgContent: string, name: string): Promise<string> {
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const svgBytes = Buffer.from(svgContent, "utf-8");

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.svg"\r\nContent-Type: image/svg+xml\r\n\r\n`),
    svgBytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="pinataMetadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name })}\r\n--${boundary}--\r\n`),
  ]);

  const resp = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", body, {
    headers: {
      "Authorization": `Bearer ${PINATA_JWT}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    maxBodyLength: Infinity,
  });

  return `https://gateway.pinata.cloud/ipfs/${resp.data.IpfsHash}`;
}

async function uploadJsonToPinata(json: object, name: string): Promise<string> {
  const resp = await axios.post(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    { pinataContent: json, pinataMetadata: { name } },
    { headers: { "Authorization": `Bearer ${PINATA_JWT}`, "Content-Type": "application/json" } }
  );
  return `https://gateway.pinata.cloud/ipfs/${resp.data.IpfsHash}`;
}

function loadKeeperKeypair(): Keypair {
  const keypairPath = process.env.KEEPER_KEYPAIR_PATH ||
    path.join(process.env.HOME || "/home/dann", ".config/solana/id.json");
  try {
    if (fs.existsSync(keypairPath)) {
      const raw = fs.readFileSync(keypairPath, "utf-8");
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
  } catch {}
  return Keypair.generate();
}

export async function mintReceiptNFT(stake: SettledStakeData): Promise<{ mintAddress: string; metadataUri: string }> {
  const market = stake.market;
  const match = market.match;

  const stakeSol = Number(stake.amount_lamports) / 1e9;
  const won = (stake.side === "yes" && market.outcome === true) ||
              (stake.side === "no" && market.outcome === false);
  const outcome: "WON" | "LOST" = won ? "WON" : "LOST";

  const isGoal = market.market_type === "goal";
  const dbStakes = market.stakes || [];
  const yesDbSol = dbStakes.filter(s => s.side === "yes").reduce((sum, s) => sum + Number(s.amount_lamports), 0) / 1e9;
  const noDbSol = dbStakes.filter(s => s.side === "no").reduce((sum, s) => sum + Number(s.amount_lamports), 0) / 1e9;
  const seedYes = isGoal ? 6.26 : 2.48;
  const seedNo = isGoal ? 12.16 : 1.80;
  const yesPoolSol = seedYes + yesDbSol;
  const noPoolSol = seedNo + noDbSol;
  const totalPoolSol = yesPoolSol + noPoolSol;
  const price = stake.side === "yes" ? (yesPoolSol / totalPoolSol) : (noPoolSol / totalPoolSol);
  const payoutSol = won ? (stakeSol / price) : 0;

  const kickoff = new Date(match.kickoff_at);
  const diffMs = Date.now() - kickoff.getTime();
  const minute = Math.max(1, Math.min(90, Math.floor(diffMs / 60000)));
  const scoreHome = match.score_home ?? 0;
  const scoreAway = match.score_away ?? 0;
  const settledAt = new Date().toISOString();
  const txSig = stake.settlement_tx_signature || "unknown";

  // 1. Generate SVG receipt
  const svgData: SVGData = {
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    score: `${scoreHome}–${scoreAway}`,
    minute,
    competition: match.competition,
    marketQuestion: market.question,
    position: stake.side.toUpperCase(),
    stake: `${stakeSol.toFixed(2)} SOL`,
    outcome,
    payout: won ? `${payoutSol.toFixed(3)} SOL` : "0.000 SOL",
    txSignature: txSig,
    settledAt,
  };

  console.log(`[NFT Service] Generating SVG for stake ${stake.id}...`);
  const svg = generateReceiptSVG(svgData);

  // 2. Upload SVG to Pinata
  const imageName = `ninety-receipt-${stake.id.slice(0, 8)}`;
  const imageUri = await uploadSvgToPinata(svg, imageName);
  console.log(`[NFT Service] Image uploaded: ${imageUri}`);

  // 3. Build + upload metadata JSON
  const metadata = {
    name: `Ninety Receipt · ${match.home_team} vs ${match.away_team}`,
    symbol: "NINETY",
    description: "Verified settlement receipt for a Ninety micro-market stake.",
    image: imageUri,
    attributes: [
      { trait_type: "Match", value: `${match.home_team} vs ${match.away_team}` },
      { trait_type: "Competition", value: match.competition },
      { trait_type: "Minute", value: String(minute) },
      { trait_type: "Market", value: market.question },
      { trait_type: "Position", value: stake.side.toUpperCase() },
      { trait_type: "Stake", value: `${stakeSol.toFixed(2)} SOL` },
      { trait_type: "Outcome", value: outcome },
      { trait_type: "Payout", value: won ? `${payoutSol.toFixed(3)} SOL` : "0.000 SOL" },
      { trait_type: "Settlement TX", value: `${txSig.slice(0, 4)}...${txSig.slice(-4)}` },
      { trait_type: "Settled At", value: settledAt },
    ],
    properties: {
      category: "image",
      settlement_tx: txSig,
      market_id: market.id,
      stake_id: stake.id,
    },
  };

  const metadataUri = await uploadJsonToPinata(metadata, `${imageName}-metadata`);
  console.log(`[NFT Service] Metadata uploaded: ${metadataUri}`);

  // 4. Mint NFT via Metaplex Core UMI
  const solanaKeypair = loadKeeperKeypair();

  // Convert @solana/web3.js Keypair to UMI keypair format
  const umiKeypair = {
    publicKey: umiPublicKey(solanaKeypair.publicKey.toBase58()),
    secretKey: solanaKeypair.secretKey,
  };

  const umi = createUmi(RPC_URL)
    .use(mplCore())
    .use(keypairIdentity(umiKeypair));

  const asset = generateSigner(umi);

  await create(umi, {
    asset,
    name: `Ninety Receipt · ${match.home_team} vs ${match.away_team}`,
    uri: metadataUri,
    owner: umiPublicKey(stake.user_wallet),
  }).sendAndConfirm(umi);

  const mintAddress = asset.publicKey.toString();
  console.log(`[NFT Service] Minted NFT asset: ${mintAddress} → owner: ${stake.user_wallet}`);

  return { mintAddress, metadataUri };
}
