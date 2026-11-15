import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import GithubSlugger from "github-slugger";

const repository = "https://github.com/TantaWowa/device-deck";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const navigation = [
  ["Start here", [["README", "Overview"], ["install", "Install on Mac"], ["using-device-deck", "Your first session"], ["compatibility", "Device compatibility"]]],
  ["Use your devices", [["live-video-and-touch", "Video and touch"], ["simulator-controls", "Simulators and emulators"], ["physical-ios", "Physical iPhone and iPad"], ["reports-and-capture-cards", "Reports and capture cards"]]],
  ["Share and automate", [["agent-device-workflow", "Coding agents"], ["group-reservations", "CI device groups"], ["api", "CLI, API and MCP"], ["deck-sharing", "Connect another Deck"], ["remote-access", "Remote access and portal"], ["team-rollout", "Team setup"]]],
  ["Contribute", [["contributing", "Contribution guide"], ["development", "Build from source"], ["architecture", "Architecture"], ["validation", "Validation records"]]],
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function plainText(tokens) {
  return tokens.map((token) => token.tokens ? plainText(token.tokens) : token.text ?? token.raw ?? "").join("");
}

function pageFor(source) {
  if (source === "CONTRIBUTING.md") return "/docs/contributing/";
  if (source === "docs/README.md") return "/docs/";
  return `/docs/${path.posix.basename(source, ".md")}/`;
}

function headings(markdown) {
  const slugger = new GithubSlugger();
  return new Marked().lexer(markdown).filter((token) => token.type === "heading").map((token) => ({
    text: plainText(token.tokens), depth: token.depth, id: slugger.slug(plainText(token.tokens)),
  }));
}

/** Render checked-in Markdown once for both the development server and static hosting. */
export function createDocsSite(repositoryRoot = root) {
  const sources = readdirSync(path.join(repositoryRoot, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`);
  if (!sources.includes("docs/README.md")) throw new Error("The documentation index docs/README.md is missing.");
  if (existsSync(path.join(repositoryRoot, "CONTRIBUTING.md"))) sources.push("CONTRIBUTING.md");
  const documents = new Map(sources.map((source) => {
    const markdown = readFileSync(path.join(repositoryRoot, source), "utf8");
    return [source, { markdown, headings: headings(markdown), route: pageFor(source) }];
  }));
  const files = new Map();
  const headingCache = new Map([...documents].map(([source, doc]) => [source, new Set(doc.headings.map((heading) => heading.id))]));

  function resolveLink(href, source, image = false) {
    if (/^(?:https?:|mailto:)/i.test(href)) return href;
    if (href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) throw new Error(`${source}: unsupported link ${href}`);
    if (href.startsWith("/")) return href;
    const [pathnameAndQuery, fragment] = href.split("#", 2);
    const [pathname, query] = pathnameAndQuery.split("?", 2);
    const target = pathname ? path.posix.normalize(path.posix.join(path.posix.dirname(source), decodeURIComponent(pathname))) : source;
    const absolute = path.resolve(repositoryRoot, target);
    if (!absolute.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`) || !existsSync(absolute)) {
      throw new Error(`${source}: missing local link ${href}`);
    }
    if (fragment && target.endsWith(".md")) {
      if (!headingCache.has(target)) headingCache.set(target, new Set(headings(readFileSync(absolute, "utf8")).map((heading) => heading.id)));
      if (!headingCache.get(target).has(decodeURIComponent(fragment))) throw new Error(`${source}: missing heading in ${href}`);
    }
    const suffix = `${query === undefined ? "" : `?${query}`}${fragment === undefined ? "" : `#${fragment}`}`;
    if (!pathname) return suffix || "#";
    if (documents.has(target)) return `${documents.get(target).route}${suffix}`;
    if (target.startsWith("docs/") && target.endsWith(".json")) {
      files.set(target, readFileSync(absolute));
      return `/${target}${suffix}`;
    }
    if (image && target.startsWith("apps/website/public/")) return `/${target.slice("apps/website/public/".length)}${suffix}`;
    const encoded = target.split("/").map(encodeURIComponent).join("/");
    return `${image ? "https://raw.githubusercontent.com/TantaWowa/device-deck/main" : `${repository}/blob/main`}/${encoded}${suffix}`;
  }

  for (const [source, document] of documents) {
    const slugger = new GithubSlugger();
    const toc = document.headings.filter((heading) => heading.depth === 2);
    const contents = toc.length > 2 ? `<details class="page-contents"><summary>On this page</summary><ul>${toc.map((heading) => `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`).join("")}</ul></details>` : "";
    let firstHeading = true;
    const markdown = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth }) {
          const id = slugger.slug(plainText(tokens));
          const html = `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}<a class="heading-link" href="#${escapeHtml(id)}" aria-label="Link to ${escapeHtml(plainText(tokens))}">#</a></h${depth}>\n`;
          const showContents = firstHeading && depth === 1;
          firstHeading = false;
          return html + (showContents ? contents : "");
        },
        link({ href, title, tokens }) {
          return `<a href="${escapeHtml(resolveLink(href, source))}"${title ? ` title="${escapeHtml(title)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
        },
        image({ href, title, text }) {
          return `<img src="${escapeHtml(resolveLink(href, source, true))}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy">`;
        },
        html({ text }) { return escapeHtml(text); },
        table(token) { return `<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table">${this.constructor.prototype.table.call(this, token)}</div>`; },
      },
    });
    const body = markdown.parse(document.markdown);
    const title = document.headings[0]?.text ?? path.basename(source, ".md");
    const nav = navigation.map(([label, entries]) => {
      const links = entries.map(([slug, name]) => {
        const candidate = slug === "contributing" ? "CONTRIBUTING.md" : `docs/${slug}.md`;
        if (!documents.has(candidate)) return "";
        const route = documents.get(candidate).route;
        return `<li><a href="${route}"${source === candidate ? ' aria-current="page"' : ""}>${escapeHtml(name)}</a></li>`;
      }).join("");
      return `<div class="nav-group"><p>${label}</p><ul>${links}</ul></div>`;
    }).join("");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escapeHtml(title)}. Device Deck guides and reference for the open-source Mac device workspace."><meta name="theme-color" content="#fcfdff"><title>${escapeHtml(title)} · Device Deck</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/docs/docs.css"></head>
<body><a class="skip-link" href="#main">Skip to content</a><header class="docs-header"><a class="brand" href="/">Device <span>Deck</span></a><nav aria-label="Website"><a href="/docs/" aria-current="location">Docs</a><a href="/install">Install</a><a href="${repository}">GitHub</a></nav></header>
<div class="docs-layout"><aside class="docs-sidebar"><details id="docs-navigation" open><summary>Documentation</summary><nav aria-label="Documentation">${nav}</nav></details></aside>
<script>if (window.matchMedia("(max-width: 680px)").matches) document.getElementById("docs-navigation").open = false;</script>
<main id="main" tabindex="-1"><p class="page-meta">Device Deck documentation <a href="${repository}/blob/main/${source}">View Markdown source</a></p><article>${body}</article><footer class="docs-footer"><a href="/docs/contributing/">Improve these docs</a><a href="${repository}/issues/new/choose">Report a problem</a><span>Free and open source · MIT</span></footer></main></div></body></html>`;
    files.set(`${document.route.slice(1)}index.html`, html);
  }
  files.set("docs/docs.css", readFileSync(path.join(repositoryRoot, "apps/website/src/docs.css"), "utf8"));
  return files;
}

export function docsFileForRequest(url) {
  const pathname = new URL(url, "http://localhost").pathname;
  if (pathname !== "/docs" && !pathname.startsWith("/docs/")) return null;
  const file = pathname.replace(/^\//, "");
  if (file === "docs") return "docs/index.html";
  if (file.endsWith("/")) return `${file}index.html`;
  if (!path.posix.extname(file)) return `${file}/index.html`;
  return file;
}

export function deviceDeckDocs() {
  return {
    name: "device-deck-docs",
    configureServer(server) {
      server.watcher.add([path.join(root, "docs"), path.join(root, "CONTRIBUTING.md")]);
      server.middlewares.use(async (request, response, next) => {
        const file = docsFileForRequest(request.url ?? "/");
        if (!file) return next();
        try {
          const content = createDocsSite().get(file);
          response.setHeader("Cache-Control", "no-cache");
          if (content === undefined) {
            response.statusCode = 404;
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            return response.end('<h1>Documentation page not found</h1><p><a href="/docs/">Browse the documentation</a></p>');
          }
          response.setHeader("Content-Type", file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".json") ? "application/json; charset=utf-8" : "text/html; charset=utf-8");
          response.end(file.endsWith(".html") ? await server.transformIndexHtml(request.url ?? "/docs/", String(content)) : content);
        } catch (error) {
          next(error);
        }
      });
    },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(path.join(root, "docs") + path.sep) || file === path.join(root, "CONTRIBUTING.md") || file === path.join(root, "apps/website/src/docs.css")) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
    },
    generateBundle() {
      for (const [fileName, source] of createDocsSite()) this.emitFile({ type: "asset", fileName, source });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = createDocsSite();
  const output = process.argv.indexOf("--out");
  if (output !== -1) {
    if (!process.argv[output + 1]) throw new Error("--out requires a destination directory");
    const destination = path.resolve(process.argv[output + 1]);
    for (const [name, content] of files) {
      const target = path.join(destination, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  console.log(`Validated ${[...files.keys()].filter((name) => name.endsWith(".html")).length} documentation pages and their local links.`);
}
