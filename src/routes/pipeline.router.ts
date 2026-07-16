import { Router } from "express";
import { getPipelineService } from "../services/instances";

const router = Router();

async function handleSync(_req: any, res: any) {
  try {
    const pipeline = await getPipelineService();
    await pipeline.syncFeed();
    res.json({ success: true, timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

async function handleTick(_req: any, res: any) {
  try {
    const pipelineService = await getPipelineService();
    const result = await pipelineService.tick();
    res.json({ ok: true, processed: result.eventsProcessed });
  } catch (err: any) {
    console.error("Pipeline tick failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

router.get("/sync", handleSync);
router.post("/sync", handleSync);
router.get("/tick", handleTick);
router.post("/tick", handleTick);

export default router;
