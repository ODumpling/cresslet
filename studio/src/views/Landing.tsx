// #/ for logged-out visitors (and, on servers without login, new visitors with no local projects): what Cresslet is,
// and the templates to start from. No sidebar.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as API from "../../api-types.ts";
import { meta } from "../lib/api.ts";
import { viewShown } from "../lib/focus.ts";
import { useView } from "../lib/hooks.ts";
import { logIn } from "../lib/session.ts";
import { Icon, SrOnly } from "../ui/icons.tsx";
import { copyCommand, Templates } from "../ui/templates.tsx";

const Ext = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
  <a className={className} href={href} target="_blank" rel="noopener">{children}<SrOnly> (opens in a new tab)</SrOnly></a>
);

export function Landing() {
  useView("landing", null);
  useLayoutEffect(viewShown, []);
  useEffect(() => void (document.title = "Cresslet: build it in the browser, ship it in a second"), []);
  const [m, setMeta] = useState<API.Meta>({});
  useEffect(() => void meta().then(setMeta), []);
  const templatesTitle = useRef<HTMLHeadingElement>(null);
  const termCode = useRef<HTMLElement>(null);

  // This server's own app domain, and what visitors can do without an account.
  const url = m.appUrlTemplate ? m.appUrlTemplate.replace("{name}", "my-app") : "https://my-app.cresslet.dev";
  const host = url.replace(/^https?:\/\//, "");
  const hours = Math.round((m.limits?.anonTtlMs ?? 0) / 3600_000);
  const note = m.auth?.github ? "Free and open source. Log in with GitHub to start building."
    : m.anonDeploys ? `Free and open source. No account needed: apps deployed without one last ${hours} hours.`
    : m.auth ? "Free and open source. Try it without an account." : "Free and open source. No account needed to try it.";
  const ctaNote = m.auth?.github ? "Free and open source. Log in with GitHub to start building." : "Free and open source. Start in the browser, no account needed.";

  /** "Start building": to the templates, with focus on their heading so keyboard users land there too. */
  const start = () => {
    const h = templatesTitle.current!; // rendered
    h.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    h.focus({ preventScroll: true });
  };
  const Start = ({ className = "btn primary lg" }: { className?: string }) => (
    <button className={className} type="button" data-start onClick={start}>Start building<Icon name="arrow" /></button>
  );

  return (
    <>
      <header className="site-nav" id="site-nav">
        <a className="site-brand" href="#/"><Icon name="logo" className="brand-mark" /><span>Cresslet</span></a>
        <nav className="site-links" aria-label="Site">
          <Ext href="https://github.com/ODumpling/cresslet#docs">Docs</Ext>
          <Ext href="https://github.com/ODumpling/cresslet-cli">CLI</Ext>
          <Ext href="https://github.com/ODumpling/cresslet">GitHub</Ext>
        </nav>
        <div className="spacer" />
        <button className="btn" id="landing-login" type="button" hidden={!m.auth?.github} onClick={() => void logIn()}><Icon name="github" />Log in</button>
        <button className="btn primary site-start" type="button" data-start onClick={start}>Start building</button>
      </header>

      <main id="landing" className="landing" aria-labelledby="landing-title">
        <section className="l-hero">
          <p className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Open source · self-hostable</p>
          <h1 id="landing-title" tabIndex={-1}>Build it in the browser. <span className="accent-text">Ship it in a second.</span></h1>
          <p className="lede">Pick a template, edit it with a live preview, and deploy it to its own sandbox, database and subdomain. No setup, nothing to install.</p>
          <div className="cta-row">
            <Start />
            <Ext className="btn lg" href="https://github.com/ODumpling/cresslet"><Icon name="github" />View on GitHub</Ext>
          </div>
          <p className="l-note" id="landing-note">{note}</p>

          {/* A picture of the studio, drawn in HTML so it follows the theme. */}
          <div className="mock" role="img" aria-label="The studio: files, code and a live preview of a todo app side by side, with a Deploy button">
            <div className="mock-bar">
              <span className="mock-dots"><i /><i /><i /></span>
              <span className="mock-name"><Icon name="logo" className="brand-mark" />my-app</span>
              <span className="mock-status"><span className="dot" data-s="live" />Ready</span>
              <span className="spacer" />
              <span className="mock-deploy"><Icon name="rocket" />Deploy</span>
            </div>
            <div className="mock-body">
              <div className="mock-files">
                <span className="mock-dir">server</span>
                <span className="d1 on">index.ts</span>
                <span className="mock-dir">src</span>
                <span className="d1">App.tsx</span>
                <span className="d1">main.tsx</span>
                <span className="d1">styles.css</span>
                <span>cresslet.json</span>
                <span>index.html</span>
                <span>package.json</span>
              </div>
              <pre className="mock-code">
                <span className="c">// server/index.ts: handles /api/*</span>{"\n"}
                <span className="k">import</span>{" { db } "}<span className="k">from</span> <span className="s">"cresslet"</span>{";\n"}
                <span className="k">export default</span>{" {\n  "}
                <span className="k">async</span> <span className="f">fetch</span>{"(req) {\n    "}
                <span className="k">const</span>{" todos = "}<span className="k">await</span>{" db."}<span className="f">sql</span><span className="s">`SELECT * FROM todos`</span>{";\n    "}
                <span className="k">return</span>{" Response."}<span className="f">json</span>{"(todos);\n  },\n};"}
              </pre>
              <div className="mock-preview">
                <div className="mock-url"><Icon name="globe" /><span className="js-app-host">{host}</span></div>
                <div className="mock-app">
                  <strong>Todos</strong>
                  <span className="mock-input">What needs doing?</span>
                  <span className="mock-todo done"><i />Pick a template</span>
                  <span className="mock-todo done"><i />Edit with a live preview</span>
                  <span className="mock-todo"><i />Deploy it</span>
                </div>
              </div>
            </div>
            <span className="mock-toast"><span className="dot" data-s="live" />Live on <span className="js-app-host">{host}</span></span>
          </div>
        </section>

        <section className="l-section" aria-labelledby="how-title">
          <p className="kicker">How it works</p>
          <h2 id="how-title">From idea to a live URL in three steps</h2>
          <ol className="steps">
            <li><span className="step-n" aria-hidden="true">1</span><h3>Pick a template</h3><p>A React app with an API and SQLite, or plain HTML and TypeScript. It opens in the studio, ready to run.</p></li>
            <li><span className="step-n" aria-hidden="true">2</span><h3>Edit with a live preview</h3><p>Code, terminal and preview side by side. <code>npm install</code> and the dev server run right in your tab.</p></li>
            <li><span className="step-n" aria-hidden="true">3</span><h3>Deploy</h3><p>One click and it's live on <code className="js-app-host">{host}</code>, with its own database and files.</p></li>
          </ol>
        </section>

        <section className="l-section" aria-labelledby="features-title">
          <p className="kicker">Everything included</p>
          <h2 id="features-title">A whole platform, not just a preview</h2>
          <p className="l-sub">Every app comes with what it needs to be real, and none of it needs wiring up.</p>
          <ul className="features">
            {([
              ["window", "Runs in your browser", <>npm, a dev server and hot reload run in the tab on Cresslet's own runtime. No VM, no install.</>],
              ["rocket", "Live in a second", <>Deploys go live on their own subdomain in under a second. Your last 10 stay a rollback away.</>],
              ["database", "Database and files built in", <>Each app gets a SQLite database, file storage and secrets. No services to set up.</>],
              ["shield", "Every app in its own sandbox", <>Apps run isolated from each other, with memory, request and network limits.</>],
              ["bot", "Made for agents", <>Templates ship <code>AGENTS.md</code>, every CLI command speaks <code>--json</code>, and the server serves <code>/llms.txt</code>.</>],
              ["github", "Open source, self-hostable", <>MIT licensed. Run the whole platform on your own server with Node or Docker.</>],
            ] as const).map(([icon, title, text]) => (
              <li key={title}>
                <span className="feature-icon" aria-hidden="true"><svg className="icon"><use href={`#i-${icon}`} /></svg></span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="l-section" aria-labelledby="landing-templates-title">
          <p className="kicker">Start now</p>
          <h2 id="landing-templates-title" tabIndex={-1} ref={templatesTitle}>Pick a template</h2>
          <p className="l-sub">It opens in the studio, ready to edit, run and deploy.</p>
          <Templates id="landing-templates" className="grid l-templates" />
        </section>

        <section className="l-section l-split" aria-labelledby="cli-title">
          <div>
            <p className="kicker">Terminal and agents</p>
            <h2 id="cli-title">Prefer your terminal or an agent?</h2>
            <p className="l-sub">The same apps, from your editor or a coding agent. The CLI scaffolds, runs and deploys, and every command takes <code>--json</code>.</p>
            <ul className="checks">
              <li><Icon name="check" />Same runtime locally, in the browser and in production</li>
              <li><Icon name="check" />Logs, database and secrets from the command line</li>
              <li><Icon name="check" />Deploy from CI with a scoped API token</li>
              <li><Icon name="check" />Share an HTML file privately, with a link or publicly as an <a href="#/artifacts">artifact</a>: <code>npx cresslet@latest deploy report.html</code></li>
            </ul>
          </div>
          <div className="term">
            <div className="term-bar">
              <span className="mock-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="term-title" id="term-title">Terminal</span>
              <button className="icon-btn" type="button" data-copy="npx cresslet new my-app" aria-describedby="term-title" onClick={() => void copyCommand("npx cresslet new my-app", termCode.current)}>
                <Icon name="copy" /><SrOnly>Copy the first command</SrOnly>
              </button>
            </div>
            <pre className="term-body" tabIndex={0} aria-labelledby="term-title"><code ref={termCode}>
              <span className="p" aria-hidden="true">$ </span>{"npx cresslet new my-app\n"}
              <span className="p" aria-hidden="true">$ </span>{"cd my-app && npm install && npm run dev\n"}
              <span className="p" aria-hidden="true">$ </span>{"npx cresslet deploy\n"}
              <span className="ok">✓ Live at <span className="js-app-url">{url}</span></span>
            </code></pre>
          </div>
        </section>

        <section className="l-cta" aria-labelledby="cta-title">
          <h2 id="cta-title">Your next app is one click away</h2>
          <p className="l-sub" id="cta-note">{ctaNote}</p>
          <div className="cta-row">
            <Start />
            <Ext className="btn lg" href="https://github.com/ODumpling/cresslet/blob/main/docs/self-hosting.md"><Icon name="server" />Self-host it</Ext>
          </div>
        </section>

        <footer className="l-foot">
          <span className="site-brand small"><Icon name="logo" className="brand-mark" />Cresslet</span>
          <span className="muted small">MIT licensed</span>
          <span className="spacer" />
          <Ext href="https://github.com/ODumpling/cresslet/blob/main/docs/api.md">API</Ext>
          <a href="/llms.txt">llms.txt</a>
          <Ext href="https://github.com/ODumpling/cresslet-container">Runtime</Ext>
          <Ext href="https://github.com/ODumpling/cresslet">GitHub</Ext>
        </footer>
      </main>
    </>
  );
}
