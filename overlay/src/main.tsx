import React from "react";
import ReactDOM from "react-dom/client";
import CopilotOverlay from "./CopilotOverlay";
import { ContextWindow } from "./pages/ContextWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Sub-prompt 4.5: hash-routed dual entry. The same Vite bundle ships
// both the live overlay (default) and the context paste window
// (#/context). The context window is opened by Rust via
// WebviewWindowBuilder pointing at index.html#/context.
//
// Two routes are enough for V1; if Sub-prompt 5+ adds more we can
// swap in react-router or a simple route registry.
const isContextRoute = window.location.hash.startsWith("#/context");
const Page = isContextRoute ? <ContextWindow /> : <CopilotOverlay />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{Page}</ErrorBoundary>
  </React.StrictMode>,
);
