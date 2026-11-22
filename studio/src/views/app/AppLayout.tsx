// TODO(port): AppLayout
import { Outlet } from "@tanstack/react-router";
export function AppLayout() {
  return <main className="page" aria-labelledby="todo-title"><h1 id="todo-title" tabIndex={-1}>AppLayout</h1><Outlet /></main>;
}
