"use client";

// Everything around the orb: parcel card, captions, transcript, mic control,
// typed-question input, connection/capability badges.

import { useEffect, useRef, useState } from "react";
import { useHvi, hydrateTurns } from "@/lib/store";
import { voice } from "@/lib/voice";
import { orbBus } from "@/lib/orbBus";
import { pushSupported, pushEnabled, enablePush, disablePush } from "@/lib/push";

function money(n: number | null): string {
  if (n == null) return "—";
  return "$" + Math.round(n).toLocaleString();
}

export default function HUD() {
  const {
    connected, caps, orbState, transcript, caption, visual, chips, micArmed, freeCam, error,
    turns, showTranscript, toggleTranscript, activity, digest, dismissDigest,
  } = useHvi();
  const [typed, setTyped] = useState("");
  const railRef = useRef<HTMLElement>(null);
  // null = unsupported/undetermined (button hidden), otherwise current state.
  const [alerts, setAlerts] = useState<boolean | null>(null);
  const [alertsBusy, setAlertsBusy] = useState(false);

  useEffect(() => hydrateTurns(), []);

  useEffect(() => {
    if (!pushSupported()) return;
    void pushEnabled().then(setAlerts);
  }, []);

  const toggleAlerts = async () => {
    if (alertsBusy || alerts == null) return;
    setAlertsBusy(true);
    try {
      if (alerts) {
        await disablePush();
        setAlerts(false);
      } else {
        const err = await enablePush();
        if (err) useHvi.getState().setError(err);
        else setAlerts(true);
      }
    } finally {
      setAlertsBusy(false);
    }
  };

  // Keep the transcript rail pinned to the newest turn.
  useEffect(() => {
    if (railRef.current) railRef.current.scrollTop = railRef.current.scrollHeight;
  }, [turns, showTranscript]);

  const submitTyped = () => {
    const t = typed.trim();
    if (!t) return;
    setTyped("");
    voice.sendText(t);
  };

  return (
    <div className="hud">
      {/* Top bar */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">HVI</span>
          <span className="brand-sub">Houston Voice Intelligence</span>
        </div>
        {/* One quiet status light; capability details live in the tooltip. */}
        <div
          className={`status ${connected ? "on" : "off"}`}
          title={
            caps
              ? `brain: ${caps.brain} · voice in: ${caps.stt} · voice out: ${caps.tts} · crm: ${caps.crm ? "connected" : "off"}`
              : "connecting…"
          }
        >
          <span className="status-dot" />
          <span className="status-text">{connected ? "live" : "reconnecting…"}</span>
        </div>
      </header>

      {/* Overnight digest banner — tap to hear it, × to dismiss for the day */}
      {digest && (
        <div
          className="digest-banner"
          onClick={() => {
            dismissDigest();
            voice.sendText("Give me the overnight digest.");
          }}
          title="Tap to hear the full digest"
        >
          <b>Overnight</b>
          <span>{digest.headline}</span>
          <button
            className="digest-close"
            onClick={(e) => {
              e.stopPropagation();
              dismissDigest();
            }}
            title="Dismiss for today"
          >
            ×
          </button>
        </div>
      )}

      {/* Transcript rail — the conversation so far, down the left edge */}
      {showTranscript && turns.length > 0 && (
        <aside className="transcript-rail" ref={railRef}>
          {turns.map((t, i) => (
            <div className="rail-turn" key={i}>
              <div className="rail-user">“{t.user}”</div>
              {t.assistant && <div className="rail-assistant">{t.assistant}</div>}
            </div>
          ))}
        </aside>
      )}

      {/* Parcel card — appears as the orb becomes the lot */}
      {visual && (
        <aside className="parcel-card" key={visual.hcadAccount}>
          <button className="card-close" onClick={() => voice.dismissCard()} title="Dismiss card">
            ×
          </button>
          <div className="parcel-address">{visual.address ?? "Harris County parcel"}</div>
          {visual.verdict && (
            <div className={`parcel-verdict verdict-${visual.verdict.toLowerCase()}`}>
              VERDICT · {visual.verdict}
            </div>
          )}
          {visual.leadStatus && (
            <div className="parcel-pipeline">
              IN PIPELINE · {visual.leadStatus.replace(/_/g, " ").toUpperCase()}
            </div>
          )}
          {visual.taxSale && (
            <div className="parcel-distress">
              TAX {visual.taxSale.saleDate ? `AUCTION ${visual.taxSale.saleDate}` : "SUIT FILED"}
            </div>
          )}
          {visual.note && <div className="parcel-note">{visual.note}</div>}
          <div className="parcel-rows">
            {visual.ownerName && (
              <div className="row"><span>Owner</span><b>{visual.ownerName}</b></div>
            )}
            <div className="row"><span>Appraised</span><b>{money(visual.appraisedValue)}</b></div>
            {visual.lotSqft != null && (
              <div className="row"><span>Lot</span><b>{Math.round(visual.lotSqft).toLocaleString()} sqft</b></div>
            )}
            {visual.appraisedValue != null && visual.lotSqft != null && visual.lotSqft > 0 && (
              <div className="row">
                <span>$/sqft lot</span>
                <b>${(visual.appraisedValue / visual.lotSqft).toFixed(visual.appraisedValue / visual.lotSqft >= 10 ? 0 : 1)}</b>
              </div>
            )}
            <div className="row"><span>HCAD</span><b>{visual.hcadAccount}</b></div>
            {visual.floodLabel && (
              <div className="row">
                <span>Flood</span>
                <b style={visual.sfha ? { color: "#5c9bff" } : undefined}>{visual.floodLabel}</b>
              </div>
            )}
            {visual.ch42 && (
              <div className="row">
                <span>Ch. 42 fit</span>
                <b style={{ color: "#ffe9b8" }}>
                  {visual.ch42.units} units · {visual.ch42.densityPerAcre}/ac
                </b>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Bottom: transcript, captions, controls */}
      <footer className="bottom">
        {activity && (orbState === "thinking" || orbState === "speaking") && (
          <div className="activity">{activity}</div>
        )}
        {transcript && (orbState === "listening" || orbState === "thinking") && (
          <div className="transcript">“{transcript}”</div>
        )}
        {caption && <div className="caption">{caption}</div>}
        {error && <div className="error">{error}</div>}

        <div className="controls">
          <button
            className={`mic ${micArmed ? "armed" : ""}`}
            onClick={() => void voice.toggleMic()}
            title={micArmed ? "Stop listening" : "Ask by voice"}
          >
            <span className="mic-ring" aria-hidden />
            {micArmed ? (
              <span className="mic-stop" aria-hidden />
            ) : (
              <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden>
                <rect x="9" y="2.5" width="6" height="11.5" rx="3" fill="currentColor" />
                <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                <path d="M12 18v3.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <input
            className="ask"
            value={typed}
            placeholder='Try: “What’s 505 Westcott Street worth?”'
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitTyped()}
          />
          <button className="send" onClick={submitTyped}>Ask</button>
          {(orbState === "speaking" || orbState === "thinking") && (
            <button className="stop" onClick={() => voice.interrupt()} title="Interrupt">
              stop
            </button>
          )}
          {turns.length > 0 && (
            <button
              className={`clear ${showTranscript ? "active" : ""}`}
              onClick={toggleTranscript}
              title="Show the conversation so far"
            >
              {showTranscript ? "hide log" : "log"}
            </button>
          )}
          {chips.length > 0 && (
            <button className="clear" onClick={() => voice.clearMap()} title="Dissolve the map back into the voice">
              clear map
            </button>
          )}
          {alerts != null && (
            <button
              className={`clear ${alerts ? "active" : ""}`}
              onClick={() => void toggleAlerts()}
              title={alerts ? "Nightly digest notifications are on" : "Get the nightly digest as a notification"}
            >
              {alertsBusy ? "…" : alerts ? "alerts on" : "alerts"}
            </button>
          )}
          {freeCam && (
            <button
              className="clear"
              onClick={() => {
                orbBus.camResetRequested = true;
                useHvi.getState().setFreeCam(false);
              }}
              title="Return to the auto camera"
            >
              recenter
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
