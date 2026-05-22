import React from "react";
import ReactDOM from "react-dom/client";
import CopilotOverlay from "./CopilotOverlay";
import { ContextWindow } from "./pages/ContextWindow";
import { RecorderPanel } from "./pages/RecorderPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Sub-prompt 4.5: hash-routed multi-entry. The same Vite bundle ships
// the live overlay (default), the context paste window (#/context),
// and the Loom-style recorder panel (#/recorder). Each non-default
// window is opened by Rust via WebviewWindowBuilder pointing at
// index.html#/<route>.
const hash = window.location.hash;
const Page = hash.startsWith("#/context") ? (
  <ContextWindow />
) : hash.startsWith("#/recorder") ? (
  <RecorderPanel />
) : (
  <CopilotOverlay />
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{Page}</ErrorBoundary>
  </React.StrictMode>,
);
