import test from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../../../packages/core/src/local/types";
import { tailscaleBrowserUrl, tailscaleCommand, type TailscaleDependencies } from "./tailscale";

const hostname = "deck.example.ts.net";
const origin = `https://${hostname}`;
const backend = "http://127.0.0.1:47831";
function mapping(port = 443, target = backend) {
  return { TCP: { [port]: { HTTPS: true } }, Web: { [`${hostname}:${port}`]: { Handlers: { "/": { Proxy: target } } } } };
}
function fixture() {
  let config: any = configSchema.parse({ schemaVersion: 1, settings: { folder: "~/Movies/Device Deck" } });
  let serve: any = {};
  let status: any = { BackendState: "Running", Self: { DNSName: `${hostname}.`, UserID: 123 }, User: { "123": { LoginName: "owner@example.com" } } };
  const events: string[] = [];
  const commands: string[][] = [];
  let saveError: Error | undefined;
  let runError: Error | undefined;
  let verificationOverride: object | undefined;
  const deps: TailscaleDependencies = {
    endpoint: async () => ({ port: 47831 }),
    callOperation: async (operation, args) => {
      events.push(operation);
      if (operation === "config.get") return { config: structuredClone(config), revision: "current-revision" };
      assert.equal(operation, "config.save");
      assert.equal((args as any).revision, "current-revision");
      if (saveError) throw saveError;
      config = structuredClone((args as any).config);
      return { config, revision: "updated-revision" };
    },
    run: async (args) => {
      commands.push(args);
      events.push(args.join(" "));
      if (args[0] === "status") return JSON.stringify(status);
      if (args[1] === "status") return JSON.stringify(serve);
      if (runError) throw runError;
      const port = Number(args.find((value) => value.startsWith("--https="))?.slice(8));
      if (args.at(-1) === "off") {
        delete serve.TCP?.[port];
        delete serve.Web?.[`${hostname}:${port}`];
      } else {
        const added = mapping(port, args.at(-1));
        serve = verificationOverride || { ...serve, TCP: { ...serve.TCP, ...added.TCP }, Web: { ...serve.Web, ...added.Web } };
      }
      return "";
    },
  };
  return {
    deps, events, commands,
    get config() { return config; },
    set config(value: any) { config = value; },
    get serve() { return serve; },
    set serve(value: any) { serve = value; },
    get status() { return status; },
    set status(value: any) { status = value; },
    set saveError(value: Error) { saveError = value; },
    set runError(value: Error) { runError = value; },
    set verificationOverride(value: object) { verificationOverride = value; },
  };
}
const changes = (commands: string[][]) => commands.filter((args) => args[0] === "serve" && args[1] !== "status");

test("enable configures private persistent HTTPS and defaults to the node owner's login", async () => {
  const f = fixture();
  const result = await tailscaleCommand("enable", {}, f.deps);
  assert.equal(result.healthy, true);
  assert.equal(result.url, `${origin}/`);
  assert.deepEqual(f.config.tailscale, { origin, allowedUsers: ["owner@example.com"] });
  assert.deepEqual(changes(f.commands), [["serve", "--bg", "--yes", "--https=443", backend]]);
  assert.ok(f.events.indexOf("config.save") > f.events.lastIndexOf("serve status --json"));
});

test("enable preserves other ports, supports explicit users, and repeated enable is a no-op", async () => {
  const f = fixture();
  f.serve = mapping(443, "http://127.0.0.1:9999");
  await tailscaleCommand("enable", { httpsPort: "8443", allowUser: "friend@example.com, owner@example.com" }, f.deps);
  const configured = structuredClone(f.serve);
  assert.equal(f.config.tailscale.origin, `${origin}:8443`);
  assert.deepEqual(f.config.tailscale.allowedUsers, ["friend@example.com", "owner@example.com"]);
  await tailscaleCommand("enable", {}, f.deps);
  assert.deepEqual(f.serve, configured);
  assert.equal(changes(f.commands).length, 1);
  assert.equal(f.events.filter((event) => event === "config.save").length, 1);
  await tailscaleCommand("enable", { allowUser: "new@example.com" }, f.deps);
  assert.deepEqual(f.config.tailscale.allowedUsers, ["new@example.com"]);
  assert.equal(changes(f.commands).length, 1);
});

test("enable restores a missing owned mapping", async () => {
  const f = fixture();
  f.config.tailscale = { origin, allowedUsers: ["owner@example.com"] };
  await tailscaleCommand("enable", {}, f.deps);
  assert.equal(changes(f.commands).length, 1);
  assert.deepEqual(f.serve, mapping());
});

for (const [name, conflicting] of Object.entries({
  "another backend": mapping(443, "http://127.0.0.1:9999"),
  "a root file server": { TCP: { "443": { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { "/": { Path: "/tmp" } } } } },
  "an additional path": { TCP: { "443": { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: backend }, "/other": { Text: "other app" } } } } },
  "a TCP forwarder": { TCP: { "443": { TCPForward: "127.0.0.1:9999" } } },
  "another hostname": { TCP: { "443": { HTTPS: true } }, Web: { "other.example.ts.net:443": { Handlers: { "/": { Proxy: backend } } } } },
  "a foreground session": { Foreground: { session: mapping() } },
  "Funnel": { ...mapping(), AllowFunnel: { [`${hostname}:443`]: true } },
})) {
  test(`enable refuses ${name} without writing config or Serve`, async () => {
    const f = fixture();
    f.serve = conflicting;
    await assert.rejects(tailscaleCommand("enable", {}, f.deps), /Tailscale (port|Funnel)/);
    assert.deepEqual(changes(f.commands), []);
    assert.equal(f.events.includes("config.save"), false);
    assert.equal(f.config.tailscale, undefined);
  });
}

test("changing a configured HTTPS endpoint requires disabling it first", async () => {
  const f = fixture();
  f.config.tailscale = { origin, allowedUsers: ["owner@example.com"] };
  await assert.rejects(tailscaleCommand("enable", { httpsPort: "8443" }, f.deps), /disable before changing/);
  assert.deepEqual(changes(f.commands), []);
});

test("configuration failure removes only a newly created mapping", async () => {
  const f = fixture();
  f.serve = mapping(8443, "http://127.0.0.1:9999");
  f.saveError = new Error("Configuration changed; retry.");
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /Configuration changed/);
  assert.deepEqual(changes(f.commands), [
    ["serve", "--bg", "--yes", "--https=443", backend],
    ["serve", "--bg", "--yes", "--https=443", "off"],
  ]);
  assert.equal(f.serve.Web[`${hostname}:8443`].Handlers["/"].Proxy, "http://127.0.0.1:9999");
  assert.equal(f.serve.Web[`${hostname}:443`], undefined);
  assert.equal(f.config.tailscale, undefined);
});

test("configuration failure leaves a pre-existing matching Serve mapping intact", async () => {
  const f = fixture();
  f.serve = mapping();
  f.saveError = new Error("Save rejected");
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /Save rejected/);
  assert.deepEqual(changes(f.commands), []);
  assert.deepEqual(f.serve, mapping());
});

test("failed Serve verification never authorizes access or deletes a changed mapping", async () => {
  const f = fixture();
  f.verificationOverride = mapping(443, "http://127.0.0.1:9999");
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /Serve changed during setup/);
  assert.equal(f.config.tailscale, undefined);
  assert.equal(changes(f.commands).length, 1);
  assert.equal(f.events.includes("config.save"), false);
});

test("Serve errors preserve the HTTPS enablement URL and do not save access", async () => {
  const f = fixture();
  f.runError = new Error("HTTPS is not enabled. Visit https://login.tailscale.com/f/serve?node=test");
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /https:\/\/login.tailscale.com\/f\/serve\?node=test/);
  assert.equal(f.config.tailscale, undefined);
  assert.equal(f.events.includes("config.save"), false);
});

test("status accurately reports unconfigured, missing, healthy and conflicting states", async () => {
  const f = fixture();
  assert.deepEqual(await tailscaleCommand("status", {}, f.deps), { enabled: false, healthy: false, message: "Tailscale access is disabled. Run devdeck tailscale enable." });
  assert.equal(f.commands.length, 0);
  f.config.tailscale = { origin, allowedUsers: ["owner@example.com"] };
  assert.equal((await tailscaleCommand("status", {}, f.deps)).healthy, false);
  f.serve = mapping();
  assert.equal((await tailscaleCommand("status", {}, f.deps)).healthy, true);
  f.serve.AllowFunnel = { [`${hostname}:443`]: true };
  const result = await tailscaleCommand("status", {}, f.deps);
  assert.equal(result.healthy, false);
  assert.match(result.message, /Funnel/);
  assert.deepEqual(changes(f.commands), []);
});

test("disable revokes access before deleting only the matching endpoint, and is repeatable", async () => {
  const f = fixture();
  f.config.tailscale = { origin, allowedUsers: ["owner@example.com"] };
  f.serve = { TCP: { ...mapping().TCP, ...mapping(8443).TCP }, Web: { ...mapping().Web, ...mapping(8443).Web } };
  await tailscaleCommand("disable", {}, f.deps);
  assert.equal(f.config.tailscale, undefined);
  assert.deepEqual(changes(f.commands), [["serve", "--bg", "--yes", "--https=443", "off"]]);
  assert.ok(f.events.indexOf("config.save") < f.events.indexOf("status --json"));
  assert.ok(f.serve.Web[`${hostname}:8443`]);
  await tailscaleCommand("disable", {}, f.deps);
  assert.equal(changes(f.commands).length, 1);
});

test("disable revokes access but leaves stale or unrelated Serve routes untouched", async () => {
  const f = fixture();
  f.config.tailscale = { origin, allowedUsers: ["owner@example.com"] };
  f.serve = mapping(443, "http://127.0.0.1:9999");
  await assert.rejects(tailscaleCommand("disable", {}, f.deps), /access is disabled.*stale Device Deck backend/);
  assert.equal(f.config.tailscale, undefined);
  assert.deepEqual(changes(f.commands), []);
});

test("disable keeps Serve untouched when revoking config fails", async () => {
  const f = fixture();
  f.config.tailscale = { origin, allowedUsers: ["owner@example.com"] };
  f.serve = mapping();
  f.saveError = new Error("Save rejected");
  await assert.rejects(tailscaleCommand("disable", {}, f.deps), /Save rejected/);
  assert.equal(f.commands.length, 0);
  assert.ok(f.config.tailscale);
});

test("remote dashboard links contain neither local tickets nor bearer credentials", async () => {
  const f = fixture();
  await assert.rejects(tailscaleBrowserUrl(f.deps), /disabled/);
  f.config.tailscale = { origin, allowedUsers: ["owner@example.com"] };
  assert.equal(await tailscaleBrowserUrl(f.deps), `${origin}/`);
  assert.deepEqual(f.events, ["config.get", "config.get"]);
});

test("invalid options, malformed status and unauthenticated nodes fail without mutations", async () => {
  for (const options of [{ httpsPort: "0" }, { httpsPort: "65536" }, { httpsPort: "443;exit" }, { allowUser: "" }, { allowUser: "a,b,a" }, { allowUser: "a,,b" }, { allowUser: "two users" }, { allowUser: "*" }, { allowUser: "a".repeat(321) }, { allowUser: Array.from({ length: 65 }, (_, i) => `user${i}`).join(",") }]) {
    const f = fixture();
    await assert.rejects(tailscaleCommand("enable", options, f.deps));
    assert.deepEqual(changes(f.commands), []);
  }
  const f = fixture();
  f.status = { BackendState: "NeedsLogin" };
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /not connected/);
  f.status = { BackendState: "Running", Self: { DNSName: "bad.example.com." } };
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /no valid .ts.net hostname/);
  f.status = null;
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /invalid status JSON/);
  assert.deepEqual(changes(f.commands), []);
});

test("a tagged node needs an explicit allowed login", async () => {
  const f = fixture();
  delete f.status.User;
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /Tagged devices require an explicit allowed user/);
  await tailscaleCommand("enable", { allowUser: "owner@example.com" }, f.deps);
  assert.deepEqual(f.config.tailscale.allowedUsers, ["owner@example.com"]);
});

test("tagged nodes never inherit owner access from retained user metadata", async () => {
  const f = fixture();
  f.status.Self.Tags = ["tag:device-deck"];
  await assert.rejects(tailscaleCommand("enable", {}, f.deps), /Tagged devices require an explicit allowed user/);
  assert.deepEqual(changes(f.commands), []);
  assert.equal(f.config.tailscale, undefined);
});
