import React from "react";
import ReactDOM from "react-dom/client";
import CopilotOverlay from "./CopilotOverlay";
import { ContextWindow } from "./pages/ContextWindow";
import { RecorderPanel } from "./pages/RecorderPanel";
import { WebcamBubble } from "./pages/WebcamBubble";
import { Countdown } from "./pages/Countdown";
import { ControlBar } from "./pages/ControlBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Hash-routed multi-entry: the same Vite bundle ships the live overlay
// (default), the context window (#/context), the unified recorder
// panel (#/recorder), the webcam bubble (#/webcam-bubble), the
// countdown overlay (#/countdown) and the recording control bar
// (#/control-bar). Each non-default window is opened by Rust via
// WebviewWindowBuilder pointing at index.html#/<route>.
const hash = window.location.hash;
const Page = hash.startsWith("#/context") ? (
  <ContextWindow />
) : hash.startsWith("#/recorder") ? (
  <RecorderPanel />
) : hash.startsWith("#/webcam-bubble") ? (
  <WebcamBubble />
) : hash.startsWith("#/countdown") ? (
  <Countdown />
) : hash.startsWith("#/control-bar") ? (
  <ControlBar />
) : (
  <CopilotOverlay />
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{Page}</ErrorBoundary>
  </React.StrictMode>,
);
