import { SolanaService } from "./solana.service";
import { TxlineService } from "./txline.service";
import { PipelineService } from "./pipeline.service";

let solanaServiceInstance: SolanaService | null = null;
let txlineServiceInstance: TxlineService | null = null;
let pipelineServiceInstance: PipelineService | null = null;

export function getSolanaService(): SolanaService {
  if (!solanaServiceInstance) {
    solanaServiceInstance = new SolanaService();
  }
  return solanaServiceInstance;
}

export async function getTxlineService(): Promise<TxlineService> {
  if (!txlineServiceInstance) {
    const solana = getSolanaService();
    txlineServiceInstance = new TxlineService(solana);
    await txlineServiceInstance.initialize();
  }
  return txlineServiceInstance;
}

export async function getPipelineService(): Promise<PipelineService> {
  if (!pipelineServiceInstance) {
    const solana = getSolanaService();
    const txline = await getTxlineService();
    pipelineServiceInstance = new PipelineService(solana, txline);
  }
  return pipelineServiceInstance;
}
