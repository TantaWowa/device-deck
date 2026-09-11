# Current service and client contract

The service is a read-only development scaffold. Start it with `npm run service`. It binds to `127.0.0.1:47831`; `DEVICE_DECK_PORT` changes the explicit port. Automatic endpoint discovery and lifecycle installation remain planned.

| Endpoint                          | Result                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `GET /v1/health`                  | `status: scaffold`, zero hardware adapters, implemented/planned operation names |
| `GET /v1/inventory`               | Empty `devices`, `sources`, and `leases` arrays                                 |
| Unknown GET                       | HTTP 404, `not-found`                                                           |
| Any mutation                      | HTTP 501, `not-implemented`                                                     |
| Browser Origin or unexpected Host | HTTP 403, `local-client-required`                                               |

Responses are JSON. The service has no credentials because no private inventory or mutations exist. Loopback alone is not sufficient authorization for the eventual hardware service. Add unguessable credentials and origin/CSRF protection before enabling it. Do not bind to an external interface.

```sh
curl http://127.0.0.1:47831/v1/health
npm run cli -- status
npm run cli -- devices --json
```

CLI exit codes are 0 for success, 1 for service failure, and 2 for invalid usage. All commands are noninteractive. Run `npm run cli -- --help` for current commands. The `devdeck` executable name in product examples is provisional; no globally installable binary is published.

## MCP

`npm run mcp` starts an MCP stdio server. It exposes `service_health` and `devices_list`, both using the same loopback service as the CLI. Protocol messages use stdout; npm wrappers may print lifecycle output, so client setup should launch the script directly using tsx:

```json
{
  "mcpServers": {
    "device-deck": {
      "command": "node",
      "args": ["--import", "tsx", "packages/mcp/src/index.ts"],
      "cwd": "/path/to/device-deck",
      "env": { "DEVICE_DECK_PORT": "47831" }
    }
  }
}
```

`cwd` support varies by MCP host. Alternatively use absolute paths to that checkout's `node_modules/tsx/dist/loader.mjs` and MCP script. Replace the example path; it is not a personal checkout dependency.

Session, input, capture and artifact MCP tools are unimplemented. The website and demo show proposed contracts and label them accordingly. No tools touch hardware.

## Proposed configuration

[device-deck.schema.json](device-deck.schema.json) and [the example](../examples/device-deck.json) preserve the brief's names, source identities and defaults. They are design artifacts, not currently loaded by the service. Relative artifact paths should resolve against the operator config file when implemented. Reference uniqueness and device/source relationships will need semantic validation beyond this JSON schema.

The current scaffold uses an explicit loopback port for reproducibility. The brief's port-zero option is deferred until secure endpoint discovery exists. Do not advertise configuration import/export or JSON writes before they work.
