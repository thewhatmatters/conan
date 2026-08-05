import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// WHA-38 spike: build-time-gated self-verification for the native browser
// view. Vite prunes this entirely when the flag is unset, so it cannot reach a
// shipped bundle. Exists because this machine allows neither GUI automation nor
// screen capture of the app window.
if (import.meta.env.VITE_NATIVE_BROWSER_PROBE === "1") {
  void import("./v2/lib/nativeBrowserProbe.ts").then((m) =>
    setTimeout(() => void m.runNativeBrowserProbe(), 2500),
  );
}
