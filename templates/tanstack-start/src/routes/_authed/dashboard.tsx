import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { addTodo, deleteTodo, listTodos, toggleTodo } from "../../server/todos";

export const Route = createFileRoute("/_authed/dashboard")({
  loader: () => listTodos(),
  head: () => ({ meta: [{ title: "Dashboard" }] }),
  component: Dashboard,
});

function Dashboard() {
  const todos = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const [title, setTitle] = useState("");
  // after a change: re-run the loader (the server function) for fresh rows
  const run = async (p: Promise<unknown>) => {
    await p;
    await router.invalidate();
  };

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await run(addTodo({ data: { title } }));
    setTitle("");
  }

  const open = todos.filter((t) => !t.done).length;
  return (
    <main className="page narrow">
      <h1>Hi, {user.name}</h1>
      <p className="muted">{todos.length ? `${open} of ${todos.length} open` : "Nothing here yet."}</p>
      <form className="row" onSubmit={onAdd}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-label="New todo" maxLength={500} />
        <button type="submit">Add</button>
      </form>
      <ul className="todos">
        {todos.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => run(toggleTodo({ data: { id: t.id } }))} />
              <span>{t.title}</span>
            </label>
            <button className="link danger" aria-label={`Delete ${t.title}`} onClick={() => run(deleteTodo({ data: { id: t.id } }))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
