// Keep AVFoundation and clipboard access beneath the signed-in menu app. The
// boot service only transports bytes to this same-user, private Unix socket.
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define FRAME_LIMIT 32768
#define ARG_LIMIT 4096
#define CLIENT_LIMIT 32
static volatile sig_atomic_t stopping = 0;
static pid_t owner_pid = 0;
static const char *desktop_message = "Camera capture and the clipboard need the Device Deck host's desktop session. Sign in as the host and open Device Deck from Applications.\n";
static void stop_signal(int sig) { stopping = sig; }
static int cancelled(void) { return stopping || (owner_pid && getppid() != owner_pid); }
static void signal_handlers(void) {
  struct sigaction action = {0};
  action.sa_handler = stop_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
}
static long long milliseconds(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int wait_fd(int fd, short events, long long deadline) {
  while (!cancelled()) {
    if (deadline && milliseconds() >= deadline) { errno = ETIMEDOUT; return -1; }
    struct pollfd p = { .fd = fd, .events = events };
    int result = poll(&p, 1, 200);
    if (result > 0) return 0; // The caller's read/write reports EOF and errors.
    if (result < 0 && errno != EINTR) return -1;
  }
  errno = ECANCELED; return -1;
}
static int read_exact(int fd, void *bytes, size_t length, long long deadline) {
  unsigned char *cursor = bytes;
  while (length && !cancelled()) {
    if (wait_fd(fd, POLLIN, deadline)) return -1;
    ssize_t count = read(fd, cursor, length);
    if (count == 0) return -1;
    if (count < 0) { if (errno == EINTR || errno == EAGAIN) continue; return -1; }
    cursor += count; length -= (size_t)count;
  }
  return length ? -1 : 0;
}
static int write_exact(int fd, const void *bytes, size_t length) {
  const unsigned char *cursor = bytes;
  while (length && !cancelled()) {
    if (wait_fd(fd, POLLOUT, 0)) return -1;
    ssize_t count = write(fd, cursor, length > 4096 ? 4096 : length);
    if (count < 0) { if (errno == EINTR || errno == EAGAIN) continue; return -1; }
    if (!count) return -1;
    cursor += count; length -= (size_t)count;
  }
  return length ? -1 : 0;
}
static int frame(int fd, unsigned char channel, const void *bytes, uint32_t length) {
  unsigned char header[5] = {channel};
  uint32_t network = htonl(length);
  memcpy(header + 1, &network, sizeof(network));
  return write_exact(fd, header, sizeof(header)) || write_exact(fd, bytes, length) ? -1 : 0;
}
static void failure_frame(int fd, const char *message, unsigned char code) {
  frame(fd, 'E', message, (uint32_t)strlen(message));
  frame(fd, 'X', &code, 1);
}
static void close_on_exec(int fd) { fcntl(fd, F_SETFD, FD_CLOEXEC); }
static void nonblocking(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }
static int same_user(int fd) {
  uid_t uid; gid_t gid;
  return getpeereid(fd, &uid, &gid) == 0 && uid == geteuid();
}
static int private_parent(const char *socket_path) {
  char parent[PATH_MAX];
  if (socket_path[0] != '/' || strlen(socket_path) >= sizeof(parent)) return -1;
  strcpy(parent, socket_path);
  char *slash = strrchr(parent, '/');
  if (!slash || slash == parent) return -1;
  *slash = '\0';
  struct stat info;
  if (lstat(parent, &info) || !S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 077)) return -1;
  return 0;
}
static int socket_address(const char *name, struct sockaddr_un *address) {
  if (strlen(name) >= sizeof(address->sun_path)) { errno = ENAMETOOLONG; return -1; }
  memset(address, 0, sizeof(*address));
  address->sun_family = AF_UNIX;
  strcpy(address->sun_path, name);
  return 0;
}
static int native_path(char *destination, size_t capacity) {
  char executable[PATH_MAX], resolved[PATH_MAX];
  uint32_t length = sizeof(executable);
  if (_NSGetExecutablePath(executable, &length) || !realpath(executable, resolved)) return -1;
  char *slash = strrchr(resolved, '/');
  if (!slash) return -1;
  *slash = '\0';
  return snprintf(destination, capacity, "%s/deck-camera-native", resolved) >= (int)capacity ? -1 : 0;
}
static int valid_command(unsigned char command, const char *argument, uint32_t length) {
  if (length >= ARG_LIMIT || memchr(argument, '\0', length)) return 0;
  if (command == 'L') return length == 0;
  if (command == 'S') return length > 0;
  if (command == 'C') return length > 0 && argument[0] == '/';
  return 0;
}
static void terminate_child(pid_t child) {
  if (child <= 0) return;
  int status;
  pid_t existing = waitpid(child, &status, WNOHANG);
  if (existing == child || (existing < 0 && errno == ECHILD)) return;
  kill(child, SIGTERM);
  for (int attempt = 0; attempt < 50; attempt++) {
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child || (result < 0 && errno == ECHILD)) return;
    usleep(20000);
  }
  kill(child, SIGKILL);
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
}
static void serve_client(int client, const char *native) {
  unsigned char request[9];
  char argument[ARG_LIMIT];
  long long deadline = milliseconds() + 5000;
  if (read_exact(client, request, sizeof(request), deadline)) return;
  uint32_t network, length;
  memcpy(&network, request + 5, sizeof(network)); length = ntohl(network);
  if (memcmp(request, "DDC1", 4) || length >= sizeof(argument)) {
    failure_frame(client, "Invalid camera request.\n", 64); return;
  }
  if (read_exact(client, argument, length, deadline)) return;
  argument[length] = '\0';
  if (!valid_command(request[4], argument, length)) {
    failure_frame(client, "Unsupported camera command or argument.\n", 64); return;
  }
  int output[2] = {-1, -1}, errors[2] = {-1, -1};
  if (pipe(output) || pipe(errors)) {
    if (output[0] >= 0) { close(output[0]); close(output[1]); }
    failure_frame(client, "Cannot start camera helper pipes.\n", 1); return;
  }
  close_on_exec(output[0]); close_on_exec(errors[0]);
  pid_t child = fork();
  if (!child) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    dup2(output[1], STDOUT_FILENO); dup2(errors[1], STDERR_FILENO);
    close(output[0]); close(output[1]); close(errors[0]); close(errors[1]); close(client);
    int empty = open("/dev/null", O_RDONLY);
    if (empty >= 0) { dup2(empty, STDIN_FILENO); if (empty != STDIN_FILENO) close(empty); }
    const char *command = request[4] == 'L' ? "list" : request[4] == 'S' ? "stream" : "clipboard";
    char *args[] = {(char *)native, (char *)command, argument, NULL};
    if (request[4] == 'L') args[2] = NULL;
    execv(native, args);
    perror("Cannot open Device Deck's native camera helper"); _exit(127);
  }
  close(output[1]); close(errors[1]);
  if (child < 0) {
    close(output[0]); close(errors[0]); failure_frame(client, "Cannot start camera helper.\n", 1); return;
  }
  int connected = 1, status = 0, reaped = 0;
  while (connected && !cancelled() && (output[0] >= 0 || errors[0] >= 0 || !reaped)) {
    struct pollfd descriptors[] = {
      {.fd = client, .events = POLLIN}, {.fd = output[0], .events = POLLIN}, {.fd = errors[0], .events = POLLIN}
    };
    int result = poll(descriptors, 3, 200);
    if (result < 0 && errno != EINTR) break;
    if (descriptors[0].revents) { connected = 0; break; }
    for (int index = 1; index <= 2; index++) {
      if (!descriptors[index].revents) continue;
      unsigned char bytes[FRAME_LIMIT];
      int *source = index == 1 ? &output[0] : &errors[0];
      ssize_t count = read(*source, bytes, sizeof(bytes));
      if (count > 0) {
        if (frame(client, index == 1 ? 'O' : 'E', bytes, (uint32_t)count)) { connected = 0; break; }
      } else if (!count || (errno != EINTR && errno != EAGAIN)) { close(*source); *source = -1; }
    }
    if (!reaped) {
      pid_t result = waitpid(child, &status, WNOHANG);
      if (result == child) reaped = 1;
    }
  }
  if (output[0] >= 0) close(output[0]);
  if (errors[0] >= 0) close(errors[0]);
  if (!reaped) terminate_child(child);
  else if (connected && !cancelled()) {
    unsigned char code = WIFEXITED(status) ? (unsigned char)WEXITSTATUS(status) : (unsigned char)(128 + WTERMSIG(status));
    frame(client, 'X', &code, 1);
  }
}
static int broker(const char *name, const char *native) {
  struct sockaddr_un address;
  if (private_parent(name) || socket_address(name, &address)) {
    fputs("Camera bridge needs a short socket path inside a private directory owned by the signed-in host.\n", stderr); return 1;
  }
  struct stat existing;
  if (!lstat(name, &existing)) {
    if (!S_ISSOCK(existing.st_mode) || existing.st_uid != geteuid()) {
      fputs("Refusing to replace an unsafe camera bridge path.\n", stderr); return 1;
    }
    int probe = socket(AF_UNIX, SOCK_STREAM, 0);
    if (probe < 0) return 1;
    int connected = connect(probe, (struct sockaddr *)&address, sizeof(address)), failure = errno;
    close(probe);
    if (!connected || failure != ECONNREFUSED) {
      fputs("The camera bridge is already running or cannot be safely replaced.\n", stderr); return 1;
    }
    if (unlink(name)) return 1;
  } else if (errno != ENOENT) return 1;
  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0) return 1;
  close_on_exec(listener);
  umask(0077);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || chmod(name, 0600) || listen(listener, CLIENT_LIMIT)) {
    perror("Cannot start camera bridge"); close(listener); return 1;
  }
  struct stat created;
  if (lstat(name, &created)) { close(listener); return 1; }
  owner_pid = getppid();
  pid_t clients[CLIENT_LIMIT] = {0};
  while (!cancelled()) {
    for (int index = 0; index < CLIENT_LIMIT; index++) {
      if (clients[index] && waitpid(clients[index], NULL, WNOHANG) == clients[index]) clients[index] = 0;
    }
    struct pollfd p = {.fd = listener, .events = POLLIN};
    int ready = poll(&p, 1, 200);
    if (ready < 0) { if (errno == EINTR) continue; break; }
    if (!ready) continue;
    int client = accept(listener, NULL, NULL);
    if (client < 0) continue;
    close_on_exec(client);
    nonblocking(client);
    if (!same_user(client)) { close(client); continue; }
    int index = 0;
    while (index < CLIENT_LIMIT && clients[index]) index++;
    if (index == CLIENT_LIMIT) { failure_frame(client, "Device Deck's camera bridge is busy. Try again.\n", 1); close(client); continue; }
    pid_t handler = fork();
    if (!handler) {
      close(listener); owner_pid = getppid();
      setpgid(0, 0);
      serve_client(client, native); close(client); _exit(0);
    }
    if (handler > 0) { clients[index] = handler; setpgid(handler, handler); }
    close(client);
  }
  close(listener);
  // Every handler owns a process group containing only its native helper.
  for (int index = 0; index < CLIENT_LIMIT; index++) if (clients[index]) kill(-clients[index], SIGTERM);
  for (int index = 0; index < CLIENT_LIMIT; index++) if (clients[index]) terminate_child(clients[index]);
  struct stat current;
  if (!lstat(name, &current) && current.st_dev == created.st_dev && current.st_ino == created.st_ino) unlink(name);
  return 0;
}
static int proxy(unsigned char command, const char *argument) {
  char name[PATH_MAX];
  const char *profile = getenv("DEVICE_DECK_HOME");
  if (profile && profile[0]) {
    if (snprintf(name, sizeof(name), "%s/camera.sock", profile) >= (int)sizeof(name)) return 1;
  } else {
    struct passwd *user = getpwuid(geteuid());
    if (!user || snprintf(name, sizeof(name), "%s/Library/Application Support/Device Deck/camera.sock", user->pw_dir) >= (int)sizeof(name)) return 1;
  }
  struct sockaddr_un address;
  struct stat info;
  if (private_parent(name) || socket_address(name, &address) || lstat(name, &info) || !S_ISSOCK(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 077)) {
    fputs(desktop_message, stderr); return 69;
  }
  int connection = socket(AF_UNIX, SOCK_STREAM, 0);
  if (connection < 0 || connect(connection, (struct sockaddr *)&address, sizeof(address)) || !same_user(connection)) {
    if (connection >= 0) close(connection);
    fputs(desktop_message, stderr); return 69;
  }
  close_on_exec(connection);
  nonblocking(connection);
  unsigned char request[9] = {'D', 'D', 'C', '1', command};
  uint32_t length = (uint32_t)strlen(argument), network = htonl(length);
  memcpy(request + 5, &network, sizeof(network));
  int exit_code = 1;
  if (write_exact(connection, request, sizeof(request)) || write_exact(connection, argument, length)) goto disconnected;
  while (!cancelled()) {
    unsigned char header[5], bytes[FRAME_LIMIT];
    if (read_exact(connection, header, sizeof(header), 0)) break;
    memcpy(&network, header + 1, sizeof(network)); length = ntohl(network);
    if (!length || length > sizeof(bytes) || (header[0] != 'O' && header[0] != 'E' && header[0] != 'X') || (header[0] == 'X' && length != 1)) break;
    if (read_exact(connection, bytes, length, 0)) break;
    if (header[0] == 'X') { exit_code = bytes[0]; close(connection); return exit_code; }
    if (write_exact(header[0] == 'O' ? STDOUT_FILENO : STDERR_FILENO, bytes, length)) break;
  }
 disconnected:
  close(connection);
  if (stopping) return 128 + stopping;
  fputs("Device Deck's desktop camera bridge disconnected. Reopen Device Deck on the host Mac.\n", stderr);
  return exit_code;
}
int main(int argc, char **argv) {
  if (!geteuid()) { fputs("Run the camera bridge as the Device Deck host, never as root.\n", stderr); return 1; }
  signal_handlers();
  owner_pid = getppid();
  char native[PATH_MAX];
  if (native_path(native, sizeof(native))) { fputs("Cannot locate Device Deck's native camera helper.\n", stderr); return 1; }
  if (argc == 3 && !strcmp(argv[1], "--broker")) return broker(argv[2], native);
  unsigned char command = argc == 2 && !strcmp(argv[1], "list") ? 'L' :
    argc == 3 && !strcmp(argv[1], "stream") ? 'S' : argc == 3 && !strcmp(argv[1], "clipboard") ? 'C' : 0;
  const char *argument = argc == 3 ? argv[2] : "";
  if (!valid_command(command, argument, (uint32_t)strlen(argument))) {
    fputs("Use list, stream ID, or clipboard ABSOLUTE_PATH.\n", stderr); return 64;
  }
  const char *system_service = getenv("DEVICE_DECK_SYSTEM_SERVICE");
  if (system_service && !strcmp(system_service, "1")) return proxy(command, argument);
  argv[0] = native;
  execv(native, argv);
  perror("Cannot open Device Deck's native camera helper"); return 127;
}
