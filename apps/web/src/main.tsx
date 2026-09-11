import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronRight,
  Terminal,
  LockKeyhole,
  Monitor,
  Camera,
  Command,
  Code2,
  Braces,
  Cable,
  Layers,
  Play,
  Menu,
  X,
  Copy,
} from "lucide-react";
import { Brand } from "../../../packages/ui/src/index";
import "./style.css";
const code: Record<string, { caption: string; code: string }> = {
  CLI: {
    caption: "A planned session, from the command line.",
    code: '$ devdeck devices\n  desk-roku     Roku Ultra      available\n  android-tv    Android TV     agent: regression\n  pixel-emu     Emulator       available\n\n$ devdeck reserve desk-roku --ttl 900 \\\n    --reason "Check the browse screen"\n  Reserved for you · 15 minutes\n\n$ devdeck screenshot --session "$SESSION"\n  → captures/desk-roku-01.png',
  },
  MCP: {
    caption: "The same workflow, in your agent’s toolset.",
    code: '// Proposed MCP session tools\n\nconst session = await session_reserve({\n  deviceId: "desk-roku",\n  reason: "Check the browse screen",\n  ttlSeconds: 900\n});\n\nawait device_input({ session, key: "Home" });\nawait capture_screenshot({ session });\nawait session_release({ session });',
  },
  API: {
    caption: "Explicit sessions. Predictable responses.",
    code: '// Proposed authenticated session API\nPOST /v1/sessions\n{\n  "deviceId": "desk-roku",\n  "reason": "Check the browse screen",\n  "ttlSeconds": 900\n}\n\n// Current scaffold endpoints\nGET /v1/health\nGET /v1/inventory',
  },
  JSON: {
    caption: "Your names and pairings, in a file you can edit.",
    code: '{\n  "schemaVersion": 1,\n  "devices": [{\n    "id": "desk-roku",\n    "name": "Desk Roku",\n    "platform": "roku",\n    "captureSourceId": "hdmi-a"\n  }],\n  "reservations": { "defaultTtlSeconds": 900 }\n}',
  },
};
function Website() {
  const [tab, setTab] = useState("CLI");
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <header className="site-header wrap">
        <a href="#" aria-label="Device Deck home">
          <Brand />
        </a>
        <nav className={menu ? "open" : ""} aria-label="Main navigation">
          <a onClick={() => setMenu(false)} href="#workflow">
            The workflow
          </a>
          <a onClick={() => setMenu(false)} href="#agents">
            For agents, too
          </a>
          <a onClick={() => setMenu(false)} href="#status">
            Development status
          </a>
        </nav>
        <a className="nav-cta" href="/demo/">
          Open product preview <ArrowUpRight size={15} />
        </a>
        <button
          className="menu-toggle"
          aria-label={menu ? "Close menu" : "Open menu"}
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X /> : <Menu />}
        </button>
      </header>
      <main>
        <section className="hero wrap">
          <div className="hero-copy">
            <a className="preview-tag" href="#status">
              <span className="tiny-square" /> IN DEVELOPMENT{" "}
              <span>Explore the product preview</span>
              <ChevronRight size={13} />
            </a>
            <h1>
              Your devices. One place.
              <br />
              <span>Room to focus.</span>
            </h1>
            <p>
              A local home for the hardware you already own.
              <br className="desktop-break" /> Find a device, claim a session,
              and get to work.
              <br className="desktop-break" /> Built for you and the agents
              working alongside you.
            </p>
            <div className="hero-actions">
              <a className="btn primary" href="/demo/">
                Explore the interactive preview <ArrowUpRight size={18} />
              </a>
              <a className="text-link" href="#workflow">
                See the workflow <ArrowRight size={16} />
              </a>
            </div>
            <div className="hero-footnote">
              <Monitor size={14} />
              <span>Designed for one Mac and your devices</span>
              <span className="separator">/</span>
              <span>No cloud lab required</span>
            </div>
          </div>
          <div className="hero-product">
            <div className="product-caption">
              <span>
                <span className="caption-mark" /> A CLEAR VIEW OF YOUR DEVICE
                BENCH
              </span>
              <span>01 / INVENTORY + SESSION</span>
            </div>
            <a
              href="/demo/"
              className="dashboard-shot"
              aria-label="Open the interactive device dashboard preview"
            >
              <img
                src="/assets/dashboard-preview.webp"
                width="1440"
                height="1236"
                alt="Device Deck prototype showing Roku, Android TV, Android emulator and Apple simulator inventory, with a reserved Roku session and remote controls"
                fetchPriority="high"
              />
              <span className="shot-open">
                <Play size={14} fill="currentColor" /> Try this screen{" "}
                <ArrowUpRight size={15} />
              </span>
            </a>
            <div className="image-footnote">
              <span>
                Actual rendered prototype · sample data and simulated controls
              </span>
              <span>YOUR BENCH. UNDER CONTROL.</span>
            </div>
          </div>
        </section>
        <section className="platforms wrap">
          <span>ONE INVENTORY, PHYSICAL + VIRTUAL</span>
          <div>
            <span>Roku</span>
            <span>Android TV</span>
            <span>Android emulators</span>
            <span>Apple simulators</span>
          </div>
          <p>
            Planned targets. Hardware integrations are still in development.
          </p>
        </section>
        <section id="workflow" className="workflow wrap">
          <div className="section-heading">
            <div className="kicker">
              <span>01</span> LESS DEVICE ADMIN. MORE BUILDING.
            </div>
            <h2>
              Pick a device.
              <br />
              Keep your train of thought.
            </h2>
            <p>
              Stop piecing together addresses, remote scripts, and capture
              windows. A session puts the next thing you need within reach.
            </p>
          </div>
          <div className="steps">
            <div>
              <span className="step-number">01</span>
              <h3>Find your device</h3>
              <p>
                Physical hardware and virtual devices in one named inventory.
              </p>
            </div>
            <div>
              <span className="step-number">02</span>
              <h3>Make it yours</h3>
              <p>
                Reserve a session. See who is using a device, why, and for how
                long.
              </p>
            </div>
            <div>
              <span className="step-number">03</span>
              <h3>Control. Capture.</h3>
              <p>
                View the screen, drive input, and collect evidence in the same
                place.
              </p>
            </div>
            <div>
              <span className="step-number">04</span>
              <h3>Leave it ready</h3>
              <p>
                Release your session so the next person or agent can take over.
              </p>
            </div>
          </div>
          <div className="session-feature">
            <div className="session-story">
              <span className="mini-label">A SESSION THAT STAYS TOGETHER</span>
              <h3>
                The screen.{" "}
                <br />
                The remote.{" "}
                <br />
                The proof.
              </h3>
              <p>
                A focused workspace for checking a layout, reproducing a bug, or
                letting an agent run its next check.
              </p>
              <ul>
                <li>
                  <Check size={15} /> A visible owner and session expiry
                </li>
                <li>
                  <Check size={15} /> Remote input beside the screen
                </li>
                <li>
                  <Check size={15} /> Screenshots and clips with their session
                </li>
              </ul>
              <a className="text-link" href="/demo/">
                Take the controls <ArrowRight size={16} />
              </a>
            </div>
            <figure className="session-shot">
              <img
                src="/assets/session-preview.webp"
                alt="Focused product prototype with a fictional TV screen, remote pad, session ownership, and capture buttons"
                width="1154"
                height="699"
                loading="lazy"
              />
              <figcaption>Session view · simulated product preview</figcaption>
            </figure>
          </div>
        </section>
        <section id="agents" className="agents-section">
          <div className="agents wrap">
            <div className="agent-copy">
              <div className="kicker">
                <span>02</span> HUMANS AND AGENTS, IN SYNC
              </div>
              <h2>
                Two ways to work.
                <br />
                <span>One set of rules.</span>
              </h2>
              <p>
                You reach for a remote. Your agent reaches for a tool. Device
                Deck is being built around one background service, so everyone
                sees the same devices and respects the same session.
              </p>
              <div className="ownership-note">
                <LockKeyhole size={21} />
                <div>
                  <strong>“Who’s using the Roku?”</strong>
                  <p>
                    That should be a status, not an interruption. Exclusive,
                    renewable sessions are at the heart of the design.
                  </p>
                </div>
              </div>
              <a className="text-link" href="/demo/">
                Explore the agent view <ArrowRight size={16} />
              </a>
            </div>
            <div className="terminal-card">
              <div className="terminal-title">
                <Terminal size={16} />
                <span>device deck / your workflow</span>
                <span className="terminal-dots">•••</span>
              </div>
              <div
                className="tabs"
                role="tablist"
                aria-label="Integration examples"
              >
                {Object.keys(code).map((k) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    aria-controls="example-panel"
                    id={`tab-${k}`}
                    onClick={() => {
                      setTab(k);
                      setCopied(false);
                    }}
                    className={tab === k ? "active" : ""}
                  >
                    {k === "CLI" ? (
                      <Terminal size={14} />
                    ) : k === "MCP" ? (
                      <Command size={14} />
                    ) : k === "API" ? (
                      <Code2 size={14} />
                    ) : (
                      <Braces size={14} />
                    )}{" "}
                    {k}
                  </button>
                ))}
              </div>
              <div
                id="example-panel"
                role="tabpanel"
                aria-labelledby={`tab-${tab}`}
              >
                <p className="code-caption">{code[tab].caption}</p>
                <pre>{code[tab].code}</pre>
              </div>
              <div className="terminal-bottom">
                <span>Proposed session contracts · not a shipping CLI</span>
                <button
                  aria-label="Copy code example"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(code[tab].code);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          </div>
        </section>
        <section className="local-section wrap">
          <div className="local-heading">
            <div className="kicker">
              <span>03</span> YOUR HARDWARE, REMEMBERED
            </div>
            <h2>
              The bench you have.
              <br />
              With less to remember.
            </h2>
            <p>
              Start with one Mac. Give devices names. Pair the capture sources
              you already use. Keep the configuration in an editable JSON file.
            </p>
          </div>
          <div className="local-details">
            <div className="pairing-card">
              <div className="pairing-title">
                <Cable size={18} />
                <span>REMEMBERED SOURCE PAIRING</span>
              </div>
              <div className="pairing-flow">
                <div>
                  <Monitor size={27} />
                  <strong>Desk Roku</strong>
                  <span>Logical device</span>
                </div>
                <div className="pair-wire">
                  <span>HDMI</span>
                  <ArrowRight size={22} />
                </div>
                <div>
                  <Layers size={27} />
                  <strong>Capture A</strong>
                  <span>Video source</span>
                </div>
              </div>
              <p>
                A capture card knows it has a picture. You tell Device Deck
                which device that picture belongs to.
              </p>
              <span className="mini-label">
                EXPLICIT PAIRING. STABLE NAMES.
              </span>
            </div>
            <div className="local-promises">
              <article>
                <Camera size={23} />
                <div>
                  <h3>Recording belongs to the service</h3>
                  <p>
                    The intended background service keeps recording when you
                    close the dashboard. Real capture and cleanup remain
                    implementation work.
                  </p>
                </div>
              </article>
              <article>
                <Braces size={23} />
                <div>
                  <h3>A setup you can read and edit</h3>
                  <p>
                    Device names, defaults, and source mappings live in JSON.
                    Runtime ownership belongs in transactional storage.
                  </p>
                </div>
              </article>
            </div>
          </div>
        </section>
        <section id="status" className="status-section wrap">
          <div className="status-box">
            <div>
              <span className="status-tag">
                <span className="tiny-square" /> EARLY PRODUCT PREVIEW
              </span>
              <h2>
                Built around a real bench.
                <br />
                Still on the workbench.
              </h2>
              <p>
                Device Deck starts with a familiar problem: too much attention
                spent coordinating test devices. This preview makes the proposed
                workflow tangible.
              </p>
              <div className="status-grid">
                <div>
                  <span className="status-column-label">YOU CAN TRY NOW</span>
                  <span>
                    <Check size={14} /> Interactive device dashboard
                  </span>
                  <span>
                    <Check size={14} /> Simulated sessions and capture
                  </span>
                  <span>
                    <Check size={14} /> Source pairing and agent examples
                  </span>
                </div>
                <div>
                  <span className="status-column-label">STILL TO BUILD</span>
                  <span>Hardware adapters and live capture</span>
                  <span>Durable leases and background recording</span>
                  <span>Installable app and full client workflow</span>
                </div>
              </div>
            </div>
            <aside>
              <span className="status-stamp">dd / 0.1</span>
              <h3>
                See how it
                <br />
                would fit your day.
              </h3>
              <a className="btn primary" href="/demo/">
                Open the product preview <ArrowUpRight size={17} />
              </a>
              <p>
                No account. No install.
                <br />
                Just a sample workspace to explore.
              </p>
              <span className="pricing-note">
                No shipping download yet.
                <br />
                Pricing and release date are undecided.
              </span>
            </aside>
          </div>
        </section>
      </main>
      <footer className="site-footer wrap">
        <a href="#">
          <Brand />
        </a>
        <p>A local device workspace by TantaWowa.</p>
        <a href="/demo/">
          Explore Device Deck <ArrowUpRight size={14} />
        </a>
        <span>© {new Date().getFullYear()} TantaWowa</span>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Website />
  </React.StrictMode>,
);
