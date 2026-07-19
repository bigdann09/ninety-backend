/**
 * Everything in this file is deterministic — no Groq calls. Stats, momentum, the
 * timeline, and win probability are all computed straight from the real TxODDS event
 * log, which keeps them honest (no hallucinated shot counts or possession numbers)
 * and keeps the Match Pulse feature cheap to serve regardless of Groq's free-tier
 * rate limit. The one place Groq is actually used (the narrative summary + key
 * moments) lives in GroqService.generateMatchPulseNarrative, called separately and
 * cached by the route.
 */

export type Team = "home" | "away";

export type TeamStats = {
  goals: number;
  corners: number;
  yellowCards: number;
  redCards: number;
  shots: number;
  freeKicks: number;
  throwIns: number;
  substitutions: number;
};

export type MomentumPoint = { minute: number; value: number };

export type TimelineItem = {
  type: string;
  minute: number;
  team: Team | null;
  label: string;
};

const emptyStats = (): TeamStats => ({
  goals: 0,
  corners: 0,
  yellowCards: 0,
  redCards: 0,
  shots: 0,
  freeKicks: 0,
  throwIns: 0,
  substitutions: 0,
});

/** Maps a raw TxODDS event payload's `Participant` (1 or 2) to home/away using `Participant1IsHome`. */
function teamOf(payload: any): Team | null {
  if (!payload || payload.Participant == null) return null;
  const p1IsHome = payload.Participant1IsHome !== false;
  const isParticipant1 = payload.Participant === 1;
  if (p1IsHome) return isParticipant1 ? "home" : "away";
  return isParticipant1 ? "away" : "home";
}

/** Minute derived from TxODDS's own match clock when available (accounts for stoppage), else wall-clock fallback. */
function minuteOf(ev: any, kickoffMs: number): number {
  const seconds = ev.payload?.Clock?.Seconds;
  if (typeof seconds === "number" && seconds >= 0) return Math.floor(seconds / 60);
  const occurred = new Date(ev.occurred_at || Date.now()).getTime();
  return Math.max(0, Math.floor((occurred - kickoffMs) / 60000));
}

/** The official running Goals/Corners/Cards totals TxODDS itself maintains — the most authoritative source we have. */
function officialTotals(events: any[], participant1IsHome: boolean): { home: Partial<TeamStats>; away: Partial<TeamStats> } | null {
  const scoreEvent = [...events].reverse().find((e) => e.payload?.Score);
  if (!scoreEvent) return null;
  const s = scoreEvent.payload.Score;
  const p1 = s.Participant1?.Total || {};
  const p2 = s.Participant2?.Total || {};
  const toPartial = (p: any): Partial<TeamStats> => ({
    goals: p.Goals ?? 0,
    corners: p.Corners ?? 0,
    yellowCards: p.YellowCards ?? 0,
    redCards: p.RedCards ?? 0,
  });
  return participant1IsHome
    ? { home: toPartial(p1), away: toPartial(p2) }
    : { home: toPartial(p2), away: toPartial(p1) };
}

export function computeTeamStats(
  events: any[],
  authoritativeScore?: { home: number; away: number }
): { home: TeamStats; away: TeamStats } {
  const home = emptyStats();
  const away = emptyStats();

  const p1IsHome = events.find((e) => e.payload?.Participant1IsHome !== undefined)?.payload?.Participant1IsHome !== false;
  const official = officialTotals(events, p1IsHome);
  if (official) {
    Object.assign(home, official.home);
    Object.assign(away, official.away);
  }

  // The "official Score totals" above come from whichever event happened to be the last
  // one carrying a Score payload — not necessarily the true final one, since some later
  // events (e.g. game_finalised) don't always re-embed a fresh cumulative Score. The
  // matches table's score is tracked incrementally as a running max across every event
  // (see PipelineService.handleStreamEvent) and has proven correct end-to-end, so goals
  // specifically should defer to it rather than a possibly-stale embedded snapshot.
  if (authoritativeScore) {
    home.goals = Math.max(home.goals, authoritativeScore.home);
    away.goals = Math.max(away.goals, authoritativeScore.away);
  }

  for (const ev of events) {
    const team = teamOf(ev.payload);
    const bucket = team === "home" ? home : team === "away" ? away : null;
    if (!bucket) continue;
    switch (ev.event_type) {
      case "shot":
        bucket.shots++;
        break;
      case "free_kick":
        bucket.freeKicks++;
        break;
      case "throw_in":
        bucket.throwIns++;
        break;
      case "substitution":
        bucket.substitutions++;
        break;
      // goals/corners/cards come from the official Score totals above when present;
      // only fall back to counting raw events if no Score payload existed at all.
      case "goal":
        if (!official) bucket.goals++;
        break;
      case "corner":
        if (!official) bucket.corners++;
        break;
      case "yellow_card":
        if (!official) bucket.yellowCards++;
        break;
      case "red_card":
      case "redcard":
        if (!official) bucket.redCards++;
        break;
    }
  }

  return { home, away };
}

const MOMENTUM_WEIGHTS: Record<string, number> = {
  goal: 8,
  shot: 2,
  corner: 1.5,
  high_danger_possession: 1.2,
  danger_possession: 1,
  attack_possession: 0.5,
  free_kick: 0.5,
  yellow_card: -1,
  red_card: -3,
  redcard: -3,
};

const MOMENTUM_BUCKET_MINUTES = 6;
const MOMENTUM_SCALE = 8;

/** Buckets weighted events into ~6-minute windows across the match so far, normalized to [-1, 1] (away..home). */
export function computeMomentum(events: any[], kickoffMs: number, matchElapsedMinutes: number): { points: MomentumPoint[]; current: number } {
  const bucketCount = Math.max(1, Math.ceil(Math.max(matchElapsedMinutes, 1) / MOMENTUM_BUCKET_MINUTES));
  const raw = new Array(bucketCount).fill(0);

  for (const ev of events) {
    const weight = MOMENTUM_WEIGHTS[ev.event_type];
    if (!weight) continue;
    const team = teamOf(ev.payload);
    if (!team) continue;
    const minute = minuteOf(ev, kickoffMs);
    const bucketIdx = Math.min(bucketCount - 1, Math.floor(minute / MOMENTUM_BUCKET_MINUTES));
    // Cards are logged against the team that committed the foul, so they should read as
    // a momentum boost for the *other* side — flip sign for the team actually penalized.
    const isPenalty = ev.event_type === "yellow_card" || ev.event_type === "red_card" || ev.event_type === "redcard";
    const signedWeight = isPenalty ? -Math.abs(weight) : Math.abs(weight);
    raw[bucketIdx] += team === "home" ? signedWeight : -signedWeight;
  }

  const points: MomentumPoint[] = raw.map((v, i) => ({
    minute: i * MOMENTUM_BUCKET_MINUTES,
    value: Math.max(-1, Math.min(1, v / MOMENTUM_SCALE)),
  }));

  const lastTwo = points.slice(-2).map((p) => p.value);
  const current = lastTwo.length ? lastTwo.reduce((a, b) => a + b, 0) / lastTwo.length : 0;

  return { points, current };
}

const NOTABLE_TYPES = new Set([
  "goal",
  "yellow_card",
  "red_card",
  "redcard",
  "corner",
  "substitution",
  "free_kick",
  "var",
  "additional_time",
  "status",
]);

const TYPE_LABELS: Record<string, string> = {
  goal: "Goal",
  yellow_card: "Yellow Card",
  red_card: "Red Card",
  redcard: "Red Card",
  corner: "Corner",
  substitution: "Substitution",
  free_kick: "Free Kick",
  var: "VAR Review",
  additional_time: "Additional Time",
  status: "Status Update",
};

export function computeTimeline(events: any[], kickoffMs: number, limit = 10): TimelineItem[] {
  const notable = events
    .filter((e) => NOTABLE_TYPES.has(e.event_type))
    .map((ev) => ({ ev, minute: minuteOf(ev, kickoffMs), team: teamOf(ev.payload) }))
    .filter((e) => e.minute <= 100);

  const deduped: typeof notable = [];
  let lastSignature: string | null = null;
  for (const e of notable) {
    const signature = `${e.ev.event_type}:${e.team}:${e.minute}`;
    if (signature === lastSignature) continue;
    lastSignature = signature;
    deduped.push(e);
  }

  const capped: typeof notable = [];
  const perTypeCount: Record<string, number> = {};
  for (const e of [...deduped].reverse()) {
    const cap = e.ev.event_type === "corner" || e.ev.event_type === "free_kick" ? 2 : Infinity;
    perTypeCount[e.ev.event_type] = (perTypeCount[e.ev.event_type] || 0) + 1;
    if (perTypeCount[e.ev.event_type] <= cap) capped.push(e);
  }

  return capped.slice(0, limit).map((e) => ({
    type: e.ev.event_type,
    minute: e.minute,
    team: e.team,
    label: TYPE_LABELS[e.ev.event_type] || e.ev.event_type,
  }));
}

export type WinProbability = { home: number; draw: number; away: number };

export function computeWinProbability(
  status: string,
  scoreHome: number,
  scoreAway: number,
  minute: number,
  momentumCurrent: number
): WinProbability {
  if (status === "full_time") {
    if (scoreHome > scoreAway) return { home: 92, draw: 5, away: 3 };
    if (scoreAway > scoreHome) return { home: 3, draw: 5, away: 92 };
    return { home: 20, draw: 60, away: 20 };
  }

  const scoreDiff = scoreHome - scoreAway;
  const minutesLeft = Math.max(0, 90 - minute);
  const lateGameAmplifier = minutesLeft < 20 ? 1.4 : 1;

  let homeStrength = 50 + scoreDiff * 14 * lateGameAmplifier + momentumCurrent * 8;
  homeStrength = Math.max(4, Math.min(92, homeStrength));

  const certainty = Math.min(1, Math.abs(scoreDiff) / 2 + (90 - minutesLeft) / 180);
  const drawShare = Math.max(4, 26 - certainty * 20);

  const remaining = 100 - drawShare;
  const home = Math.round((homeStrength / 100) * remaining);
  const away = Math.round(remaining - home);

  return { home, draw: Math.round(drawShare), away };
}
