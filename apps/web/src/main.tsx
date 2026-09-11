import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Folder,
  Menu,
  Monitor,
  Terminal,
  Usb,
  X,
  LockKeyhole,
  Camera,
  LayoutGrid,
  Keyboard,
  Code2,
} from "lucide-react";
import { Brand } from "../../../packages/ui/src";
import "./style.css";
const demo = "/demo/";
function App() {
  const [menu, setMenu] = useState(false);
  const [tab, setTab] = useState("CLI");
  const [copied, setCopied] = useState(false);
  const examples: Record<string, string> = {
    CLI: '# Illustrative remote workflow\ndevdeck remote --device "Desk Roku"\n\n# No target? An interactive picker.\ndevdeck remote --platform Roku --state free\n\n# Scriptable selectors, no prompts\ndevdeck remote --platform Android --name "Pixel*" \\\n  --state free --key Home --json\n\n# Proposed Mac clipboard capture\ndevdeck screenshot --device "Desk Roku" --clipboard',
    MCP: '// Illustrative agent workflow\ndevices.list({ platform: "Roku", state: "free" })\nsessions.reserve({\n  deviceId: "roku-desk",\n  owner: "Agent",\n  reason: "Navigation regression"\n})\nremote.key({ sessionId: "…", key: "Home" })\ncaptures.screenshot({ sessionId: "…" })\nsessions.release({ sessionId: "…" })',
    API: '# Illustrative local API\nPOST /v1/sessions\n{\n  "deviceId": "roku-desk",\n  "owner": "You",\n  "reason": "Browse screen review"\n}\n\nPOST /v1/sessions/:id/input\n{ "key": "Home" }\n\nPOST /v1/sessions/:id/captures',
    JSON: '{\n  "schemaVersion": 1,\n  "devices": [{\n    "id": "roku-desk",\n    "name": "Desk Roku",\n    "captureSourceId": "cam-link",\n    "visibility": "local"\n  }],\n  "capture": {\n    "outputDirectory": "~/Movies/Device Deck"\n  }\n}',
  };
  return (
    <>
      <header className="site-header">
        <a href="#top" aria-label="Device Deck home">
          <Brand />
        </a>
        <nav className={menu ? "open" : ""}>
          {[
            ["#workspace", "Workspace"],
            ["#capture", "Capture & evidence"],
            ["#cli", "CLI & agents"],
            ["#status", "Development status"],
          ].map(([href, label]) => (
            <a href={href} key={href} onClick={() => setMenu(false)}>
              {label}
            </a>
          ))}
        </nav>
        <a className="button small primary header-demo" href={demo}>
          Open interactive demo <ArrowRight size={14} />
        </a>
        <button
          className="menu-button"
          aria-label={menu ? "Close menu" : "Open menu"}
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X /> : <Menu />}
        </button>
      </header>
      <main id="top">
        <section className="hero wrap">
          <div className="release-label">
            <span /> A local Mac workspace for TV app development
          </div>
          <h1>
            Every device.
            <br />
            One clear view.
          </h1>
          <p className="hero-copy">
            Find your Roku, Android and Apple devices. See who’s using them,
            open a remote, and keep your captures together on your Mac.
          </p>
          <div className="hero-actions">
            <a className="button primary" href={demo}>
              Explore the interactive demo <ArrowRight size={17} />
            </a>
            <a className="button" href="#workspace">
              See the workspace
            </a>
          </div>
          <p className="preview-note">
            Product preview · simulated hardware · no login
          </p>
          <div className="hero-screenshot">
            <div className="window-bar">
              <span className="window-dots">
                <i />
                <i />
                <i />
              </span>
              <span>
                <Monitor size={12} /> Device Deck / My Mac workspace
              </span>
              <span className="window-tag">INTERACTIVE PROTOTYPE</span>
            </div>
            <a
              href={demo}
              aria-label="Open the devices table in the interactive demo"
            >
              <img
                src="/assets/dashboard-preview.webp"
                alt="Actual rendered Device Deck preview: a readable light devices table with friendly names, platform, health, reservation, owner, capture input and visibility"
                fetchPriority="high"
              />
            </a>
          </div>
          <div className="screenshot-caption">
            <span>
              Actual prototype screen. All devices, owners and USB sources are
              samples.
            </span>
            <a href={demo}>
              Try the table <ArrowRight size={13} />
            </a>
          </div>
        </section>
        <div className="platform-strip wrap">
          <span>YOUR HARDWARE, TOGETHER</span>
          <strong>Roku</strong>
          <strong>Android & Android TV</strong>
          <strong>Apple simulators</strong>
          <strong>USB / HDMI inputs</strong>
          <span>Capabilities vary by device.</span>
        </div>
        <section id="workspace" className="wrap section">
          <div className="section-intro">
            <div className="eyebrow">THE DEVICE TABLE</div>
            <h2>
              Know what’s ready.
              <br />
              Know who’s using it.
            </h2>
            <p>
              A friendly name is the starting point. Connection health,
              maintenance locks and reservations each have their own state, so a
              disconnected device never looks like a busy one.
            </p>
          </div>
          <div className="feature-grid">
            <article>
              <Monitor />
              <h3>Find the right device</h3>
              <p>
                Combine search, platform, health, reserved or free, maintenance,
                physical or virtual, and local or shared filters. Save views you
                use often.
              </p>
            </article>
            <article>
              <Usb />
              <h3>Pair the right input</h3>
              <p>
                Choose a capture card from a simulated host discovery list.
                Native emulator screens need no USB card. Conflicting bindings
                are called out.
              </p>
            </article>
            <article>
              <LockKeyhole />
              <h3>Keep ownership visible</h3>
              <p>
                See owner and reason in the table. Select rows for eligible bulk
                lock, unlock or restart. Releasing a session and unlocking
                maintenance are distinct actions.
              </p>
            </article>
          </div>
          <div className="workflow">
            <span>
              <b>01</b> Find
            </span>
            <ChevronRight />
            <span>
              <b>02</b> Reserve
            </span>
            <ChevronRight />
            <span>
              <b>03</b> View & control
            </span>
            <ChevronRight />
            <span>
              <b>04</b> Capture
            </span>
            <ChevronRight />
            <span>
              <b>05</b> Release
            </span>
          </div>
        </section>
        <section id="capture" className="viewer-section">
          <div className="wrap">
            <div className="split-heading">
              <div>
                <div className="eyebrow">A FOCUSED DEVICE VIEWER</div>
                <h2>
                  The screen, the remote,
                  <br />
                  and the evidence.
                </h2>
              </div>
              <p>
                Open a device from the table and see its input source, ownership
                and capture controls together. Hover, focus or tap Preview for a
                quick look before opening a session.
              </p>
            </div>
            <div className="viewer-showcase">
              <a href="/demo/#viewer/roku-desk">
                <img
                  src="/assets/session-preview.webp"
                  alt="Actual Device Deck focused viewer with fictional TV image, remote control, session ownership and input timeline"
                  loading="lazy"
                />
              </a>
            </div>
            <div className="feature-grid compact-features">
              <article>
                <Keyboard />
                <h3>Make every press visible</h3>
                <p>
                  Optional keypress overlay and input logging tie commands to
                  device, session and recording elapsed time. Export the
                  simulated log as JSON.
                </p>
              </article>
              <article>
                <Camera />
                <h3>Choose clean or annotated</h3>
                <p>
                  Review screenshot and recording flows with an optional key
                  overlay. Copy a labelled sample PNG to your browser clipboard,
                  or download it if copying is unavailable.
                </p>
              </article>
              <article>
                <LayoutGrid />
                <h3>Control the selected tile</h3>
                <p>
                  Open selected devices as a grid. One highlighted tile receives
                  remote commands. Its session, capture controls and input
                  timeline follow your selection.
                </p>
              </article>
            </div>
            <div className="multi-showcase">
              <div>
                <div className="eyebrow">MULTI-DEVICE VIEW</div>
                <h3>
                  Several screens.
                  <br />
                  One explicit target.
                </h3>
                <p>
                  Compare physical devices and simulators side by side. Switch
                  the active device with a click, tap or keyboard focus.
                </p>
                <a
                  className="text-link"
                  href="/demo/#multi/roku-desk,apple-sim,pixel-emulator,android-tv"
                >
                  Explore the grid <ArrowRight size={16} />
                </a>
              </div>
              <a href="/demo/#multi/roku-desk,apple-sim,pixel-emulator,android-tv">
                <img
                  src="/assets/multi-preview.webp"
                  alt="Actual multi-device prototype showing four separate device tiles and a single control target"
                  loading="lazy"
                />
              </a>
            </div>
          </div>
        </section>
        <section className="section wrap local-section">
          <div className="section-intro">
            <div className="eyebrow">CAPTURES STAY LOCAL</div>
            <h2>One folder for the whole session.</h2>
            <p>
              Web, CLI and agent outputs belong in the same configurable Mac
              folder. Name, tag and find evidence by device, type, time or
              origin. Shared output does not mean cloud storage.
            </p>
          </div>
          <div className="local-layout">
            <div className="folder-card">
              <Folder size={32} />
              <code>~/Movies/Device Deck</code>
              <span>Screenshot & video output folder</span>
              <div>
                <b>Web</b>
                <b>CLI</b>
                <b>Agents</b>
              </div>
              <p>
                Proposed local output. This website remembers the setting but
                cannot write to that Mac folder.
              </p>
            </div>
            <div className="local-copy">
              <h3>Enough context to find it again.</h3>
              <p>
                The library shows names, tags, devices, origins and video
                durations. Rename and tag entries, remove a selection, and undo
                a removal. Jump from a session to its captures.
              </p>
              <h3>Set it once on this Mac.</h3>
              <p>
                Choose the folder, naming pattern, clipboard behavior and
                evidence defaults. Browser demo settings persist locally, with
                Reset demo always available.
              </p>
              <h3>See how devices were used.</h3>
              <p>
                Usage history tracks owners, reasons, locks, restarts and
                captures. The reporting screen explores seeded reserved time,
                contention and capture failures.
              </p>
              <a className="text-link" href="/demo/#captures">
                Open the capture library <ArrowRight size={16} />
              </a>
            </div>
          </div>
        </section>
        <section id="cli" className="cli-section">
          <div className="wrap cli-layout">
            <div>
              <div className="eyebrow">CLI, BROWSER, API, JSON & MCP</div>
              <h2>
                Call it by name.
                <br />
                Use your own workflow.
              </h2>
              <p>
                The intended local service gives humans and agents the same
                inventory, reservations, input controls and capture library. It
                works independently of a specific app framework or job runner.
              </p>
              <ul>
                <li>
                  <Check /> Friendly-name remote targeting for configured
                  devices with supported input.
                </li>
                <li>
                  <Check /> Interactive device picker when no target is
                  supplied, with platform, name and state filters.
                </li>
                <li>
                  <Check /> Scriptable selectors and JSON. No match and
                  ambiguous match are explicit errors.
                </li>
                <li>
                  <Check /> No accounts. Human, agent and job names are owner
                  labels.
                </li>
              </ul>
              <p className="cli-note">
                Examples are illustrative. The present CLI and MCP implement
                health and empty inventory only. The browser does not execute
                the proposed macOS clipboard command.
              </p>
            </div>
            <div className="code-window">
              <div className="code-header">
                <Terminal size={15} />
                <span>Client workflow</span>
                <b>ILLUSTRATIVE</b>
              </div>
              <div
                className="code-tabs"
                role="tablist"
                aria-label="Integration examples"
              >
                {["CLI", "MCP", "API", "JSON"].map((t) => (
                  <button
                    role="tab"
                    aria-selected={tab === t}
                    key={t}
                    onClick={() => {
                      setTab(t);
                      setCopied(false);
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <pre>{examples[tab]}</pre>
              <button
                className="copy-button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(examples[tab]);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
                {copied ? "Copied" : "Copy example"}
              </button>
            </div>
          </div>
        </section>
        <section id="status" className="section wrap status-section">
          <div className="section-intro">
            <div className="eyebrow">DEVELOPMENT STATUS</div>
            <h2>
              A working product preview.
              <br />
              Hardware comes next.
            </h2>
            <p>
              You can explore the complete interaction design today. The screens
              use clearly labelled samples and never connect to your local
              devices.
            </p>
          </div>
          <div className="status-grid">
            <article>
              <span className="status-label">WORKING IN THE BROWSER</span>
              <h3>Try the workspace</h3>
              <ul>
                <li>Device table, combined filters and saved views</li>
                <li>Add/edit, source validation and bulk action simulation</li>
                <li>Focused viewer, multi-view and single-target input</li>
                <li>Capture metadata, tags, removal and undo</li>
                <li>Sample-image clipboard and download</li>
                <li>Local settings, session history and seeded reports</li>
              </ul>
            </article>
            <article>
              <span className="status-label planned">FUTURE LOCAL APP</span>
              <h3>Connect real hardware</h3>
              <ul>
                <li>Real device and capture-card discovery</li>
                <li>Capability-specific remote input adapters</li>
                <li>Live preview and playable recordings</li>
                <li>Durable exclusive reservations across clients</li>
                <li>Shared Mac folder and native clipboard helper</li>
                <li>Local service installation and packaging</li>
              </ul>
            </article>
          </div>
          <p className="status-footnote">
            Initial scope is one Mac with your own devices and emulators.
            Local/shared visibility is represented in the design; multi-host
            coordination is future work. Discovering physical Apple hardware
            does not establish remote-control support.
          </p>
        </section>
        <section className="closing">
          <div className="wrap">
            <div>
              <h2>
                Find a device.
                <br />
                Start a session.
              </h2>
              <p>Explore the revised workspace on desktop or mobile.</p>
            </div>
            <a className="button primary" href={demo}>
              Open interactive demo <ArrowRight size={17} />
            </a>
          </div>
        </section>
      </main>
      <footer className="wrap">
        <Brand />
        <p>Device Deck is a TantaWowa product preview.</p>
        <span>Local by design · no login · no cloud file storage</span>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
