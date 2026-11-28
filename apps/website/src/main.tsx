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
function App() {
  const [menu, setMenu] = useState(false);
  const [tab, setTab] = useState("CLI");
  const [copied, setCopied] = useState(false);
  const examples: Record<string, string> = {
    CLI: `# Open the local Mac dashboard
devdeck ui

# Watch USB feeds together, or browse with Left/Right
devdeck view --mux
devdeck view

# Filter configured devices for scripts
devdeck devices --platform Roku --state free --json

# Open a terminal remote for a configured device
devdeck remote --device "Desk Roku" --reason "Check playback"

# Or use the fixed-screen terminal workspace
devdeck tui`,
    MCP: `// MCP tool calls; use your configured device name
inventory({})
sessions_reserve({
  selector: { device: "Desk Roku" },
  owner: "Agent",
  reason: "Check playback"
})

// Use session.id and leaseToken returned above
remote_input({
  sessionId: "SESSION_ID",
  leaseToken: "LEASE_TOKEN",
  key: "Home"
})
sessions_release({
  sessionId: "SESSION_ID",
  leaseToken: "LEASE_TOKEN"
})`,
    API: `POST /v1/operations/sessions.reserve
Authorization: Bearer LOCAL_API_TOKEN
Content-Type: application/json

{
  "selector": { "device": "Desk Roku" },
  "owner": "Agent",
  "reason": "Check playback",
  "ttlMinutes": 15
}

# The response contains session.id and leaseToken.
# Use both for remote.input, captures.screenshot
# and sessions.release at /v1/operations/NAME.`,
    JSON: `{
  "schemaVersion": 1,
  "devices": [],
  "sources": [],
  "settings": {
    "folder": "~/Movies/Device Deck",
    "owner": "You",
    "captureMode": "clean",
    "logging": true
  }
}`,
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
            ["#remote-access", "Remote access"],
            ["#capture", "Capture"],
            ["#cli", "CLI & agents"],
            ["/docs/agent-setup/", "Agent setup"],
            ["/docs/", "Docs"],
            ["https://github.com/TantaWowa/device-deck", "GitHub"],
          ].map(([href, label]) => (
            <a href={href} key={href} onClick={() => setMenu(false)}>
              {label}
            </a>
          ))}
        </nav>
        <a className="button small primary header-demo" href="/install">
          Download for Mac <ArrowRight size={14} />
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
            Apple silicon · macOS 14 or later
          </div>
          <h1>
            An open-source workspace
            <br />
            for your device lab.
          </h1>
          <p className="hero-copy">
            Reserve TVs, phones and simulators from your Mac. Watch their screens,
            send input and record a test run. Sign in with Google to control a
            paired Mac’s devices from your phone or browser.
          </p>
          <div className="hero-actions">
            <a className="button primary" href="/install">
              Download for Mac <ArrowRight size={17} />
            </a>
            <a className="button" href="/app/">
              Open web portal
            </a>
          </div>
          <p className="source-note">
            Free under the{" "}
            <a href="https://github.com/TantaWowa/device-deck/blob/main/LICENSE">MIT license</a>.
            {" "}<a href="https://github.com/TantaWowa/device-deck">View source on GitHub</a>.
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
              <span className="window-tag">CURRENT MAC APP</span>
            </div>
            <a
              href="/assets/devices-current.png"
              aria-label="View current Devices screenshot full size"
            >
              <img
                src="/assets/devices-current.png"
                width={1500}
                height={1000}
                alt="Current Device Deck Devices list with platform and Sim/Real filters, simulator controls and capture actions, shown with fictional demo data"
                fetchPriority="high"
              />
            </a>
          </div>
          <div className="screenshot-caption">
            <span>
              Current Mac app · fictional demo devices, owners and feeds.
            </span>
            <a href="/assets/devices-current.png">
              View full-size screenshot <ArrowRight size={13} />
            </a>
          </div>
        </section>
        <div className="platform-strip wrap">
          <span>YOUR HARDWARE, TOGETHER</span>
          <strong>Roku</strong>
          <strong>Android & Android TV</strong>
          <strong>Apple simulators</strong>
          <strong>USB / HDMI inputs</strong>
          <a href="/docs/compatibility/">Check device support</a>
        </div>
        <section id="remote-access" className="wrap section remote-section">
          <h2>Control your devices from another screen.</h2>
          <div className="connection-options">
            <article>
              <h3>Pair a Mac with the web portal</h3>
              <p>
                Sign in with Google or email and password on your phone or computer.
                You can pair several Macs with one account and switch between them.
              </p>
              <ol>
                <li>Set up a trusted HTTPS address for the Mac that your browser can reach over your LAN or VPN.</li>
                <li>Run <code>devdeck pair</code> on that Mac for a single-use code.</li>
                <li>Choose <strong>Add machine</strong> in the portal and enter the address and code.</li>
              </ol>
              <p>
                Open a live feed, reserve the device and use its remote or touch
                controls where supported. Your browser connects directly to the
                Mac, where screenshots and recordings are saved.
              </p>
              <a href="/app/">Open the web portal</a>
              <a href="/docs/remote-access/#pair-a-machine">Pairing guide</a>
            </article>
            <article>
              <h3>Link two Decks</h3>
              <p>
                To use hardware attached to another Mac, grant access on that Mac
                and add its Deck to yours. Choose it in the dashboard’s{" "}
                <strong>Device host</strong> menu or select it by name in the CLI or MCP.
              </p>
              <p>
                A Roku and its USB capture card can stay plugged into the lab Mac
                while you test from your desk. The lab Mac manages the reservation
                and keeps the recording. You can revoke the link there at any time.
              </p>
              <a href="/docs/deck-sharing/">Connect another Mac’s Deck</a>
            </article>
          </div>
        </section>
        <section id="workspace" className="wrap section">
          <div className="section-intro">
            <div className="eyebrow">THE DEVICE TABLE</div>
            <h2>
              Find an available device.
            </h2>
            <p>
              The device table shows which devices are online, who holds each
              reservation and which devices are locked for maintenance.
            </p>
          </div>
          <div className="feature-grid">
            <article>
              <Monitor />
              <h3>Find the right device</h3>
              <p>
                Filter by platform or device type, switch between physical and
                virtual devices, or save a view of the hardware you use most.
              </p>
            </article>
            <article>
              <Usb />
              <h3>Pair the right input</h3>
              <p>
                Bind a USB capture card to a TV, or view supported simulators and
                Android devices through their native screen feeds.
              </p>
            </article>
            <article>
              <LockKeyhole />
              <h3>Keep ownership visible</h3>
              <p>
                See owner and reason alongside each device. Launch or close
                supported simulators from the list. Active sessions and
                recordings must finish before a simulator closes.
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
                Open a remote from any feed or device row. Drag the compact
                panel beside or over the picture, resize it to fit, and keep the
                device in view while you work.
              </p>
            </div>
            <div className="viewer-showcase">
              <a
                href="/assets/remote-current.png"
                aria-label="View current compact remote screenshot full size"
              >
                <img
                  src="/assets/remote-current.png"
                  width={1500}
                  height={1000}
                  alt="Current Device Deck feed with a compact floating remote, text entry and keyboard input controls, shown with a fictional sample feed"
                  loading="lazy"
                />
              </a>
            </div>
            <div className="screenshot-caption">
              <span>
                Current Mac app · compact remote over a fictional sample feed.
              </span>
              <a href="/assets/remote-current.png">
                View full-size screenshot <ArrowRight size={13} />
              </a>
            </div>
            <div className="feature-grid compact-features">
              <article>
                <Keyboard />
                <h3>Keep the controls close</h3>
                <p>
                  Direction and playback buttons, text entry and Keyboard input
                  stay on the remote. Its menu holds session details, capture
                  settings and platform styles. Position and size are remembered.
                </p>
              </article>
              <article>
                <Camera />
                <h3>Capture from every feed</h3>
                <p>
                  Identify, Record, Screenshot, Reserve and Remote appear on
                  every feed and device row. Quick capture settings can reserve
                  an available device and save its image or start recording.
                </p>
              </article>
              <article>
                <LayoutGrid />
                <h3>Respect the current session</h3>
                <p>
                  See who reserved a device before you use it. Ending a session
                  or taking it over finishes its recording on the host.
                </p>
              </article>
            </div>
            <div className="multi-showcase">
              <div>
                <div className="eyebrow">USB SPLIT SCREEN</div>
                <h3>
                  Several screens.
                  <br />
                  One workspace.
                </h3>
                <p>
                  Watch selected USB capture inputs side by side, or browse one
                  feed at a time with Left/Right. Open the compact remote for a
                  connected target when you want to control it.
                </p>
                <a
                  className="text-link"
                  href="/demo/#multi/roku-desk,apple-sim,pixel-emulator,android-tv"
                >
                  Explore demo grid <ArrowRight size={16} />
                </a>
              </div>
              <div className="multi-image">
                <a
                  href="/assets/feeds-current.png"
                  aria-label="View current USB split-screen screenshot full size"
                >
                  <img
                    src="/assets/feeds-current.png"
                    width={1500}
                    height={1000}
                    alt="Current Device Deck USB split-screen feeds with capture actions on every tile, shown with fictional sample feeds"
                    loading="lazy"
                  />
                </a>
                <div className="screenshot-caption">
                  <span>Current Mac app · fictional sample USB feeds.</span>
                  <a href="/assets/feeds-current.png">
                    View full-size screenshot <ArrowRight size={13} />
                  </a>
                </div>
              </div>
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
              origin.
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
                The installed Mac app saves here. The earlier browser prototype
                uses sample captures and cannot write to this folder.
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
                evidence defaults in Settings. The web app, CLI, TUI and agents
                share the same local configuration.
              </p>
              <h3>See how devices were used.</h3>
              <p>
                Usage history tracks owners, reasons, locks, restarts and
                captures. Reports show actual reservations, capture outcomes
                and contention for the day, week, month or a custom date range.
              </p>
              <a className="text-link" href="/demo/#captures">
                Explore demo capture library <ArrowRight size={16} />
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
                The local service gives humans and agents the same inventory,
                reservations, input controls and capture library. It works
                independently of a specific app framework or job runner.
              </p>
              <ul>
                <li>
                  <Check /> Friendly-name remote targeting for configured
                  devices with supported input.
                </li>
                <li>
                  <Check /> Inspect supported UI trees, read device logs and
                  launch the app under test during a reservation.
                </li>
                <li>
                  <Check /> Scriptable selectors and JSON. No match and
                  ambiguous match are explicit errors.
                </li>
                <li>
                  <Check /> Reserve a complete device group, start its virtual
                  devices, and pass their identifiers to your existing test runner.
                </li>
                <li>
                  <Check /> Work locally without signing in. The reservation
                  identifies its owner and supplies credentials for control.
                </li>
              </ul>
              <p className="cli-note">
                Supported by the installed Mac beta. Replace sample device
                names with your own. HTTP uses the local endpoint and API token;
                control and capture require the reservation’s session ID and
                lease token. The earlier browser prototype is separate.
              </p>
              <p>
                <a href="/docs/api/#mcp-walkthrough">Connect an MCP client</a>
                {" · "}
                <a href="/docs/group-reservations/">Set up device groups for CI</a>
              </p>
            </div>
            <div className="code-window">
              <div className="code-header">
                <Terminal size={15} />
                <span>Client workflow</span>
                <b>MAC BETA</b>
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
            <h2>Run a shared lab on your Mac.</h2>
            <p>
              The signed, notarized installer includes the dashboard, CLI and
              recording tools. Allow your teammates’ local Mac accounts and CI
              runners to use the same service.
            </p>
          </div>
          <div className="status-grid">
            <article>
              <h3>Keep test devices ready</h3>
              <ul>
                <li>Check device health across connected Decks.</li>
                <li>Enable health monitoring to recover an idle, unresponsive Deck-launched Android emulator.</li>
                <li>Enable app cleanup to remove newly installed test apps after a reservation on supported devices.</li>
              </ul>
              <a className="text-link" href="/docs/simulator-controls/#fleet-health-and-reservation-app-cleanup">Configure health checks and cleanup</a>
            </article>
            <article>
              <h3>Run tests on a group of devices</h3>
              <ul>
                <li>Reserve the full device set together for a CI run.</li>
                <li>Pass Android serials or Apple simulator UDIDs to your test runner.</li>
                <li>Keep virtual devices warm between jobs or shut them down after release.</li>
              </ul>
              <a className="text-link" href="/docs/group-reservations/">Set up a CI device group</a>
            </article>
          </div>
          <p className="status-footnote">
            To try an earlier version of the interface with sample devices,
            open the <a href="/demo/">interactive demo</a>.
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
              <p>Follow the setup guide and save your first device capture.</p>
            </div>
            <a className="button primary" href="/docs/">
              Read the docs <ArrowRight size={17} />
            </a>
          </div>
        </section>
      </main>
      <footer className="wrap">
        <Brand />
        <p>Device Deck is free and open source under the MIT license.</p>
        <span>
          <a href="/docs/">Documentation</a> ·{" "}
          <a href="/docs/contributing/">Contribute</a> · Captures stay on your host
        </span>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
