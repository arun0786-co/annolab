import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { Loading } from "./components/States";
import { DataRows } from "./pages/DataRows";
import { LabelTask, QueueEntry } from "./pages/Labeler";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { ProjectLayout } from "./pages/ProjectLayout";
import { Projects } from "./pages/Projects";
import { ReviewItem, ReviewQueue } from "./pages/Review";
import { SchemaEditor } from "./pages/SchemaEditor";
import { useSession } from "./state";

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, ready } = useSession();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return children;
}

export function App() {
  return (
    <>
      <a href="#main" className="sr-only">
        Skip to content
      </a>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectLayout />}>
            <Route index element={<Overview />} />
            <Route path="data" element={<DataRows />} />
            <Route path="schema" element={<SchemaEditor />} />
          </Route>
        </Route>
        <Route path="/projects/:id/label" element={<RequireAuth><QueueEntry /></RequireAuth>} />
        <Route path="/projects/:id/label/:taskId" element={<RequireAuth><LabelTask /></RequireAuth>} />
        <Route path="/projects/:id/review" element={<RequireAuth><ReviewQueue /></RequireAuth>} />
        <Route path="/projects/:id/items/:itemId" element={<RequireAuth><ReviewItem /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ShortcutsOverlay />
    </>
  );
}
