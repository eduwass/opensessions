import type { AgentEvent } from "../contracts/agent";
import { TERMINAL_STATUSES } from "../contracts/agent";

const MAX_EVENT_TIMESTAMPS = 30;
const TERMINAL_PRUNE_MS = 5 * 60 * 1000;

const STATUS_PRIORITY: Record<string, number> = {
  running: 5,
  error: 4,
  interrupted: 3,
  waiting: 2,
  done: 1,
  idle: 0,
};

export function instanceKey(agent: string, threadId?: string): string {
  return threadId ? `${agent}:${threadId}` : agent;
}

export class AgentTracker {
  // Outer key: session name, inner key: instance key (agent or agent:threadId)
  private instances = new Map<string, Map<string, AgentEvent>>();
  private eventTimestamps = new Map<string, number[]>();
  // Per-instance unseen tracking: "session\0instanceKey"
  private unseenInstances = new Set<string>();
  private active = new Set<string>();
  // Pinned instances: agents backed by a live pane process — exempt from pruning
  private pinnedKeys = new Map<string, Set<string>>(); // session → Set<instanceKey>

  private unseenKey(session: string, key: string): string {
    return `${session}\0${key}`;
  }

  applyEvent(event: AgentEvent, options?: { seed?: boolean }): void {
    const key = instanceKey(event.agent, event.threadId);

    // Store instance
    let sessionInstances = this.instances.get(event.session);
    if (!sessionInstances) {
      sessionInstances = new Map();
      this.instances.set(event.session, sessionInstances);
    }
    sessionInstances.set(key, event);

    // Track event timestamps
    let timestamps = this.eventTimestamps.get(event.session);
    if (!timestamps) {
      timestamps = [];
      this.eventTimestamps.set(event.session, timestamps);
    }
    timestamps.push(event.ts);
    if (timestamps.length > MAX_EVENT_TIMESTAMPS) {
      timestamps.splice(0, timestamps.length - MAX_EVENT_TIMESTAMPS);
    }

    // Per-instance unseen tracking
    // Seeded events always mark as unseen (they represent state from before the user connected)
    const ukey = this.unseenKey(event.session, key);
    if (TERMINAL_STATUSES.has(event.status)) {
      if (options?.seed || !this.active.has(event.session)) {
        this.unseenInstances.add(ukey);
      }
    } else {
      // Non-terminal status for this instance = user is interacting, mark seen
      this.unseenInstances.delete(ukey);
    }
  }

  /** Returns the most important agent state for backward compat */
  getState(session: string): AgentEvent | null {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances || sessionInstances.size === 0) return null;

    let best: AgentEvent | null = null;
    let bestPriority = -1;
    for (const event of sessionInstances.values()) {
      const p = STATUS_PRIORITY[event.status] ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        best = event;
      }
    }
    return best;
  }

  /** Returns all agent instances for a session, with unseen flag stamped */
  getAgents(session: string): AgentEvent[] {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances) return [];
    return [...sessionInstances.values()]
      .map((event) => {
        const key = instanceKey(event.agent, event.threadId);
        const isUnseen = this.unseenInstances.has(this.unseenKey(session, key));
        return isUnseen ? { ...event, unseen: true } : event;
      })
      .sort((a, b) => b.ts - a.ts);
  }

  /** Returns recent event timestamps for sparkline rendering */
  getEventTimestamps(session: string): number[] {
    return this.eventTimestamps.get(session) ?? [];
  }

  markSeen(session: string): boolean {
    const hadUnseen = this.isUnseen(session);
    if (!hadUnseen) return false;

    // Clear unseen flags for all instances — keep the instances themselves
    // (pruneTerminal will remove seen terminal instances after timeout)
    const sessionInstances = this.instances.get(session);
    if (sessionInstances) {
      for (const key of sessionInstances.keys()) {
        this.unseenInstances.delete(this.unseenKey(session, key));
      }
    }
    return true;
  }

  markSeenInstance(session: string, agent: string, threadId?: string): void {
    const key = instanceKey(agent, threadId);
    this.unseenInstances.delete(this.unseenKey(session, key));
  }

  dismiss(session: string, agent: string, threadId?: string): boolean {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances) return false;

    const key = instanceKey(agent, threadId);
    const removed = sessionInstances.delete(key);
    if (!removed) return false;

    this.unseenInstances.delete(this.unseenKey(session, key));
    if (sessionInstances.size === 0) {
      this.instances.delete(session);
    }
    return true;
  }

  pruneStuck(timeoutMs: number): void {
    const now = Date.now();
    for (const [session, sessionInstances] of this.instances) {
      for (const [key, event] of sessionInstances) {
        if (event.status === "running" && now - event.ts > timeoutMs) {
          if (this.isPinned(session, key)) continue;
          sessionInstances.delete(key);
          this.unseenInstances.delete(this.unseenKey(session, key));
        }
      }
      if (sessionInstances.size === 0) {
        this.instances.delete(session);
      }
    }
  }

  /** Auto-prune terminal instances older than timeout, but only if instance is not unseen or pinned */
  pruneTerminal(): void {
    const now = Date.now();
    for (const [session, sessionInstances] of this.instances) {
      for (const [key, event] of sessionInstances) {
        if (!TERMINAL_STATUSES.has(event.status)) continue;
        const ukey = this.unseenKey(session, key);
        if (this.unseenInstances.has(ukey)) continue; // Don't prune unseen — user hasn't looked yet
        if (this.isPinned(session, key)) continue; // Don't prune agents backed by live panes
        if (now - event.ts > TERMINAL_PRUNE_MS) {
          sessionInstances.delete(key);
        }
      }
      if (sessionInstances.size === 0) {
        this.instances.delete(session);
      }
    }
  }

  isUnseen(session: string): boolean {
    // Session is unseen if any instance within it is unseen
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances) return false;
    for (const key of sessionInstances.keys()) {
      if (this.unseenInstances.has(this.unseenKey(session, key))) return true;
    }
    return false;
  }

  getUnseen(): string[] {
    // Derive session-level unseen from per-instance tracking
    const sessions = new Set<string>();
    for (const ukey of this.unseenInstances) {
      sessions.add(ukey.split("\0")[0]!);
    }
    return [...sessions];
  }

  handleFocus(session: string): boolean {
    this.active.clear();
    this.active.add(session);
    // Don't clear unseen here — let pane-level focus handle it
    return this.isUnseen(session);
  }

  setActiveSessions(sessions: string[]): void {
    this.active.clear();
    for (const s of sessions) this.active.add(s);
  }

  /** Update the set of pinned instance keys for a session (live pane-backed agents). */
  setPinnedInstances(session: string | null, keys: string[]): void {
    this.pinnedKeys.clear();
    if (session && keys.length > 0) {
      this.pinnedKeys.set(session, new Set(keys));
    }
  }

  /** Update pinned instance keys for multiple sessions at once. */
  setPinnedInstancesMulti(keysBySession: Map<string, string[]>): void {
    this.pinnedKeys.clear();
    for (const [session, keys] of keysBySession) {
      if (keys.length > 0) {
        this.pinnedKeys.set(session, new Set(keys));
      }
    }
  }

  /** Check if an instance is pinned (backed by a live pane process). */
  isPinned(session: string, key: string): boolean {
    return this.pinnedKeys.get(session)?.has(key) ?? false;
  }
}
