import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@plan/shared/components/theme-provider";
import App from "./app";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
);
