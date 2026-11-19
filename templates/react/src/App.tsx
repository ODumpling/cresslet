import { useEffect, useState } from "react";

interface Todo {
  id: number;
  text: string;
  done: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function App() {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () => api<Todo[]>("/todos").then(setTodos, (e) => setError(String(e)));
  useEffect(() => void load(), []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    await api("/todos", { method: "POST", body: JSON.stringify({ text }) });
    setText("");
    load();
  }

  async function toggle(t: Todo) {
    await api(`/todos/${t.id}`, { method: "PATCH", body: JSON.stringify({ done: !t.done }) });
    load();
  }

  async function remove(t: Todo) {
    await api(`/todos/${t.id}`, { method: "DELETE" });
    load();
  }

  return (
    <main>
      <h1>Todos</h1>
      <form onSubmit={add}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a todo" />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      {todos === null ? (
        <p className="muted">Loading…</p>
      ) : todos.length === 0 ? (
        <p className="muted">Nothing yet. Add your first todo above.</p>
      ) : (
        <ul>
          {todos.map((t) => (
            <li key={t.id} className={t.done ? "done" : ""}>
              <label>
                <input type="checkbox" checked={!!t.done} onChange={() => toggle(t)} />
                {t.text}
              </label>
              <button className="link" onClick={() => remove(t)} aria-label={`Delete ${t.text}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
