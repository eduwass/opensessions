import { render } from "@opentui/solid";
import { appendFileSync } from "fs";
import { createSignal, createEffect, onCleanup, onMount, batch, For, Show, createMemo, createSelector, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { TextAttributes, type MouseEvent, type InputRenderable, type KeyEvent } from "@opentui/core";

import { ensureServer } from "@opensessions/runtime";
import {
  type ServerMessage,
  type SessionData,
  type WindowData,
  type PaneData,
  type ClientCommand,
  type Theme,
  type MetadataTone,
  type ExposedSite,
  SERVER_PORT,
  SERVER_HOST,
  BUILTIN_THEMES,
  loadConfig,
  resolveTheme,
  saveConfig,
} from "@opensessions/runtime";
import { TmuxClient } from "@opensessions/mux-tmux";

// Detect which mux we're running inside
type MuxContext =
  | { type: "tmux"; sdk: TmuxClient; paneId: string }
  | { type: "zellij"; sessionName: string; paneId: string }
  | { type: "none" };

function detectMuxContext(): MuxContext {
  if (process.env.TMUX_PANE && process.env.TMUX) {
    return { type: "tmux", sdk: new TmuxClient(), paneId: process.env.TMUX_PANE };
  }
  if (process.env.ZELLIJ_SESSION_NAME) {
    return {
      type: "zellij",
      sessionName: process.env.ZELLIJ_SESSION_NAME,
      paneId: process.env.ZELLIJ_PANE_ID ?? "",
    };
  }
  return { type: "none" };
}

const muxCtx = detectMuxContext();

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const UNSEEN_ICON = "●";
const BOLD = TextAttributes.BOLD;
const DIM = TextAttributes.DIM;
const SPARK_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

const THEME_NAMES = Object.keys(BUILTIN_THEMES);
const DEFAULT_DETAIL_PANEL_HEIGHT = 10;
const MIN_DETAIL_PANEL_HEIGHT = 4;
const RESIZE_DEBUG_LOG = "/tmp/opensessions-tui-resize.log";

const TONE_ICONS: Record<MetadataTone, string> = {
  neutral: "·",
  info: "ℹ",
  success: "✓",
  warn: "⚠",
  error: "✗",
};

function toneColor(tone: MetadataTone | undefined, palette: ReturnType<() => Theme["palette"]>): string {
  switch (tone) {
    case "success": return palette.green;
    case "error": return palette.red;
    case "warn": return palette.yellow;
    case "info": return palette.blue;
    default: return palette.overlay0;
  }
}

function logResizeDebug(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  try {
    appendFileSync(RESIZE_DEBUG_LOG, `[${ts}] [pid:${process.pid}] ${message}${extra}\n`);
  } catch {}
}

function clampDetailPanelHeight(height: number): number {
  return Math.max(MIN_DETAIL_PANEL_HEIGHT, Math.round(height));
}

function getStoredDetailPanelHeight(sessionName: string): number {
  const stored = loadConfig().detailPanelHeights?.[sessionName];
  return typeof stored === "number" ? clampDetailPanelHeight(stored) : DEFAULT_DETAIL_PANEL_HEIGHT;
}

function persistDetailPanelHeight(sessionName: string, height: number): void {
  const config = loadConfig();
  saveConfig({
    detailPanelHeights: {
      ...(config.detailPanelHeights ?? {}),
      [sessionName]: clampDetailPanelHeight(height),
    },
  });
}

/** Refocus the main (non-sidebar) pane after TUI capability detection finishes.
 *  This must happen from the TUI process — doing it from start.sh races with
 *  capability query responses and leaks escape sequences to the main pane. */
function refocusMainPane() {
  if (muxCtx.type === "tmux") {
    try {
      // Use the TUI's own pane ID to find its current window (handles stash restore
      // where the pane may have moved to a different window than the original).
      const windowId = process.env.REFOCUS_WINDOW
        || Bun.spawnSync(
            ["tmux", "display-message", "-t", muxCtx.paneId, "-p", "#{window_id}"],
            { stdout: "pipe", stderr: "pipe" },
          ).stdout.toString().trim();
      if (!windowId) return;
      const r = Bun.spawnSync(
        ["tmux", "list-panes", "-t", windowId, "-F", "#{pane_id} #{pane_title}"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const lines = r.stdout.toString().trim().split("\n");
      const main = lines.find((l) => !l.includes("opensessions-sidebar"));
      if (main) {
        const paneId = main.split(" ")[0];
        Bun.spawnSync(["tmux", "select-pane", "-t", paneId], { stdout: "pipe", stderr: "pipe" });
      }
    } catch {}
  } else if (muxCtx.type === "zellij") {
    // Zellij: move focus to the right (away from the sidebar on the left)
    try {
      Bun.spawnSync(["zellij", "action", "move-focus", "right"], { stdout: "pipe", stderr: "pipe" });
    } catch {}
  }
}

function getClientTty(): string {
  if (muxCtx.type === "tmux") {
    const { sdk, paneId } = muxCtx;
    const sessName = sdk.display("#{session_name}", { target: paneId });
    if (sessName) {
      const clients = sdk.listClients();
      const client = clients.find((c) => c.sessionName === sessName);
      if (client) return client.tty;
    }
    return sdk.getClientTty();
  }
  // Zellij doesn't expose client TTY
  return "";
}

function getLocalSessionName(): string | null {
  if (muxCtx.type === "tmux") {
    const sessionName = muxCtx.sdk.display("#{session_name}", { target: muxCtx.paneId });
    return sessionName || null;
  }

  if (muxCtx.type === "zellij") {
    return muxCtx.sessionName || null;
  }

  return null;
}

function App() {
  const renderer = useRenderer();

  // --- Theme state (driven by server) ---
  const [theme, setTheme] = createSignal<Theme>(resolveTheme(undefined));
  const P = () => theme().palette;
  const S = () => theme().status;

  const [sessions, setSessions] = createStore<SessionData[]>([]);
  const [focusedSession, setFocusedSession] = createSignal<string | null>(null);
  const [currentSession, setCurrentSession] = createSignal<string | null>(null);
  const [mySession, setMySession] = createSignal<string | null>(null);
  const [connected, setConnected] = createSignal(false);
  const [spinIdx, setSpinIdx] = createSignal(0);
  const [detailPanelHeight, setDetailPanelHeight] = createSignal(DEFAULT_DETAIL_PANEL_HEIGHT);
  const [isDetailResizeHover, setIsDetailResizeHover] = createSignal(false);
  const [isDetailResizing, setIsDetailResizing] = createSignal(false);
  const [exposedSites, setExposedSites] = createSignal<ExposedSite[]>([]);
  const [sidebarSpacing, setSidebarSpacing] = createSignal(1);
  const detailPanelSessionName = createMemo(() => focusedSession() ?? mySession());

  // --- Panel focus: sessions list vs agent detail ---
  type PanelFocus = "sessions" | "agents";
  const [panelFocus, setPanelFocus] = createSignal<PanelFocus>("sessions");
  const [focusedAgentIdx, setFocusedAgentIdx] = createSignal(0);

  // --- Modal state ---
  const [modal, setModal] = createSignal<"none" | "spacing-picker" | "theme-picker" | "confirm-kill">("none");
  const [killTarget, setKillTarget] = createSignal<string | null>(null);
  let themeBeforePreview: Theme | null = null;

  const [clientTty, setClientTty] = createSignal(getClientTty());
  let ws: WebSocket | null = null;
  let startupFocusSynced = false;
  let detailResizeStartY = 0;
  let detailResizeStartHeight = DEFAULT_DETAIL_PANEL_HEIGHT;
  const startupSessionName = getLocalSessionName();

  const focusedData = createMemo(() =>
    sessions.find((s) => s.name === focusedSession()) ?? null,
  );

  function send(cmd: ClientCommand) {
    if (connected() && ws) ws.send(JSON.stringify(cmd));
  }

  function switchToSession(name: string) {
    // Optimistic local update — makes rapid Tab repeat instant by removing
    // the server/hook round-trip from the next-Tab decision.
    // The server's focus/state broadcast will reconcile if needed.
    setCurrentSession(name);
    setFocusedSession(name);
    setPanelFocus("sessions");
    setFocusedAgentIdx(0);
    send({ type: "switch-session", name });
  }

  function reIdentify() {
    const sessionName = getLocalSessionName();
    if (!sessionName) return;

    if (muxCtx.type === "tmux") {
      send({ type: "identify-pane", paneId: muxCtx.paneId, sessionName });
    } else if (muxCtx.type === "zellij") {
      send({ type: "identify-pane", paneId: muxCtx.paneId, sessionName });
    }
  }

  function moveLocalFocus(delta: -1 | 1) {
    const list = sessions;
    if (list.length === 0) return;

    const current = focusedSession();
    const currentIdx = Math.max(0, list.findIndex((s) => s.name === current));
    const nextIdx = Math.max(0, Math.min(list.length - 1, currentIdx + delta));
    const next = list[nextIdx]?.name ?? null;

    if (!next || next === current) return;

    setFocusedSession(next);
    send({ type: "focus-session", name: next });
  }

  function moveAgentFocus(delta: -1 | 1) {
    const data = focusedData();
    const agents = data?.agents ?? [];
    if (agents.length === 0) return;
    const idx = focusedAgentIdx();
    const next = Math.max(0, Math.min(agents.length - 1, idx + delta));
    setFocusedAgentIdx(next);
  }

  function activateFocusedAgent() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    appendFileSync("/tmp/opensessions-tui-agent-click.log",
      `[${new Date().toISOString()}] keyboard focus-agent-pane session=${data.name} agent=${agent.agent} threadId=${agent.threadId} threadName=${agent.threadName}\n`);
    send({
      type: "focus-agent-pane",
      session: data.name,
      agent: agent.agent,
      threadId: agent.threadId,
      threadName: agent.threadName,
    });
  }

  function dismissFocusedAgent() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    send({
      type: "dismiss-agent",
      session: data.name,
      agent: agent.agent,
      threadId: agent.threadId,
    });
    // Adjust index if we dismissed the last item
    if (focusedAgentIdx() >= agents.length - 1 && agents.length > 1) {
      setFocusedAgentIdx(agents.length - 2);
    }
    // If no agents left, go back to sessions
    if (agents.length <= 1) setPanelFocus("sessions");
  }

  function killFocusedAgentPane() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    send({
      type: "kill-agent-pane",
      session: data.name,
      agent: agent.agent,
      threadId: agent.threadId,
      threadName: agent.threadName,
    });
  }

  function togglePanelFocus() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    if (panelFocus() === "sessions" && agents.length > 0) {
      setPanelFocus("agents");
      setFocusedAgentIdx((idx) => Math.min(idx, agents.length - 1));
    } else {
      setPanelFocus("sessions");
    }
  }

  function applyTheme(themeName: string) {
    send({ type: "set-theme", theme: themeName });
  }

  function previewTheme(themeName: string) {
    setTheme(resolveTheme(themeName));
  }

  function resizeDetailPanel(delta: -1 | 1) {
    const nextHeight = clampDetailPanelHeight(detailPanelHeight() + delta);
    if (nextHeight === detailPanelHeight()) return;

    setDetailPanelHeight(nextHeight);

    const sessionName = detailPanelSessionName();
    if (sessionName) {
      persistDetailPanelHeight(sessionName, nextHeight);
    }
  }

  function beginDetailResize(event: MouseEvent) {
    logResizeDebug("beginDetailResize", {
      button: event.button,
      x: event.x,
      y: event.y,
      currentHeight: detailPanelHeight(),
      session: detailPanelSessionName(),
      target: event.target?.id ?? null,
    });
    if (event.button !== 0) return;
    (renderer as any).setCapturedRenderable?.(event.target ?? undefined);
    detailResizeStartY = event.y;
    detailResizeStartHeight = detailPanelHeight();
    setIsDetailResizing(true);
    event.stopPropagation();
  }

  function handleDetailResizeDrag(event: MouseEvent) {
    logResizeDebug("handleDetailResizeDrag", {
      x: event.x,
      y: event.y,
      isResizing: isDetailResizing(),
      startY: detailResizeStartY,
      startHeight: detailResizeStartHeight,
      currentHeight: detailPanelHeight(),
      session: detailPanelSessionName(),
    });
    if (!isDetailResizing()) return;
    const delta = detailResizeStartY - event.y;
    const nextHeight = clampDetailPanelHeight(detailResizeStartHeight + delta);
    setDetailPanelHeight(nextHeight);
    logResizeDebug("handleDetailResizeDrag:applied", {
      delta,
      nextHeight,
      session: detailPanelSessionName(),
    });
    event.stopPropagation();
  }

  function endDetailResize(event?: MouseEvent) {
    logResizeDebug("endDetailResize", {
      x: event?.x,
      y: event?.y,
      isResizing: isDetailResizing(),
      currentHeight: detailPanelHeight(),
      session: detailPanelSessionName(),
      target: event?.target?.id ?? null,
    });
    if (!isDetailResizing()) return;
    (renderer as any).setCapturedRenderable?.(undefined);
    setIsDetailResizing(false);
    setIsDetailResizeHover(false);

    const sessionName = detailPanelSessionName();
    if (sessionName) {
      persistDetailPanelHeight(sessionName, detailPanelHeight());
      logResizeDebug("endDetailResize:persisted", {
        session: sessionName,
        height: detailPanelHeight(),
      });
    }

    event?.stopPropagation();
  }

  function createNewSession() {
    if (muxCtx.type !== "tmux") {
      send({ type: "new-session" });
      return;
    }
    const scriptPath = new URL("../scripts/sessionizer.sh", import.meta.url).pathname;
    muxCtx.sdk.displayPopup({
      command: `bash "${scriptPath}"`,
      title: " new session ",
      width: "60%",
      height: "60%",
      closeOnExit: true,
    });
  }

  onMount(() => {
    logResizeDebug("mount", {
      startupSessionName,
      localSessionName: getLocalSessionName(),
      muxType: muxCtx.type,
      tmuxPane: process.env.TMUX_PANE ?? null,
    });
    // Refocus the main pane once terminal capability detection finishes.
    // This avoids the race where start.sh refocuses too early and capability
    // responses leak as garbage text into the main pane.
    let startupRefocused = false;
    const doStartupRefocus = () => {
      if (startupRefocused) return;
      startupRefocused = true;
      refocusMainPane();
    };
    renderer.on("capabilities", doStartupRefocus);
    // Fallback: if no capability response arrives within 2s, refocus anyway
    const refocusTimeout = setTimeout(doStartupRefocus, 2000);

    onCleanup(() => {
      clearTimeout(refocusTimeout);
      renderer.removeListener("capabilities", doStartupRefocus);
    });

    const socket = new WebSocket(`ws://${SERVER_HOST}:${SERVER_PORT}`);
    ws = socket;

    socket.onopen = () => {
      setConnected(true);
      const tty = clientTty();
      if (tty) send({ type: "identify", clientTty: tty });
      reIdentify();

      // Report sidebar width on SIGWINCH (terminal resize / pane drag)
      // Only the TUI in the current session reports — other TUIs' resizes
      // are always enforcement echoes, never user drags.
      let lastReportedWidth = renderer.terminalWidth;
      const onResize = () => {
        const width = renderer.terminalWidth;
        if (width !== lastReportedWidth) {
          lastReportedWidth = width;
          const my = mySession();
          const current = currentSession();
          if (my && current && my !== current) return;
          send({ type: "report-width", width });
        }
      };
      renderer.on("resize", onResize);
      onCleanup(() => renderer.removeListener("resize", onResize));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        let startupFocusToPublish: string | null = null;
        batch(() => {
          if (msg.type === "state") {
            const startupFocus = !startupFocusSynced
              && startupSessionName
              && msg.sessions.some((session) => session.name === startupSessionName)
              ? startupSessionName
              : msg.focusedSession;

            if (startupFocus === startupSessionName) {
              startupFocusSynced = true;
              if (msg.focusedSession !== startupSessionName) {
                startupFocusToPublish = startupSessionName;
              }
            }

            setSessions(reconcile(msg.sessions, { key: "name" }));
            setFocusedSession(startupFocus);
            setCurrentSession(msg.currentSession);
            setTheme(resolveTheme(msg.theme));
            if (msg.exposedSites) setExposedSites(msg.exposedSites);
            if (msg.sidebarSpacing != null) setSidebarSpacing(msg.sidebarSpacing);
          } else if (msg.type === "focus") {
            setFocusedSession(msg.focusedSession);
            setCurrentSession(msg.currentSession);
          } else if (msg.type === "your-session") {
            setMySession(msg.name);
            if (msg.clientTty) setClientTty(msg.clientTty);

            if (!startupFocusSynced && sessions.some((session) => session.name === msg.name)) {
              startupFocusSynced = true;
              setFocusedSession(msg.name);
              if (focusedSession() !== msg.name) {
                startupFocusToPublish = msg.name;
              }
            }
          } else if (msg.type === "re-identify") {
            reIdentify();
          }
        });

        if (startupFocusToPublish) {
          send({ type: "focus-session", name: startupFocusToPublish });
        }
      } catch (err) {
        appendFileSync("/tmp/opensessions-tui-msg-error.log",
          `[${new Date().toISOString()}] ${err}\n${(err as Error).stack ?? ""}\n`);
      }
    };

    socket.onclose = () => {
      setConnected(false);
      renderer.destroy();
    };

    onCleanup(() => socket.close());

    // Listen for quit messages from server
    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "quit") {
          if (ws) ws.close();
          renderer.destroy();
        }
      } catch {}
    });
  });

  const hasRunning = createMemo(() =>
    sessions.some((s) => s.agentState?.status === "running"),
  );

  createEffect(() => {
    if (!hasRunning()) return;
    const interval = setInterval(() => {
      setSpinIdx((i) => (i + 1) % SPINNERS.length);
    }, 120);
    onCleanup(() => clearInterval(interval));
  });

  createEffect(() => {
    const sessionName = detailPanelSessionName();
    if (!sessionName) return;
    const storedHeight = getStoredDetailPanelHeight(sessionName);
    logResizeDebug("loadStoredDetailPanelHeight", {
      session: sessionName,
      storedHeight,
    });
    setDetailPanelHeight(storedHeight);
  });

  createEffect(() => {
    logResizeDebug("detailPanelHeight:changed", {
      height: detailPanelHeight(),
      session: detailPanelSessionName(),
      isResizing: isDetailResizing(),
    });
  });

  useKeyboard((key) => {
    const currentModal = modal();

    // --- Theme picker modal: input handles all keys via onKeyDown ---
    if (currentModal === "theme-picker") {
      return;
    }

    // --- Spacing picker modal ---
    if (currentModal === "spacing-picker") {
      if (key.name === "escape") {
        setModal("none");
      } else if (key.name === "1" || key.name === "0" || key.name === "2") {
        const val = parseInt(key.name, 10);
        setSidebarSpacing(val);
        saveConfig({ sidebarSpacing: val });
        setModal("none");
      }
      return;
    }

    // --- Confirm kill modal ---
    if (currentModal === "confirm-kill") {
      if (key.name === "y") {
        const target = killTarget();
        if (target) send({ type: "kill-session", name: target });
        setKillTarget(null);
        setModal("none");
      } else {
        setKillTarget(null);
        setModal("none");
      }
      return;
    }

    // --- Normal mode keybindings ---
    // Alt+Up / Alt+Down → reorder session
    if ((key.meta || key.option) && (key.name === "up" || key.name === "down")) {
      const focused = focusedSession();
      if (focused) {
        const delta: -1 | 1 = key.name === "up" ? -1 : 1;
        send({ type: "reorder-session", name: focused, delta });
      }
      return;
    }

    switch (key.name) {
      case "q":
        send({ type: "quit" });
        break;
      case "escape":
        if (panelFocus() === "agents") {
          setPanelFocus("sessions");
        }
        break;
      case "up":
      case "k":
        if (panelFocus() === "agents") {
          moveAgentFocus(-1);
        } else {
          moveLocalFocus(-1);
        }
        break;
      case "down":
      case "j":
        if (panelFocus() === "agents") {
          moveAgentFocus(1);
        } else {
          moveLocalFocus(1);
        }
        break;
      case "left":
      case "h":
        if (panelFocus() === "agents") {
          setPanelFocus("sessions");
        } else {
          resizeDetailPanel(-1);
        }
        break;
      case "right":
      case "l":
        if (panelFocus() === "sessions") {
          const data = focusedData();
          const agents = data?.agents ?? [];
          if (agents.length > 0) {
            setPanelFocus("agents");
            setFocusedAgentIdx((idx) => Math.min(idx, agents.length - 1));
          } else {
            resizeDetailPanel(1);
          }
        }
        break;
      case "return": {
        if (panelFocus() === "agents") {
          activateFocusedAgent();
        } else {
          const focused = focusedSession();
          if (focused) switchToSession(focused);
        }
        break;
      }
      case "tab": {
        const list = sessions;
        if (list.length === 0) break;
        const cur = currentSession();
        const idx = list.findIndex((s) => s.name === cur);
        const next = list[(idx + (key.shift ? list.length - 1 : 1)) % list.length];
        if (next) switchToSession(next.name);
        break;
      }
      case "r":
        send({ type: "refresh" });
        break;
      case "t":
        themeBeforePreview = theme();
        setModal("theme-picker");
        break;
      case "u":
        send({ type: "show-all-sessions" });
        break;
      case "d": {
        if (panelFocus() === "agents") {
          dismissFocusedAgent();
        } else {
          const focused = focusedSession();
          if (focused) send({ type: "hide-session", name: focused });
        }
        break;
      }
      case "x": {
        if (panelFocus() === "agents") {
          killFocusedAgentPane();
        } else {
          const focused = focusedSession();
          if (focused) {
            setKillTarget(focused);
            setModal("confirm-kill");
          }
        }
        break;
      }
      case "n":
      case "c":
        createNewSession();
        break;
      default: {
        if (key.number) {
          const idx = parseInt(key.name, 10) - 1;
          const target = sessions[idx];
          if (target) switchToSession(target.name);
        }
        break;
      }
    }
  });

  const runningCount = createMemo(() =>
    sessions.filter((s) => s.agentState?.status === "running").length,
  );

  const errorCount = createMemo(() =>
    sessions.filter((s) => s.agentState?.status === "error").length,
  );

  const unseenCount = createMemo(() =>
    sessions.filter((s) => s.unseen).length,
  );

  const isFocused = createSelector(focusedSession);

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={P().crust}>
      {/* Session list — the entire sidebar */}
      <scrollbox flexGrow={1} flexShrink={1} paddingTop={1}>
        <For each={sessions}>
          {(session, i) => (
            <SessionCard
              session={session}
              isFocused={isFocused(session.name)}
              isCurrent={session.name === currentSession()}
              spinIdx={spinIdx}
              theme={theme}
              spacing={sidebarSpacing}
              onSelect={() => {
                setFocusedSession(session.name);
                send({ type: "focus-session", name: session.name });
                switchToSession(session.name);
              }}
              onFocusPane={(paneId) => {
                send({ type: "focus-pane", paneId });
              }}
              onFocusExposedPane={(port) => {
                send({ type: "focus-exposed-pane", port });
              }}
              onSelectWindow={(windowId) => {
                send({ type: "select-window", session: session.name, windowId });
              }}
            />
          )}
        </For>
      </scrollbox>

      {/* Settings button — pinned to bottom */}
      <box flexShrink={0} paddingLeft={2} paddingBottom={1} paddingTop={0}>
        <box height={1}>
          <text style={{ fg: P().surface2 }}>{"─".repeat(200)}</text>
        </box>
        <box flexDirection="row">
          <text
            onMouseDown={() => {
              themeBeforePreview = theme();
              setModal("theme-picker");
            }}
          >
            <span style={{ fg: P().overlay0, attributes: DIM }}>{"  theme"}</span>
          </text>
          <text>
            <span style={{ fg: P().surface2 }}>{" · "}</span>
          </text>
          <text
            onMouseDown={() => setModal("spacing-picker")}
          >
            <span style={{ fg: P().overlay0, attributes: DIM }}>{"spacing"}</span>
          </text>
        </box>
      </box>

      {/* Theme picker overlay */}
      <Show when={modal() === "theme-picker"}>
        <ThemePicker
          palette={P}
          onSelect={(name) => {
            themeBeforePreview = null;
            applyTheme(name);
            setModal("none");
          }}
          onPreview={(name) => {
            previewTheme(name);
          }}
          onClose={() => {
            if (themeBeforePreview) {
              setTheme(themeBeforePreview);
              themeBeforePreview = null;
            }
            setModal("none");
          }}
        />
      </Show>

      {/* Spacing picker overlay */}
      <Show when={modal() === "spacing-picker"}>
        <box
          position="absolute"
          top={0} left={0} right={0} bottom={0}
          justifyContent="center"
          alignItems="center"
          backgroundColor="transparent"
        >
          <box
            border
            borderStyle="rounded"
            borderColor={P().blue}
            backgroundColor={P().mantle}
            padding={1}
            flexDirection="column"
            width={24}
          >
            <text>
              <span style={{ fg: P().blue, attributes: BOLD }}>Spacing</span>
            </text>
            <box height={1}><text style={{ fg: P().surface2 }}>{"─".repeat(200)}</text></box>
            <For each={[0, 1, 2]}>
              {(val) => {
                const label = () => val === 0 ? "tight" : val === 1 ? "relaxed" : "roomy";
                const isSel = () => sidebarSpacing() === val;
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={isSel() ? P().surface0 : undefined}
                    onMouseDown={() => {
                      setSidebarSpacing(val);
                      send({ type: "set-theme", theme: "" });
                      saveConfig({ sidebarSpacing: val });
                      setModal("none");
                    }}
                  >
                    <text style={{ fg: isSel() ? P().text : P().subtext0 }}>
                      <span>{isSel() ? "▸ " : "  "}</span>
                      <span>{label()}</span>
                      <span style={{ fg: P().overlay0, attributes: DIM }}>{" "}{String(val)}</span>
                    </text>
                  </box>
                );
              }}
            </For>
            <box height={1}><text style={{ fg: P().surface2 }}>{"─".repeat(200)}</text></box>
            <text style={{ fg: P().overlay0 }}>
              <span style={{ attributes: DIM }}>click</span>{" select  "}
              <span style={{ attributes: DIM }}>esc</span>{" close"}
            </text>
          </box>
        </box>
      </Show>

      {/* Kill confirmation overlay */}
      <Show when={modal() === "confirm-kill"}>
        <box
          position="absolute"
          top={0} left={0} right={0} bottom={0}
          justifyContent="center"
          alignItems="center"
          backgroundColor="transparent"
        >
          <box
            border
            borderStyle="rounded"
            borderColor={P().red}
            backgroundColor={P().mantle}
            padding={1}
            paddingX={2}
            flexDirection="column"
            alignItems="center"
          >
            <text>
              <span style={{ fg: P().red, attributes: BOLD }}>Kill session?</span>
            </text>
            <text>
              <span style={{ fg: P().text }}>{killTarget() ?? ""}</span>
            </text>
            <text>
              <span style={{ fg: P().overlay0 }}>y</span>
              <span style={{ fg: P().overlay1 }}>/</span>
              <span style={{ fg: P().overlay0 }}>n</span>
            </text>
          </box>
        </box>
      </Show>
    </box>
  );
}

// --- Theme Picker ---

interface ThemePickerProps {
  palette: Accessor<Theme["palette"]>;
  onSelect: (name: string) => void;
  onPreview: (name: string) => void;
  onClose: () => void;
}

function ThemePicker(props: ThemePickerProps) {
  let inputRef: InputRenderable;

  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);

  const filtered = createMemo(() => {
    const q = query().toLowerCase();
    if (!q) return THEME_NAMES;
    return THEME_NAMES.filter((name) => name.toLowerCase().includes(q));
  });

  function move(direction: -1 | 1) {
    const list = filtered();
    if (!list.length) return;
    let next = selected() + direction;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    setSelected(next);
    const name = list[next];
    if (name) props.onPreview(name);
  }

  function confirm() {
    const name = filtered()[selected()];
    if (name) props.onSelect(name);
  }

  function handleKeyDown(e: KeyEvent) {
    if (e.name === "up") {
      e.preventDefault();
      move(-1);
    } else if (e.name === "down") {
      e.preventDefault();
      move(1);
    } else if (e.name === "return") {
      e.preventDefault();
      confirm();
    } else if (e.name === "escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  function handleInput(value: string) {
    setQuery(value);
    setSelected(0);
  }

  const MAX_VISIBLE = 12;

  const scrollOffset = createMemo(() => {
    const sel = selected();
    if (sel < MAX_VISIBLE) return 0;
    return sel - MAX_VISIBLE + 1;
  });

  const visibleItems = createMemo(() => {
    const list = filtered();
    return list.slice(scrollOffset(), scrollOffset() + MAX_VISIBLE);
  });

  return (
    <box
      position="absolute"
      top={0} left={0} right={0} bottom={0}
      justifyContent="center"
      alignItems="center"
      backgroundColor="transparent"
    >
      <box
        border
        borderStyle="rounded"
        borderColor={props.palette().blue}
        backgroundColor={props.palette().mantle}
        padding={1}
        flexDirection="column"
        width={30}
      >
        <text>
          <span style={{ fg: props.palette().blue, attributes: BOLD }}>Select Theme</span>
        </text>
        <box height={1}><text style={{ fg: props.palette().surface2 }}>{"─".repeat(200)}</text></box>
        <box border borderColor={props.palette().surface1} marginBottom={1}>
          <input
            ref={(r: InputRenderable) => { inputRef = r; inputRef.focus(); }}
            value={query()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Search themes…"
            backgroundColor={props.palette().surface0}
            focusedBackgroundColor={props.palette().surface0}
            textColor={props.palette().text}
            cursorColor={props.palette().blue}
            placeholderColor={props.palette().overlay0}
          />
        </box>
        <Show when={filtered().length > 0} fallback={
          <box paddingLeft={1}><text style={{ fg: props.palette().overlay0 }}>No matches</text></box>
        }>
          <For each={visibleItems()}>
            {(name) => {
              const idx = createMemo(() => filtered().indexOf(name));
              const isSel = createMemo(() => idx() === selected());
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isSel() ? props.palette().surface0 : undefined}
                >
                  <text style={{ fg: isSel() ? props.palette().text : props.palette().subtext0 }}>
                    {isSel() ? "▸ " : "  "}{name}
                  </text>
                </box>
              );
            }}
          </For>
          <Show when={filtered().length > MAX_VISIBLE}>
            <text style={{ fg: props.palette().overlay0, attributes: DIM }}>
              {"  "}↕ {filtered().length - MAX_VISIBLE} more
            </text>
          </Show>
        </Show>
        <box height={1}><text style={{ fg: props.palette().surface2 }}>{"─".repeat(200)}</text></box>
        <text style={{ fg: props.palette().overlay0 }}>
          <span style={{ attributes: DIM }}>↑↓</span>{" browse  "}
          <span style={{ attributes: DIM }}>⏎</span>{" select  "}
          <span style={{ attributes: DIM }}>esc</span>{" close"}
        </text>
      </box>
    </box>
  );
}

// --- Sparkline ---

function buildSparkline(timestamps: number[], width: number, windowMs: number = 30 * 60 * 1000): string {
  if (timestamps.length === 0 || width <= 0) return "";
  const now = Date.now();
  const start = now - windowMs;
  const bucketSize = windowMs / width;
  const buckets = new Array(width).fill(0);

  for (const ts of timestamps) {
    if (ts < start) continue;
    const idx = Math.min(width - 1, Math.floor((ts - start) / bucketSize));
    buckets[idx]++;
  }

  const max = Math.max(...buckets, 1);
  return buckets.map((count: number) => {
    const level = Math.round((count / max) * (SPARK_BLOCKS.length - 1));
    return SPARK_BLOCKS[level];
  }).join("");
}

// --- Detail Panel ---


// --- Session Card (D2 window-based layout) ---

interface SessionCardProps {
  session: SessionData;
  isFocused: boolean;
  isCurrent: boolean;
  spinIdx: Accessor<number>;
  theme: Accessor<Theme>;
  spacing: Accessor<number>;
  onSelect: () => void;
  onFocusPane: (paneId: string) => void;
  onFocusExposedPane: (port: number) => void;
  onSelectWindow: (windowId: string) => void;
}

function SessionCard(props: SessionCardProps) {
  const P = () => props.theme().palette;

  const status = () => props.session.agentState?.status ?? "idle";
  const unseen = () => props.session.unseen;

  const isUnseenTerminal = () =>
    unseen() && ["done", "error", "interrupted"].includes(status());

  const accentColor = () => {
    if (props.isCurrent) return P().green;
    if (isUnseenTerminal()) {
      const s = status();
      if (s === "error") return P().red;
      if (s === "interrupted") return P().peach;
      return P().teal;
    }
    const s = status();
    if (s === "error") return P().red;
    if (s === "interrupted") return P().peach;
    if (s === "running") return P().yellow;
    if (props.isFocused) return P().lavender;
    return "transparent";
  };

  const accentChar = () => {
    if (unseen() && !props.isFocused) return "●";
    if (accentColor() === "transparent") return " ";
    return "▌";
  };

  const statusDot = () => {
    const s = status();
    if (s === "running") return SPINNERS[props.spinIdx() % SPINNERS.length]!;
    if (["done", "error", "interrupted"].includes(s)) return "●";
    return "";
  };

  const statusDotColor = () => {
    const s = status();
    if (s === "running") return P().yellow;
    if (s === "done") return P().green;
    if (s === "error") return P().red;
    if (s === "interrupted") return P().peach;
    return P().surface2;
  };

  const nameColor = () => {
    if (props.isFocused) return P().text;
    if (props.isCurrent) return P().subtext1;
    return P().subtext0;
  };

  const truncName = () => {
    const n = props.session.name;
    return n.length > 20 ? n.slice(0, 19) + "…" : n;
  };

  const collapsedInfo = () => {
    const d = props.session.dir;
    if (!d) return "";
    const parts = d.replace(/\/+$/, "").split("/");
    const folder = parts[parts.length - 1] || "";
    const b = props.session.branch;
    if (b) return `${folder} · ${b.length > 14 ? b.slice(0, 13) + "…" : b}`;
    return folder;
  };

  const windowData = () => props.session.windowData ?? [];

  // Pane rendering helpers
  const paneDot = (pane: PaneData) => {
    if (pane.type === "agent" && pane.agentStatus === "running")
      return SPINNERS[props.spinIdx() % SPINNERS.length]!;
    if (pane.type === "dev") return "●";
    if (pane.type === "agent") return "●";
    return "○";
  };

  const paneDotColor = (pane: PaneData) => {
    if (pane.type === "agent") {
      const s = pane.agentStatus;
      if (s === "running") return P().yellow;
      if (s === "done") return P().green;
      if (s === "error") return P().red;
      if (s === "interrupted") return P().peach;
      if (s === "waiting") return P().blue;
      if (pane.agentUnseen) return P().teal;
      return P().surface2;
    }
    if (pane.type === "dev") {
      if (pane.exposedSite?.healthy === true) return P().green;
      if (pane.exposedSite?.healthy === false) return P().red;
      return P().sky;
    }
    return P().surface2;
  };

  const paneLabel = (pane: PaneData) => {
    if (pane.type === "dev" && pane.exposedSite) {
      const d = pane.exposedSite.domain;
      const domain = d.length > 18 ? d.slice(0, 17) + "…" : d;
      return `:${pane.port} ${domain}`;
    }
    if (pane.type === "dev" && pane.port) {
      return `⌁ ${pane.port}`;
    }
    const t = pane.title;
    if (t && t !== pane.command) {
      return t.length > 22 ? t.slice(0, 21) + "…" : t;
    }
    return pane.command || "shell";
  };

  const paneLabelColor = (pane: PaneData) => {
    if (pane.type === "dev") return P().blue;
    if (pane.type === "agent") return P().subtext0;
    return P().overlay0;
  };

  return (
    <box flexDirection="column" flexShrink={0}>
      {/* Session header */}
      <box flexDirection="row" onMouseDown={props.onSelect} paddingLeft={1}>
        <text style={{ fg: accentColor() }}>{accentChar()}</text>
        <text truncate flexGrow={1}>
          <span style={{ fg: nameColor(), attributes: props.isFocused || props.isCurrent ? BOLD : undefined }}>
            {" "}{truncName()}
          </span>
        </text>
        <Show when={statusDot()}>
          <text flexShrink={0}>
            <span style={{ fg: statusDotColor() }}>{statusDot()}{" "}</span>
          </text>
        </Show>
      </box>

      {/* Collapsed: folder · branch */}
      <Show when={!props.isFocused && collapsedInfo()}>
        <box paddingLeft={3}>
          <text truncate>
            <span style={{ fg: P().overlay0, attributes: DIM }}>{collapsedInfo()}</span>
          </text>
        </box>
      </Show>

      {/* Expanded: window/pane tree */}
      <Show when={props.isFocused && windowData().length > 0}>
        <box flexDirection="column" paddingLeft={3}>
          <For each={windowData()}>
            {(win, wi) => {
              const sp = () => props.spacing();
              return (
                <box flexDirection="column" flexShrink={0}>
                  {/* Space before window: spacing-based for first, 1 line for rest */}
                  <Show when={wi() > 0 || sp() > 0}>
                    <box height={wi() === 0 ? sp() : 1} />
                  </Show>

                  {/* Window header: index badge + name (click to switch) */}
                  <box flexDirection="row"
                    onMouseDown={() => props.onSelectWindow(win.id)}
                  >
                    <text flexShrink={0}>
                      <span style={{
                        fg: win.active ? P().crust : P().overlay0,
                        bg: win.active ? P().green : P().surface2,
                        attributes: BOLD,
                      }}>{" "}{String(win.index)}{" "}</span>
                    </text>
                    <text truncate>
                      <span style={{ fg: win.active ? P().subtext1 : P().overlay0 }}>
                        {" "}{win.name}
                      </span>
                    </text>
                  </box>

                  {/* Panes under this window */}
                  <For each={win.panes}>
                    {(pane, pi) => {
                      const isLastPane = () => pi() === win.panes.length - 1;
                      const prefix = () => isLastPane() ? "└ " : "├ ";
                      return (
                        <box flexDirection="column" flexShrink={0}>
                          {/* │ gutter spacer before each pane */}
                          <Show when={sp() > 0}>
                            <For each={Array.from({ length: sp() })}>
                              {() => (
                                <text><span style={{ fg: P().surface2 }}>{"│"}</span></text>
                              )}
                            </For>
                          </Show>

                          {/* Pane row */}
                          <box flexDirection="row"
                            onMouseDown={() => {
                              if (pane.type === "dev" && pane.exposedSite) {
                                props.onFocusExposedPane(pane.exposedSite.port);
                              } else {
                                props.onFocusPane(pane.id);
                              }
                            }}
                          >
                            <text truncate>
                              <span style={{ fg: P().surface2 }}>{prefix()}</span>
                              <span style={{ fg: paneDotColor(pane) }}>{paneDot(pane)}</span>
                              <span style={{ fg: paneLabelColor(pane) }}>{" "}{paneLabel(pane)}</span>
                            </text>
                          </box>
                        </box>
                      );
                    }}
                  </For>
                </box>
              );
            }}
          </For>
        </box>
      </Show>

      {/* Breathing room between sessions */}
      <box height={1} />
    </box>
  );
}

async function main() {
  await ensureServer();
  render(() => <App />, {
    exitOnCtrlC: true,
    targetFPS: 30,
    useMouse: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
