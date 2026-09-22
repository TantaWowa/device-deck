import { terminal } from "./terminal";
import { render } from "./render";
import { Workspace, type Acquired } from "./workspace";

export async function runWorkspace(
  options: {
    remoteId?: string;
    acquired?: Acquired;
    remoteOnly?: boolean;
  } = {},
) {
  const ui = terminal(),
    workspace = new Workspace(undefined, options);
  let lastRefresh = Date.now(),
    drawn = -1;
  void workspace.refresh();
  try {
    while (!workspace.done) {
      const { width, height } = ui.size();
      if (workspace.version !== drawn) {
        ui.draw(render(workspace, width, height));
        drawn = workspace.version;
      }
      const key = await ui.key();
      if (key.name === "resize") workspace.changed();
      else workspace.handle(key);
      if (Date.now() - lastRefresh >= 3000 && !workspace.busy) {
        lastRefresh = Date.now();
        void workspace.refresh();
      }
    }
  } finally {
    workspace.dispose();
    ui.close();
  }
}
