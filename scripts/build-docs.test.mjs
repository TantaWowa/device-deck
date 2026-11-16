import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocsSite, docsFileForRequest } from "./build-docs.mjs";

function fixture(t, files) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "device-deck-docs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ "apps/website/src/docs.css": "body {}", ...files })) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), source);
  }
  return directory;
}

test("publishes readable Markdown and preserves local links across the website and GitHub", (t) => {
  const directory = fixture(t, {
    "docs/README.md": "# Device Deck guides\n\n[Guide](guide.md#try-code-again) · [Contribute](../CONTRIBUTING.md) · [Schema](device-deck.schema.json) · [Build](../README.md#build-from-source)\n",
    "docs/guide.md": "# A guide\n\n## Try `code` again\n\n| Device | Input |\n| --- | --- |\n| Roku | Keys |\n\n```sh\ndevdeck doctor\n```\n\n## Try `code` again\n\n[Second heading](#try-code-again-1)\n\n![Devices](../apps/website/public/assets/example.png)\n",
    "docs/device-deck.schema.json": '{"type":"object"}',
    "CONTRIBUTING.md": "# Contributing\n\n[Guides](docs/README.md)\n",
    "README.md": "# Device Deck\n\n## Build from source\n",
    "apps/website/public/assets/example.png": "image fixture",
  });
  const files = createDocsSite(directory);
  const index = files.get("docs/index.html");
  const guide = files.get("docs/guide/index.html");
  assert.match(index, /href="\/docs\/guide\/#try-code-again"/);
  assert.match(index, /href="\/docs\/contributing\/"/);
  assert.match(index, /href="\/docs\/device-deck.schema.json"/);
  assert.match(index, /href="https:\/\/github.com\/TantaWowa\/device-deck\/blob\/main\/README.md#build-from-source"/);
  assert.match(guide, /<h2 id="try-code-again-1">/);
  assert.match(guide, /class="table-scroll"[^>]*><table>/);
  assert.match(guide, /<pre><code class="language-sh">devdeck doctor/);
  assert.match(guide, /src="\/assets\/example.png"/);
  assert.ok(files.has("docs/contributing/index.html"));
  assert.equal(files.get("docs/device-deck.schema.json").toString(), '{"type":"object"}');
});

test("fails the build on missing files and heading fragments", (t) => {
  const directory = fixture(t, { "docs/README.md": "# Docs\n\n[Missing](missing.md)\n" });
  assert.throws(() => createDocsSite(directory), /docs\/README.md: missing local link missing.md/);
  writeFileSync(path.join(directory, "docs/README.md"), "# Docs\n\n[Missing](#does-not-exist)\n");
  assert.throws(() => createDocsSite(directory), /missing heading in #does-not-exist/);
});

test("escapes raw HTML and refuses executable URL schemes", (t) => {
  const directory = fixture(t, { "docs/README.md": '# Docs\n\n<script>alert("example")</script>\n' });
  assert.match(createDocsSite(directory).get("docs/index.html"), /&lt;script&gt;alert\(&quot;example&quot;\)&lt;\/script&gt;/);
  writeFileSync(path.join(directory, "docs/README.md"), '# Docs\n\n[Example](javascript:alert)\n');
  assert.throws(() => createDocsSite(directory), /unsupported link javascript:alert/);
});

test("maps direct documentation URLs while leaving the app routes alone", () => {
  assert.equal(docsFileForRequest("/docs"), "docs/index.html");
  assert.equal(docsFileForRequest("/docs/"), "docs/index.html");
  assert.equal(docsFileForRequest("/docs/api?source=nav"), "docs/api/index.html");
  assert.equal(docsFileForRequest("/docs/api/"), "docs/api/index.html");
  assert.equal(docsFileForRequest("/docs/api/index.html"), "docs/api/index.html");
  assert.equal(docsFileForRequest("/docs/docs.css"), "docs/docs.css");
  assert.equal(docsFileForRequest("/docs/operations.schema.json"), "docs/operations.schema.json");
  assert.equal(docsFileForRequest("/app/"), null);
  assert.equal(docsFileForRequest("/docs-other"), null);
  assert.equal(docsFileForRequest("/docs/../package.json"), null);
});

test("renders collapsed copyable prompts, escapes their contents and preserves other code blocks", (t) => {
  const directory = fixture(t, {
    "docs/README.md": "# Docs\n",
    "docs/agent-setup.md": '# Set up with an agent\n\n```prompt Install <Device Deck> & "tools"\nKeep <existing> devices & settings.\n<script>alert("unsafe")</script>\n```\n\n```prompt\nA second prompt.\n```\n\n```promptly\nOrdinary code.\n```\n',
  });
  const files = createDocsSite(directory);
  const page = files.get("docs/agent-setup/index.html");
  assert.equal((page.match(/<details class="agent-prompt">/g) ?? []).length, 2);
  assert.doesNotMatch(page, /<details class="agent-prompt"[^>]*\bopen\b/);
  assert.match(page, /<summary>Install &lt;Device Deck&gt; &amp; &quot;tools&quot;<\/summary>/);
  assert.match(page, /aria-label="Copy prompt: Install &lt;Device Deck&gt; &amp; &quot;tools&quot;" hidden/);
  assert.match(page, /<summary>Agent prompt<\/summary>/);
  assert.match(page, /Keep &lt;existing&gt; devices &amp; settings\.\n&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;/);
  assert.match(page, /<pre><code class="language-promptly">Ordinary code\./);
  assert.match(page, /role="status" aria-live="polite"/);
  assert.match(page, /navigator\.clipboard\.writeText\(code\.textContent\)/);
  assert.match(page, /range\.selectNodeContents\(code\)/);
  assert.match(page, /href="\/docs\/agent-setup\/" aria-current="page">Set up with an agent/);
  assert.doesNotMatch(files.get("docs/index.html"), /navigator\.clipboard/);
});
