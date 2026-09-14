import { lifecycle } from "../apps/cli/src/lifecycle";
import { root } from "../packages/adapters/src";
import path from "node:path";
console.log(
  await lifecycle("start", [
    "--import",
    "tsx",
    path.join(root, "scripts/service-local.ts"),
  ]),
);
