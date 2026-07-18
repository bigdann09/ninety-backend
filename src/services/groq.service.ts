import axios from "axios";

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export class AIUndeterminedError extends Error {}

export class GroqService {
  private static apiKey = process.env.GROQ_API_KEY;
  private static apiUrl = "https://api.groq.com/openai/v1/chat/completions";

  public static async getChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    responseFormatJson: boolean = false,
    model: string = "llama-3.3-70b-versatile",
    attempt: number = 1
  ): Promise<any> {
    if (!this.apiKey) {
      throw new Error("GROQ_API_KEY environment variable is required");
    }
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          response_format: responseFormatJson ? { type: "json_object" } : undefined,
          temperature: 0.7,
        },
        {
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          timeout: 8000
        }
      );

      const content = response.data.choices[0].message.content;
      if (responseFormatJson) {
        return JSON.parse(content);
      }
      return content;
    } catch (e: any) {
      const isRateLimit = e.response?.status === 429 ||
        e.response?.data?.error?.code === "rate_limit_exceeded" ||
        (e.response?.data?.error?.message && e.response.data.error.message.includes("Rate limit"));

      if (isRateLimit) {
        if (attempt < 3) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(`[Groq Service] 429 Rate limit hit for ${model}. Retrying attempt ${attempt + 1} after ${delay.toFixed(0)}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return await this.getChatCompletion(systemPrompt, userPrompt, responseFormatJson, model, attempt + 1);
        }

        if (model === "llama-3.3-70b-versatile") {
          console.warn(`[Groq Service] All retries exhausted for llama-3.3-70b-versatile. Falling back to llama-3.1-8b-instant...`);
          try {
            return await this.getChatCompletion(systemPrompt, userPrompt, responseFormatJson, "llama-3.1-8b-instant", 1);
          } catch (fallbackErr: any) {
            console.warn(`[Groq Service] Fallback model llama-3.1-8b-instant failed:`, fallbackErr.message);
            console.warn(`[Groq Service] Attempting fallback to qwen/qwen3-32b...`);
            try {
              return await this.getChatCompletion(systemPrompt, userPrompt, responseFormatJson, "qwen/qwen3-32b", 1);
            } catch (mErr: any) {
              console.error(`[Groq Service] All fallback models failed.`);
            }
          }
        } else if (model === "llama-3.1-8b-instant") {
          console.warn(`[Groq Service] All retries exhausted for llama-3.1-8b-instant. Falling back to qwen/qwen3-32b...`);
          try {
            return await this.getChatCompletion(systemPrompt, userPrompt, responseFormatJson, "qwen/qwen3-32b", 1);
          } catch (mErr: any) {
            console.error(`[Groq Service] Fallback to qwen/qwen3-32b failed:`, mErr.message);
          }
        }
      }

      console.error("[Groq Service Error]:", e.response?.data || e.message);
      throw e;
    }
  }

  public static async generateCopilotInfo(
    homeTeam: string,
    awayTeam: string,
    scoreHome: number,
    scoreAway: number,
    minute: number,
    events: any[],
    competition: string = "Unknown"
  ): Promise<{ commentary: string; goalYesProb: number; cornerYesProb: number; throwinYesProb: number; freekickYesProb: number }> {
    const sortedEvents = [...events].sort((a, b) => new Date(b.occurred_at || 0).getTime() - new Date(a.occurred_at || 0).getTime());
    const lastEvent = sortedEvents[0];
    const lastEventType = lastEvent?.event_type || "kickoff";
    const lastEventTeam = lastEvent?.payload?.team || "unknown";
    const lastEventMinute = lastEvent ? Math.max(1, Math.min(90, Math.floor((Date.now() - new Date(lastEvent.occurred_at || Date.now()).getTime()) / 60000))) : minute;

    const systemPrompt = `You are a live football commentator for Ninety, a Solana prediction market.
Generate a valid JSON object with exactly these keys:
1. "commentary": ONE sentence (max 20 words) of match-specific commentary. Mention teams by name. Reference the score or the last event. Do NOT use "battle intensifies" or generic phrases.
2. "goalYesProb": probability 0.05–0.95 that a goal occurs in next 10 minutes, influenced by score, minute, and events.
3. "cornerYesProb": probability 0.05–0.95 that a corner occurs in next 2 minutes.
4. "throwinYesProb": probability 0.05–0.95 that a throw-in occurs in next 60 seconds (almost always high, 0.75–0.95).
5. "freekickYesProb": probability 0.05–0.95 that a free-kick occurs in next 120 seconds.

Output ONLY the raw JSON. No preamble.`;

    const userPrompt = `Match: ${homeTeam} vs ${awayTeam}
Score: ${scoreHome}–${scoreAway}
Minute: ${ordinal(minute)}
Competition: ${competition}
Last event: ${lastEventType} at ${ordinal(lastEventMinute)} (${lastEventTeam})
Recent events (last 5): ${JSON.stringify(sortedEvents.slice(0, 5).map(ev => ({ type: ev.event_type, team: ev.payload?.team })))}`;

    try {
      return await this.getChatCompletion(systemPrompt, userPrompt, true);
    } catch (err) {
      console.warn("Falling back to local simulation for Copilot info.");

      const goalRecent = events.some(e => e.event_type === "goal" && (Date.now() - new Date(e.occurred_at || Date.now()).getTime()) < 5 * 60000);
      const cornerRecent = events.some(e => e.event_type === "corner" && (Date.now() - new Date(e.occurred_at || Date.now()).getTime()) < 2 * 60000);

      const goalYesProb = goalRecent ? 0.35 : (minute > 75 ? 0.22 : 0.14);
      const cornerYesProb = cornerRecent ? 0.65 : 0.45;
      const throwinYesProb = 0.88;
      const freekickYesProb = 0.42;

      let commentary: string;
      if (goalRecent) {
        commentary = `${homeTeam} and ${awayTeam} are wide open after that goal — both pushing hard at the ${ordinal(minute)}.`;
      } else if (cornerRecent) {
        commentary = `${awayTeam} winning corners in quick succession — pressure building at the ${ordinal(minute)}.`;
      } else if (minute > 80) {
        commentary = `${scoreHome === scoreAway ? `${homeTeam} chasing an equaliser` : `${homeTeam > awayTeam ? homeTeam : awayTeam} holding firm`} with just ${90 - minute} minutes left.`;
      } else {
        commentary = `${homeTeam} ${scoreHome}–${scoreAway} ${awayTeam} — the ${ordinal(minute)} minute sees both sides probing for an opening.`;
      }

      return { commentary, goalYesProb, cornerYesProb, throwinYesProb, freekickYesProb };
    }
  }

  public static async generateMatchPulseNarrative(
    homeTeam: string,
    awayTeam: string,
    scoreHome: number,
    scoreAway: number,
    status: string,
    minute: number,
    keyEvents: { type: string; minute: number; team: string | null }[],
    competition: string = "Unknown"
  ): Promise<{ summary: string; keyMoments: string[] }> {
    const isFinished = status === "full_time";

    const systemPrompt = `You are a football analyst writing a short "match pulse" summary for Ninety, a Solana prediction market.
Generate a valid JSON object with exactly these keys:
1. "summary": ONE short paragraph (max 40 words) describing the current match state. Be specific — mention the score and what's happening, not generic filler.
2. "keyMoments": an array of up to 3 short strings (max 20 words each), each describing one turning point from the key events provided, in chronological order. If there are fewer than 3 real turning points, return fewer items — never pad with invented ones.
Output ONLY the raw JSON. No preamble.`;

    const userPrompt = `Match: ${homeTeam} vs ${awayTeam}
Competition: ${competition}
Status: ${status}${isFinished ? " (finished)" : ` (${ordinal(minute)} minute)`}
Score: ${scoreHome}-${scoreAway}
Key events in order: ${JSON.stringify(keyEvents)}`;

    try {
      return await this.getChatCompletion(systemPrompt, userPrompt, true);
    } catch (err) {
      console.warn("Falling back to local simulation for Match Pulse narrative.");
      const scoreLine = `${homeTeam} ${scoreHome}-${scoreAway} ${awayTeam}`;
      const summary = isFinished
        ? `${scoreLine} — full time. ${scoreHome === scoreAway ? "A drawn match." : `${scoreHome > scoreAway ? homeTeam : awayTeam} came out on top.`}`
        : `${scoreLine} at the ${ordinal(minute)} minute, ${Math.max(0, 90 - minute)} minutes left to play.`;

      const keyMoments = keyEvents
        .filter((e) => e.type === "goal" || e.type === "red_card")
        .slice(0, 3)
        .map((e) => `${e.type === "goal" ? "Goal" : "Red card"} at the ${ordinal(e.minute)} minute${e.team ? ` (${e.team === "home" ? homeTeam : awayTeam})` : ""}.`);

      return { summary, keyMoments };
    }
  }

  public static async generateRecommendations(
    userWallet: string,
    history: any[],
    activeMatches: any[]
  ): Promise<{ recommendedMatchId: string; reason: string }[]> {
    if (activeMatches.length === 0) return [];

    // Data-driven rationale — no AI needed for this
    return activeMatches.map(m => {
      const openMarketsCount = (m.markets || []).filter((mk: any) => mk.status === "open").length;
      const settledMarketsCount = (m.markets || []).filter((mk: any) => mk.status === "settled").length;
      const closingSoonCount = (m.markets || []).filter((mk: any) => {
        if (mk.status !== "open") return false;
        const remaining = (new Date(mk.closes_at).getTime() - Date.now()) / 1000;
        return remaining > 0 && remaining < 120;
      }).length;

      const totalPoolLamports = (m.markets || []).reduce((sum: number, mk: any) => {
        return sum + (mk.stakes || []).reduce((s: number, st: any) => s + Number(st.amount_lamports), 0);
      }, 0);
      const totalPoolSol = totalPoolLamports / 1e9;

      let reason: string;
      if (closingSoonCount > 0) {
        reason = `${closingSoonCount} market${closingSoonCount > 1 ? "s" : ""} closing in the next 2 min`;
      } else if (openMarketsCount > 2) {
        reason = `${openMarketsCount} open markets · ${m.competition}`;
      } else if (totalPoolSol > 5) {
        reason = `${totalPoolSol.toFixed(1)} SOL pooled · ${openMarketsCount} open markets`;
      } else {
        reason = `${openMarketsCount} markets open · ${settledMarketsCount} settled`;
      }

      return { recommendedMatchId: m.id, reason };
    });
  }

  public static async generateHistoricData(
    homeTeam: string,
    awayTeam: string
  ): Promise<{
    h2h: string[];
    form: { home: string[]; away: string[] };
    stats: { goals: string; corners: string; cards: string };
  }> {
    const systemPrompt = `You are a football database and analysis assistant.
Generate a valid JSON object representing realistic head-to-head history and current form for the two teams.
Format the output EXACTLY like this:
{
  "h2h": [
    "Team A 2-1 Team B (2024)",
    "Team B 1-1 Team A (2023)",
    "Team A 3-0 Team B (2023)"
  ],
  "form": {
    "home": ["W", "D", "W", "W", "L"],
    "away": ["D", "W", "L", "L", "W"]
  },
  "stats": {
    "goals": "2.4",
    "corners": "9.8",
    "cards": "3.8"
  }
}
Output ONLY raw JSON. No markdown backticks, no preamble.`;

    const userPrompt = `Home Team: ${homeTeam}
Away Team: ${awayTeam}`;

    try {
      return await this.getChatCompletion(systemPrompt, userPrompt, true);
    } catch (err) {
      console.warn("Falling back to simulated historical match data.");
      return {
        h2h: [
          `${homeTeam} 1-0 ${awayTeam} (2024)`,
          `${awayTeam} 2-1 ${homeTeam} (2023)`,
          `${homeTeam} 1-1 ${awayTeam} (2022)`
        ],
        form: {
          home: ["W", "D", "W", "L", "W"],
          away: ["D", "W", "L", "W", "L"]
        },
        stats: {
          goals: "2.1",
          corners: "8.6",
          cards: "3.2"
        }
      };
    }
  }

  public static async evaluateP2pChallenge(
    question: string,
    homeTeam: string,
    awayTeam: string,
    events: any[]
  ): Promise<{ outcome: boolean; reasoning: string }> {
    const systemPrompt = `You are the AI Referee for Ninety, a Solana-based sports betting platform.
Your job is to determine the outcome of a peer-to-peer wager based on the actual match events.
You will receive the match details, the custom prediction question, and a JSON array of events that occurred during the match.
Evaluate the question against the events.
Generate a valid JSON object with exactly these keys:
1. "outcome": boolean (true if the prediction statement is true/happened, false if it is false/did not happen).
2. "reasoning": a clear, 1-2 sentence explanation of why the outcome was chosen, referencing specific events or statistics (e.g. goals, corners, cards) from the event list.
Output ONLY the raw JSON. No preamble.`;

    const userPrompt = `Match: ${homeTeam} vs ${awayTeam}
Question: ${question}
Events: ${JSON.stringify(
      events.map((ev) => ({
        type: ev.event_type,
        team: ev.payload?.team,
        minute: ev.payload?.minute,
        score: ev.payload?.score,
        scorer: ev.payload?.scorer,
      }))
    )}`;

    try {
      const res = await this.getChatCompletion(systemPrompt, userPrompt, true);
      return {
        outcome: !!res.outcome,
        reasoning: res.reasoning || "Evaluated by AI Referee.",
      };
    } catch (err) {
      console.error("AI Referee evaluation failed, falling back to event-log heuristic:", err);
      const qLower = question.toLowerCase();

      if (qLower.includes("goal") || qLower.includes("score")) {
        const goalCount = events.filter((e) => e.event_type === "goal").length;
        return { outcome: goalCount > 0, reasoning: `Fallback: found ${goalCount} goal events in the match history.` };
      }
      if (qLower.includes("corner")) {
        const cornerCount = events.filter((e) => e.event_type === "corner").length;
        return { outcome: cornerCount > 2, reasoning: `Fallback: found ${cornerCount} corner events in the match history.` };
      }

      // No AI, and the question isn't one the heuristic can read off the event log —
      // do not guess on a real-money wager. The caller must route this to manual review.
      throw new AIUndeterminedError(
        `Could not confidently resolve "${question}" — AI unavailable and no matching event-log heuristic.`
      );
    }
  }
}
