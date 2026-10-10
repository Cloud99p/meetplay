import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { AccountsProvider } from "./components/AccountsProvider";

// Accounts wrap the app but never gate it: with no publishable key,
// AccountsProvider renders its children unchanged, so guest flow is identical.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccountsProvider>
      <App />
    </AccountsProvider>
  </StrictMode>
);
