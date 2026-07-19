import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { getPipelineService, getSolanaService } from "./services/instances";
import { ensureTournamentMarkets } from "./services/tournament.service";
import matchesRouter from "./routes/matches.router";
import streakRouter from "./routes/streak.router";
import usersRouter from "./routes/users.router";
import miscRouter from "./routes/misc.router";
import stakesRouter from "./routes/stakes.router";
import p2pRouter from "./routes/p2p.router";
import webhooksRouter from "./routes/webhooks.router";
import pipelineRouter from "./routes/pipeline.router";

dotenv.config();

// This process has crashed twice from transient network blips (DNS/RPC/websocket errors
// deep inside @solana/web3.js's connection layer, e.g. its internal RPC websocket emitting
// an unhandled 'error' event) — Node kills the whole process on an unhandled rejection or
// an EventEmitter 'error' with no listener by default. Every route already has its own
// try/catch and the pipeline already logs+continues on its own errors, so a crash here
// is always something escaping those — log it and keep the process (and the live feed,
// and every other route) up instead of taking the whole backend down over one bad request.
process.on("unhandledRejection", (reason) => {
  console.error("[Process] Unhandled rejection (continuing):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception (continuing):", err.message, err.stack);
});

const app = express();
const port = process.env.PORT || 3001;
const corsOrigin = process.env.FRONTEND_URL || "*";
if (corsOrigin === "*") {
  console.warn("[CORS] FRONTEND_URL is not set — allowing all origins. Set FRONTEND_URL in production.");
}

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Create HTTP server + attach Socket.IO (kept exactly as before — in-memory, no DB, portable as-is)
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: corsOrigin, methods: ["GET", "POST"] },
});

// In-memory chat store: matchId → last 50 messages
const chatRooms = new Map<string, { wallet: string; message: string; ts: number }[]>();

io.on("connection", (socket) => {
  console.log(`[Chat] Socket connected: ${socket.id}`);

  socket.on("chat:join", (matchId: string) => {
    socket.join(matchId);
    const history = chatRooms.get(matchId) || [];
    socket.emit("chat:history", history);

    const roomSize = io.sockets.adapter.rooms.get(matchId)?.size || 0;
    io.to(matchId).emit("chat:count", roomSize);
    console.log(`[Chat] ${socket.id} joined room: ${matchId} (${roomSize} online)`);
  });

  socket.on("chat:message", ({ matchId, wallet, message }: { matchId: string; wallet: string; message: string }) => {
    if (!matchId || !wallet || !message?.trim()) return;
    const msg = { wallet, message: message.trim().slice(0, 200), ts: Date.now() };

    if (!chatRooms.has(matchId)) chatRooms.set(matchId, []);
    const room = chatRooms.get(matchId)!;
    room.push(msg);
    if (room.length > 50) room.splice(0, room.length - 50);

    io.to(matchId).emit("chat:new", msg);
  });

  socket.on("disconnect", () => {
    socket.rooms.forEach((room) => {
      if (room !== socket.id) {
        const roomSize = io.sockets.adapter.rooms.get(room)?.size || 0;
        io.to(room).emit("chat:count", roomSize);
      }
    });
    console.log(`[Chat] Socket disconnected: ${socket.id}`);
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "ninety-backend", time: new Date().toISOString() }));

app.use("/api/matches", matchesRouter);
app.use("/api/users", usersRouter);
app.use("/api/stakes", stakesRouter);
app.use("/api/p2p/challenges", p2pRouter);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/pipeline", pipelineRouter);
app.use("/api/streak", streakRouter);
app.use("/api", miscRouter);

async function bootstrap() {
  try {
    const pipelineService = await getPipelineService();
    pipelineService.startLiveEventStream();
    ensureTournamentMarkets(getSolanaService()).catch((e) =>
      console.error("[Tournament] Bootstrap failed:", e.message)
    );

    const tickIntervalMs = Number(process.env.PIPELINE_TICK_INTERVAL_MS || 60_000);
    setInterval(async () => {
      try {
        const pipeline = await getPipelineService();
        await pipeline.tick();
      } catch (err: any) {
        console.error("[Pipeline] Scheduled tick failed:", err.message);
      }
    }, tickIntervalMs);
    console.log(`[Pipeline] Scheduled tick every ${tickIntervalMs}ms`);

    httpServer.listen(port, () => {
      console.log(`Ninety backend running on http://localhost:${port}`);
      console.log(`Socket.IO chat server attached on same port`);
    });
  } catch (error) {
    console.error("Bootstrap error:", error);
    process.exit(1);
  }
}

bootstrap();
