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
    turns, showTranscript, toggleTranscript, activity, digest, dismissDigest, teamNote, doc, muted,
  } = useHvi();
  const [typed, setTyped] = useState("");
  const railRef = useRef<HTMLElement>(null);
  // Mic gesture: a quick tap toggles listening; press-and-hold is push-to-talk
  // (listen while held, stop on release) — natural in a noisy truck cab.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldPTT = useRef(false);
  const micDown = () => {
    heldPTT.current = false;
    holdTimer.current = setTimeout(() => {
      heldPTT.current = true;
      if (!useHvi.getState().micArmed) {
        voice.haptic(15);
        void voice.toggleMic();
      }
    }, 280);
  };
  const micUp = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (heldPTT.current) {
      // Push-to-talk release: stop listening.
      if (useHvi.getState().micArmed) void voice.toggleMic();
      heldPTT.current = false;
    } else {
      // Quick tap: toggle.
      voice.haptic(10);
      void voice.toggleMic();
    }
  };
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

      {/* Live team activity — a teammate's parcel just joined this map */}
      {teamNote && <div className="team-note">◈ {teamNote}</div>}

      {/* Document preview — drafted by voice, filed only on approval */}
      {doc && (
        <aside className="doc-panel">
          <header className="doc-head">
            <div>
              <div className="doc-title">{doc.title}</div>
              <div className={`doc-state ${doc.filed ? "filed" : ""}`}>
                {doc.filed ? "FILED TO CRM ✓" : "DRAFT — not saved anywhere yet"}
              </div>
            </div>
            <button className="card-close" onClick={() => useHvi.getState().setDoc(null)} title="Close (draft stays pending)">
              ×
            </button>
          </header>
          <pre className="doc-body">{doc.body}</pre>
          <footer className="doc-actions">
            {!doc.filed && (
              <button className="doc-file" onClick={() => voice.docAction("file")}>
                File to CRM
              </button>
            )}
            <button className="clear" onClick={() => window.print()}>
              Print
            </button>
            {!doc.filed && (
              <button className="clear" onClick={() => voice.docAction("discard")}>
                Discard
              </button>
            )}
            {!doc.filed && <span className="doc-hint">or say “file it” / tell Jarvo what to change</span>}
          </footer>
        </aside>
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
            {visual.violations && visual.violations.count > 0 && (
              <div className="row" title="City enforcement history — public feed covers 2014–Aug 2018 only">
                <span>Violations</span>
                <b style={{ color: "#ffc15e" }}>
                  {visual.violations.count} · {(visual.violations.topCategory ?? "code").toLowerCase()}
                  {visual.violations.newest ? ` · thru ${visual.violations.newest.slice(0, 4)}` : ""}
                </b>
              </div>
            )}
          </div>

          {/* Quick actions — act on the parcel by thumb, no voice needed */}
          <div className="card-actions">
            {visual.leadStatus ? (
              <button className="qa" onClick={() => voice.quickAction("mark it hot")} title="Set status to hot lead">Mark hot</button>
            ) : (
              <button className="qa qa-primary" onClick={() => voice.quickAction("save it")} title="Save to the pipeline">Save lead</button>
            )}
            <button className="qa" onClick={() => voice.quickAction("trace the owner")} title="Skip-trace the owner">Trace</button>
            <button className="qa" onClick={() => voice.quickAction("run the verdict on this")} title="Go/no-go screen">Verdict</button>
            <button className="qa" onClick={() => voice.quickAction("prep a call sheet")} title="Draft a call sheet">Call sheet</button>
            <button className="qa qa-ghost" onClick={() => voice.tellMeMore()} title="Hear the full briefing">🔊 Tell me more</button>
          </div>

          {/* Reach the owner — CRM enrichment; tap a number to dial */}
          {visual.contacts && (visual.contacts.phones.length > 0 || visual.contacts.contactInfo) && (
            <div className="contact-block">
              <div className="contact-head">
                REACH THE OWNER
                {visual.contacts.needsReview && <span className="contact-review">NEEDS REVIEW</span>}
              </div>
              {visual.contacts.phones.map((p) => {
                const isPrimary = p.number === visual.contacts!.primaryPhone;
                const isBad = p.status === "bad";
                // DNC numbers stay visible but never dialable (TCPA).
                const noDial = isBad || p.dnc === true;
                return (
                  <div key={p.number} className={`contact-row ${isBad ? "bad" : p.dnc ? "dnc" : ""}`}>
                    {noDial ? (
                      <span className="contact-num">{p.number}</span>
                    ) : (
                      <a className="contact-num" href={`tel:${p.number.replace(/[^\d+]/g, "")}`}>
                        {p.number}
                      </a>
                    )}
                    <span className="contact-meta">
                      {isBad
                        ? `bad${p.badReason ? ` · ${p.badReason.replace(/_/g, " ")}` : ""}`
                        : p.dnc
                          ? "DO NOT CALL · DNC registry"
                          : [isPrimary ? "primary" : null, p.contactName, p.source?.replace(/^skiptrace:/, "")]
                              .filter(Boolean)
                              .join(" · ") || "on file"}
                    </span>
                  </div>
                );
              })}
              <div className="contact-hours">Calling hours: 8am–9pm · manual dial only</div>
              {/* Close the loop: one-thumb call outcome after you dial. */}
              {visual.contacts.phones.some((p) => p.status !== "bad" && !p.dnc) && (
                <div className="log-call">
                  <span className="log-call-label">After a call, log it:</span>
                  <button className="log-btn" onClick={() => voice.quickAction("log that call, no answer")}>No answer</button>
                  <button className="log-btn" onClick={() => voice.quickAction("log that call, wrong number")}>Wrong #</button>
                  <button className="log-btn log-good" onClick={() => voice.quickAction("log that call, talked to them")}>Talked</button>
                </div>
              )}
              {visual.contacts.contactInfo && (
                <div className="contact-notes">{visual.contacts.contactInfo}</div>
              )}
            </div>
          )}
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
            onPointerDown={(e) => { e.preventDefault(); micDown(); }}
            onPointerUp={micUp}
            onPointerLeave={() => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } }}
            onPointerCancel={() => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } if (heldPTT.current && useHvi.getState().micArmed) void voice.toggleMic(); heldPTT.current = false; }}
            title={micArmed ? "Stop listening (or hold to talk)" : "Tap to listen · hold to talk"}
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
          <button
            className={`clear ${muted ? "active" : ""}`}
            onClick={() => voice.setMuted(!muted)}
            title={muted ? "Quiet mode on — captions only, no voice" : "Mute the voice (captions only)"}
          >
            {muted ? "🔇 quiet" : "🔊 voice"}
          </button>
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
