import React from "react";
import ReactDOM from "react-dom/client";
import CopilotOverlay from "./CopilotOverlay";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <CopilotOverlay />
    </ErrorBoundary>
  </React.StrictMode>,
);
