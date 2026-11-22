#include <sys/file.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const off_t counter_size = 16384;
static const mode_t shared_mode = 0660;

static int failure(const char *message) {
    fprintf(stderr, "%s\n", message);
    return 1;
}

static int simulator_count(void) {
    int query[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    for (int attempt = 0; attempt < 3; attempt++) {
        size_t bytes = 0;
        if (sysctl(query, 4, NULL, &bytes, NULL, 0) != 0) break;
        bytes += 64 * sizeof(struct kinfo_proc);
        struct kinfo_proc *rows = malloc(bytes);
        if (!rows) break;
        if (sysctl(query, 4, rows, &bytes, NULL, 0) == 0) {
            int count = 0;
            for (size_t i = 0; i < bytes / sizeof(*rows); ++i) {
                if (strcmp(rows[i].kp_proc.p_comm, "launchd_sim") == 0) ++count;
            }
            free(rows);
            return count;
        }
        int error = errno;
        free(rows);
        if (error != ENOMEM) break;
    }
    return -1;
}

static bool matches(const struct stat *info, gid_t group) {
    return info->st_size == counter_size && info->st_gid == group &&
           (info->st_mode & 07777) == shared_mode;
}

static int prepare_counters(const char *name, gid_t group, bool repair, int (*running)(void)) {
    int previous = shm_open(name, O_RDONLY, 0);
    struct stat before = {0};
    if (previous < 0 && errno != ENOENT) return failure("Cannot inspect the simulator preferences cache.");
    if (previous >= 0) {
        if (fstat(previous, &before) != 0 || before.st_size != counter_size)
            return failure("Unexpected simulator preferences cache size or metadata. Inspect it before repair.");
        if (matches(&before, group)) {
            int writable = shm_open(name, O_RDWR, 0);
            if (writable < 0) return failure("The hosting account cannot write the simulator preferences cache.");
            close(writable);
            close(previous);
            return 0;
        }
    }
    if (!repair) return failure("Simulator preferences need repair. Device Deck repairs them when all Apple simulators on this Mac are stopped.");
    int count = running();
    if (count < 0) return failure("Cannot check for running Apple simulators across all accounts.");
    if (count > 0) return failure("Stop the running Apple simulators before repairing the preferences cache.");
    if (previous >= 0 && geteuid() != 0 && before.st_uid != geteuid())
        return failure("Waiting for the Device Deck system repair to correct another account's simulator preferences cache.");
    if (setegid(group) != 0) return failure("Cannot select the staff group for simulator preferences.");
    umask(0);
    if (previous >= 0) {
        int current = shm_open(name, O_RDONLY, 0);
        struct stat latest;
        if (current < 0 || fstat(current, &latest) != 0 || latest.st_dev != before.st_dev ||
            latest.st_ino != before.st_ino || latest.st_size != before.st_size ||
            latest.st_uid != before.st_uid || latest.st_gid != before.st_gid || latest.st_mode != before.st_mode)
            return failure("Simulator preferences changed during repair. Retry when idle.");
        close(current);
        if (running() != 0) return failure("Apple simulator activity changed during repair. Retry when idle.");
        if (shm_unlink(name) != 0) return failure("Cannot replace the inactive simulator preferences cache.");
        close(previous);
    }
    if (previous < 0 && running() != 0) return failure("Apple simulator activity changed before cache creation. Retry when idle.");
    int created = shm_open(name, O_CREAT | O_EXCL | O_RDWR, shared_mode);
    if (created < 0) return failure("Another process created the simulator preferences cache. Retry the check.");
    struct stat after;
    if (ftruncate(created, counter_size) != 0 || fstat(created, &after) != 0 || !matches(&after, group))
        return failure("Cannot initialize the shared simulator preferences cache.");
    close(created);
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "check") && strcmp(argv[1], "repair"))) return 2;
    struct group *staff = getgrnam("staff");
    if (!staff) return failure("The staff group is unavailable.");
    int lock = open("/Library/Application Support/Device Deck/host.json", O_RDONLY | O_NOFOLLOW);
    if (lock < 0 && errno == ENOENT && geteuid() == 0) return 0;
    if (lock < 0 || flock(lock, LOCK_EX) != 0) return failure("Shared Device Deck setup is required.");
    return prepare_counters("apple.sim.cfprefs.user.daemonv", staff->gr_gid, strcmp(argv[1], "repair") == 0, simulator_count);
}
