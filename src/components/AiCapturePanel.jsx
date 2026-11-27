import React, { useState } from "react";
import {
  Sparkles,
  ArrowRight,
  ChevronDown,
  LocateFixed,
  Settings,
  Check,
  Minimize2,
} from "lucide-react";
import { getCaptureConfig, saveCaptureConfig } from "../utils/aiCapture";

/**
 * AI Chat Capture panel (bottom-left). Controls the shared capture session:
 * ON/OFF, start node (from the current selection), direction, connection state,
 * supported platforms and captured-conversation counter.
 *
 * UI only: the panel can collapse into a small circular floating button and
 * expand again. All capture state and callbacks are owned by the parent.
 */
export default function AiCapturePanel({
  enabled = false,
  connected = false,
  direction = "right",
  startNodeText = "",
  captured = 0,
  message = "",
  onToggle,
  onDirection,
  onUseSelected,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [cfg, setCfg] = useState(() => getCaptureConfig());

  const saveCfg = () => {
    // Saved config is picked up by the next poll (≤ 2.5 s).
    saveCaptureConfig({ apiBase: cfg.apiBase.trim(), token: cfg.token.trim() });
    setSettingsOpen(false);
  };

  return (
    <div className="fixed bottom-4 left-4 z-[9998] select-none pointer-events-auto">
      {isMinimized ? (
        /* Minimized: futuristic circular trigger, still bottom-left anchored. */
        <button
          type="button"
          onClick={() => setIsMinimized(false)}
          aria-label="Open AI Chat Capture"
          title="Open AI Chat Capture"
          className="group relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 via-purple-600 to-indigo-600 text-white ring-1 ring-white/25 shadow-[0_0_18px_rgba(168,85,247,0.55),0_8px_22px_rgba(0,0,0,0.55)] transition-all duration-200 ease-out hover:scale-105 hover:shadow-[0_0_26px_rgba(192,132,252,0.75),0_10px_26px_rgba(0,0,0,0.6)] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-200"
        >
          <span className="pointer-events-none absolute inset-0 rounded-full bg-purple-500/40 blur-md transition-opacity duration-200 group-hover:opacity-90" />
          <span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-tr from-transparent via-white/20 to-transparent opacity-70" />
          <Sparkles className="relative h-5 w-5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]" />
          <span
            className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-900 ${
              enabled ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"
            }`}
          />
        </button>
      ) : (
        /* Expanded: compact rectangular panel (unchanged behaviour). */
        <div className="w-[252px] max-w-[calc(100vw-32px)] transition-all duration-200 ease-out">
          <div className="rounded-xl border border-purple-500/25 bg-zinc-900/95 px-3 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            {/* Compact header: capture state is visible in the toggle, so no duplicate Status row. */}
            <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] pb-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-purple-400" />
                <span className="truncate text-[12px] font-semibold tracking-tight text-zinc-100">
                  AI Chat Capture
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((v) => !v)}
                  aria-label="Capture settings"
                  aria-expanded={settingsOpen}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                  title="Capture API settings"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onToggle?.(!enabled)}
                  aria-label={enabled ? "Turn AI Capture off" : "Turn AI Capture on"}
                  aria-pressed={enabled}
                  className={`min-w-[35px] rounded-md border px-1.5 py-1 text-[10px] font-bold leading-none transition-colors ${
                    enabled
                      ? "border-purple-500/70 bg-purple-600 text-white hover:bg-purple-500"
                      : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-white"
                  }`}
                  title={enabled ? "Turn AI Capture OFF" : "Turn AI Capture ON"}
                >
                  {enabled ? "ON" : "OFF"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSettingsOpen(false);
                    setIsMinimized(true);
                  }}
                  aria-label="Minimize AI Chat Capture"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-purple-500/15 hover:text-purple-300"
                  title="Minimize AI Chat Capture"
                >
                  <Minimize2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Connected status */}
            <div className="flex min-h-[25px] items-center justify-between gap-2 text-[11px]">
              <span className="font-medium text-zinc-400">Connection</span>
              <span className="inline-flex items-center gap-1.5 text-zinc-200">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    connected ? "bg-emerald-400" : "bg-red-400"
                  }`}
                />
                {connected ? "Connected" : "Offline"}
              </span>
            </div>

            {/* Start node */}
            <div className="flex min-h-[25px] items-center justify-between gap-2 text-[11px]">
              <span className="shrink-0 font-medium text-zinc-400">Start node</span>
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className="max-w-[110px] truncate font-mono text-purple-200"
                  title={startNodeText || "No start node selected"}
                >
                  {startNodeText || "—"}
                </span>
                <button
                  type="button"
                  onClick={onUseSelected}
                  aria-label="Use selected node as capture start node"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-purple-500/15 hover:text-purple-300"
                  title="Use the currently selected node as the AI Capture start node"
                >
                  <LocateFixed className="h-3 w-3" />
                </button>
              </span>
            </div>

            {/* Direction */}
            <div className="flex min-h-[29px] items-center justify-between gap-2 text-[11px]">
              <span className="font-medium text-zinc-400">Direction</span>
              <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
                <button
                  type="button"
                  onClick={() => onDirection?.("right")}
                  aria-pressed={direction === "right"}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    direction === "right"
                      ? "bg-purple-600 font-medium text-white"
                      : "text-zinc-400 hover:text-white"
                  }`}
                  title="New AI nodes appear to the right (→)"
                >
                  <ArrowRight size={11} />
                  Right
                </button>
                <button
                  type="button"
                  onClick={() => onDirection?.("below")}
                  aria-pressed={direction === "below"}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    direction === "below"
                      ? "bg-purple-600 font-medium text-white"
                      : "text-zinc-400 hover:text-white"
                  }`}
                  title="New AI nodes appear below (↓)"
                >
                  <ChevronDown size={11} />
                  Below
                </button>
              </div>
            </div>

            {/* Compact summary: full supported list is available on hover. */}
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-2 text-[10px]">
              <span
                className="flex min-w-0 items-center gap-1 truncate text-zinc-400"
                title="Auto-capture: ChatGPT, Gemini, Arena, Grok, Claude, DeepSeek, Perplexity, Copilot, Poe, You.com, DuckDuckGo, Meta AI, Mistral, Qwen, Kimi, Felo, Z.ai, MiniMax. Other sites: extension popup → Quick add."
              >
                <Check className="h-3 w-3 shrink-0 text-emerald-400" />
                <span className="truncate">ChatGPT · Gemini +18</span>
              </span>
              <span
                className="shrink-0 whitespace-nowrap font-mono tabular-nums text-purple-200"
                title={`${captured} captured conversation${captured === 1 ? "" : "s"}`}
              >
                {captured} captured
              </span>
            </div>

            {/* Message (e.g. "Select a node to start AI Capture.") */}
            {message && (
              <div className="mt-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
                {message}
              </div>
            )}

            {/* API settings */}
            {settingsOpen && (
              <div className="mt-2 pt-2 border-t border-zinc-800/80 space-y-1.5">
                <label className="block text-[10px] text-zinc-500">API base URL</label>
                <input
                  type="text"
                  value={cfg.apiBase}
                  onChange={(e) => setCfg((c) => ({ ...c, apiBase: e.target.value }))}
                  spellCheck={false}
                  className="w-full bg-black/60 border border-zinc-700 text-white rounded-lg px-2 py-1.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <label className="block text-[10px] text-zinc-500">Capture token</label>
                <input
                  type="password"
                  value={cfg.token}
                  onChange={(e) => setCfg((c) => ({ ...c, token: e.target.value }))}
                  spellCheck={false}
                  className="w-full bg-black/60 border border-zinc-700 text-white rounded-lg px-2 py-1.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <button
                  type="button"
                  onClick={saveCfg}
                  className="w-full py-1.5 rounded-lg text-[11px] font-semibold bg-purple-600 hover:bg-purple-500 text-white transition-colors cursor-pointer"
                >
                  Save
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
