import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { Spinner } from "./components/ui";

const Overview = lazy(() => import("./pages/Overview"));
const Sources = lazy(() => import("./pages/Sources"));
const Lake = lazy(() => import("./pages/Lake"));
const Graph = lazy(() => import("./pages/Graph"));
const Search = lazy(() => import("./pages/Search"));
const Agents = lazy(() => import("./pages/Agents"));
const Skills = lazy(() => import("./pages/Skills"));
const Lab = lazy(() => import("./pages/Lab"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Team = lazy(() => import("./pages/Team"));
const Audit = lazy(() => import("./pages/Audit"));
const Settings = lazy(() => import("./pages/Settings"));

export default function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="sources" element={<Sources />} />
          <Route path="lake" element={<Lake />} />
          <Route path="lake/:id" element={<Lake />} />
          <Route path="graph" element={<Graph />} />
          <Route path="graph/:id" element={<Graph />} />
          <Route path="search" element={<Search />} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/:traceId" element={<Agents />} />
          <Route path="skills" element={<Skills />} />
          <Route path="skills/:id" element={<Skills />} />
          <Route path="lab" element={<Lab />} />
          <Route path="lab/:id" element={<Lab />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="team" element={<Team />} />
          <Route path="audit" element={<Audit />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
