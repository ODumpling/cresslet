import { createFileRoute } from "@tanstack/react-router";
import { AppDatabase } from "../views/app/Database.tsx";

export const Route = createFileRoute("/apps/$name/database/{-$table}")({
  component: AppDatabase,
});
