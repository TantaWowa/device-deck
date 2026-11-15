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
