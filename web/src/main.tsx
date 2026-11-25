import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { SessionProvider, ShortcutsProvider, ThemeProvider } from "./state";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <SessionProvider>
        <ShortcutsProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ShortcutsProvider>
      </SessionProvider>
    </ThemeProvider>
  </StrictMode>,
);
