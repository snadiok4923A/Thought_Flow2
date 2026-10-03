import React, { useState } from "react";
import { Sparkles, ArrowRight, ChevronDown, LocateFixed, Settings, Check } from "lucide-react";
import { getCaptureConfig, saveCaptureConfig } from "../utils/aiCapture";

/**
 * AI Chat Capture panel (bottom-left). Controls the shared capture session:
 * ON/OFF, start node (from the current selection), direction, connection state,
 * supported platforms and captured-conversation counter.
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
  const [cfg, setCfg] = useState(() => getCaptureConfig());

  const saveCfg = () => {
    // Saved config is picked up by the next poll (≤ 2.5 s).
    saveCaptureConfig({ apiBase: cfg.apiBase.trim(), token: cfg.token.trim() });
    setSettingsOpen(false);
  };

  const row = "flex items-center justify-between py-1.5";

  return (
    <div className="fixed bottom-6 left-6 z-[9998] w-72 select-none pointer-events-auto">
      <div className="bg-zinc-900/95 border border-zinc-700/80 backdrop-blur-2xl rounded-2xl p-3.5 ring-1 ring-purple-500/30 shadow-[0_15px_40px_rgba(0,0,0,0.65)]">
        {/* Header */}
        <div className="flex items-center justify-between pb-2 mb-1.5 border-b border-zinc-800/80">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="font-semibold text-zinc-100 tracking-wide">AI Chat Capture</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
              title="Capture API settings"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onToggle && onToggle(!enabled)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
                enabled
                  ? "bg-purple-600 hover:bg-purple-500 text-white border-purple-500 shadow shadow-purple-900/40"
                  : "bg-zinc-950 text-zinc-400 hover:text-white border-zinc-700"
              }`}
              title={enabled ? "Turn AI Capture OFF" : "Turn AI Capture ON"}
            >
              {enabled ? "ON" : "OFF"}
            </button>
          </div>
        </div>

        {/* Status */}
        <div className={row}>
          <span className="text-xs text-zinc-400 font-medium">Status</span>
          <span className="flex items-center gap-1.5 text-xs text-zinc-200">
            <span
              className={`w-2 h-2 rounded-full ${
                enabled ? "bg-green-500 shadow shadow-green-500/60" : "bg-zinc-600"
              }`}
            />
            {enabled ? "ON" : "OFF"}
          </span>
        </div>

        {/* Connected */}
        <div className={row}>
          <span className="text-xs text-zinc-400 font-medium">Connected</span>
          <span className="flex items-center gap-1.5 text-xs text-zinc-200">
            <span
              className={`w-2 h-2 rounded-full ${
                connected ? "bg-green-500 shadow shadow-green-500/60" : "bg-red-500 shadow shadow-red-500/60"
              }`}
            />
            {connected ? "Yes" : "No"}
          </span>
        </div>

        {/* Start Node */}
        <div className={row}>
          <span className="text-xs text-zinc-400 font-medium shrink-0">Start Node</span>
          <span className="flex items-center gap-1.5 min-w-0">
            <span
              className="text-xs text-purple-200 font-mono truncate max-w-[130px]"
              title={startNodeText || "No start node selected"}
            >
              {startNodeText || "—"}
            </span>
            <button
              type="button"
              onClick={onUseSelected}
              className="p-1 rounded text-zinc-400 hover:text-purple-300 hover:bg-purple-500/15 transition-colors cursor-pointer"
              title="Use the currently selected node as the AI Capture start node"
            >
              <LocateFixed className="w-3.5 h-3.5" />
            </button>
          </span>
        </div>

        {/* Direction */}
        <div className={row}>
          <span className="text-xs text-zinc-400 font-medium">Direction</span>
          <div className="flex items-center space-x-1 bg-zinc-950 p-0.5 rounded-lg border border-zinc-800 text-[11px]">
            <button
              type="button"
              onClick={() => onDirection && onDirection("right")}
              className={`px-2 py-0.5 rounded flex items-center space-x-1 transition-all cursor-pointer ${
                direction === "right" ? "bg-purple-600 text-white shadow font-medium" : "text-zinc-400 hover:text-white"
              }`}
              title="New AI nodes appear to the right (→)"
            >
              <ArrowRight size={12} />
              <span>Right</span>
            </button>
            <button
              type="button"
              onClick={() => onDirection && onDirection("below")}
              className={`px-2 py-0.5 rounded flex items-center space-x-1 transition-all cursor-pointer ${
                direction === "below" ? "bg-purple-600 text-white shadow font-medium" : "text-zinc-400 hover:text-white"
              }`}
              title="New AI nodes appear below (↓)"
            >
              <ChevronDown size={12} />
              <span>Below</span>
            </button>
          </div>
        </div>

        {/* Supported */}
        <div className={row}>
          <span className="text-xs text-zinc-400 font-medium">Supported</span>
          <span className="flex items-center gap-2 text-xs text-zinc-300">
            <span className="flex items-center gap-1">
              <Check className="w-3 h-3 text-green-400" /> ChatGPT
            </span>
            <span className="flex items-center gap-1">
              <Check className="w-3 h-3 text-green-400" /> Gemini
            </span>
          </span>
        </div>

        {/* Captured */}
        <div className={row}>
          <span className="text-xs text-zinc-400 font-medium">Captured</span>
          <span className="text-xs text-purple-200 font-mono">
            {captured} conversation{captured === 1 ? "" : "s"}
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
  );
}
