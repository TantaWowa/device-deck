#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// A Mach-O shim signs and relocates with the app. execv retains the caller's
// terminal, stdin and signals, so CLI, TUI and MCP behave like normal commands.
int main(int argc, char **argv) {
  if (getuid() == 0) {
    fputs("Run Device Deck as your Mac user. Only the installer needs administrator access.\n", stderr);
    return 1;
  }
  char executable[PATH_MAX], resolved[PATH_MAX], resources[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) {
    perror("Cannot locate Device Deck"); return 1;
  }
  char *name = strrchr(resolved, '/');
  if (!name) return 1;
  *name = '\0';
  if (snprintf(resources, sizeof(resources), "%s/../Resources", resolved) >= sizeof(resources)) return 1;
  char node[PATH_MAX], cli[PATH_MAX];
  if (snprintf(node, sizeof(node), "%s/runtime/bin/node", resources) >= sizeof(node) ||
      snprintf(cli, sizeof(cli), "%s/build/devdeck.mjs", resources) >= sizeof(cli)) return 1;
  const char *existing = getenv("PATH");
  size_t length = 2 * strlen(resources) + (existing ? strlen(existing) : 0) + 200;
  char *search = malloc(length);
  if (!search) return 1;
  snprintf(search, length, "%s/runtime/bin:%s/media/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:%s", resources, resources, existing ? existing : "");
  setenv("PATH", search, 1);
  free(search);
  for (const char **key = (const char *[]){"NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", NULL}; *key; key++) unsetenv(*key);
  char **args = calloc((size_t)argc + 2, sizeof(char *));
  if (!args) return 1;
  args[0] = node; args[1] = cli;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  execv(node, args);
  perror("Cannot start Device Deck's bundled Node runtime");
  return 1;
}
