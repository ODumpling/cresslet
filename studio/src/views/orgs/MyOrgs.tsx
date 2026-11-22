// /orgs: the organizations you belong to (the admin pages' layout).
import { Link } from "@tanstack/react-router";
import { ORG_ROLE_LABEL } from "../../lib/format.ts";
import { useView } from "../../lib/hooks.ts";
import { loadMyOrgs } from "../../lib/session.ts";
import { EmptyState } from "../../ui/bits.tsx";
import { AdminView, useAdminLoad } from "../admin/AdminPage.tsx";

export function MyOrgs() {
  useView("admin", "Organizations", "orgs");
  const loaded = useAdminLoad(loadMyOrgs); // never fails: no orgs on an error
  return (
    <AdminView loaded={loaded} title="Organizations" sub={loaded.data ? "Organizations you belong to" : ""} retry={false}>
      {(orgs) => orgs.length ? (
        <ul className="list">
          {orgs.map((o) => (
            <li className="list-row" key={o.name}>
              <div className="tok">
                <Link to="/orgs/$name" params={{ name: o.name }}>{o.title ?? o.name}</Link>
                <span className="meta">{`${o.name} · ${ORG_ROLE_LABEL[o.role]}`}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="You're not in an organization">A site admin creates organizations, and their admins add members.</EmptyState>}
    </AdminView>
  );
}
