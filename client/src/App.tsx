// Routes, and the "am I logged in?" check that decides which page to show.
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import AuthPage from "./pages/AuthPage";
import LedgerPage from "./pages/LedgerPage";
import PrivacyPage from "./pages/PrivacyPage";

type Me = { username: string } | null | undefined; // undefined = still checking

const TITLES: Record<string, string> = { "/login": "Log in · Lena Dena Ledger", "/signup": "Sign up · Lena Dena Ledger", "/privacy": "Privacy · Lena Dena Ledger" };

export default function App() {
  const [me, setMe] = useState<Me>(undefined);
  const location = useLocation();

  useEffect(() => {
    // The session cookie is httpOnly, so the page can't read it; ask the server instead.
    api<{ username: string }>("/api/me", { allow401: true }).then(setMe).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    document.title = TITLES[location.pathname] || "Lena Dena Ledger";
  }, [location.pathname]);

  if (me === undefined && location.pathname !== "/privacy") {
    return <main className="login"><p className="sub">Loading…</p></main>;
  }

  return (
    <Routes>
      <Route path="/" element={me ? <LedgerPage username={me.username} /> : <Navigate to={`/login${location.search}`} replace />} />
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <AuthPage mode="login" />} />
      <Route path="/signup" element={me ? <Navigate to="/" replace /> : <AuthPage mode="signup" />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
