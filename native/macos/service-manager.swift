// Invoked through the macOS administrator prompt. No privileged code stays running.
import Foundation
import Security
import Darwin

let appPath = "/Applications/Device Deck.app"
let sharedPath = "/Library/Application Support/Device Deck"
let launchPath = "/Library/LaunchDaemons/com.tantawowa.device-deck.plist"
let serviceLabel = "system/com.tantawowa.device-deck"
let bundleIdentifier = "com.tantawowa.device-deck"
let files = FileManager.default
struct ServiceFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func fail(_ message: String) throws -> Never { throw ServiceFailure(message: message) }
func account(_ value: String) throws -> (uid: uid_t, gid: gid_t, name: String, home: String) {
    guard let uid = UInt32(value), uid >= 501, let record = getpwuid(uid), let name = record.pointee.pw_name,
          let home = record.pointee.pw_dir else { try fail("Choose an existing Mac user account.") }
    let directory = String(cString: home)
    guard directory.hasPrefix("/"), directory != "/", directory != "/var/empty" else { try fail("The hosting account needs a home folder.") }
    return (uid, record.pointee.pw_gid, String(cString: name), directory)
}
func run(_ command: String, _ arguments: [String], environment: [String: String]? = nil) throws -> String {
    let process = Process(), output = Pipe()
    process.executableURL = URL(fileURLWithPath: command); process.arguments = arguments
    process.environment = environment ?? ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/var/root"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output; process.standardError = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(data: data, encoding: .utf8) ?? ""
    guard process.terminationStatus == 0 else { try fail(text.isEmpty ? "\(URL(fileURLWithPath: command).lastPathComponent) failed." : text) }
    return text
}
func attributes(_ path: String) throws -> stat {
    var info = stat()
    guard lstat(path, &info) == 0 else { try fail("Cannot inspect \(path).") }
    guard info.st_mode & S_IFMT != S_IFLNK else { try fail("Refusing a symbolic link at \(path).") }
    return info
}
func protectedDirectory(_ path: String) throws {
    if !files.fileExists(atPath: path) { try files.createDirectory(atPath: path, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755, .ownerAccountID: 0, .groupOwnerAccountID: 0]) }
    let info = try attributes(path)
    guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == 0, info.st_mode & 0o022 == 0 else { try fail("\(path) must be an administrator-owned directory.") }
}
func trustedApp() throws {
    for path in ["/Applications", appPath, appPath + "/Contents", appPath + "/Contents/MacOS", appPath + "/Contents/Resources"] {
        let info = try attributes(path)
        // /Applications may be writable by administrators. App code may not.
        guard info.st_uid == 0, info.st_mode & (path == "/Applications" ? 0o002 : 0o022) == 0 else {
            try fail("Install Device Deck with its Mac installer before configuring the service.")
        }
    }
    _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath])
}
func host() throws -> [String: Any] {
    try protectedDirectory(sharedPath)
    let info = try attributes(sharedPath + "/host.json")
    guard info.st_uid == 0, info.st_mode & 0o022 == 0,
          let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sharedPath + "/host.json"))) as? [String: Any],
          value["schemaVersion"] as? Int == 1, let uid = value["uid"] as? Int else { try fail("The shared service registration is invalid.") }
    let user = try account(String(uid))
    guard value["username"] as? String == user.name, value["home"] as? String == user.home,
          value["profile"] as? String == user.home + "/Library/Application Support/Device Deck" else { try fail("The hosting account changed. Reconfigure Device Deck.") }
    return value
}
func plan(_ uid: String) throws -> ([String: Any], [String: Any]) {
    let user = try account(uid), profile = user.home + "/Library/Application Support/Device Deck"
    let resources = appPath + "/Contents/Resources"
    let marker: [String: Any] = ["schemaVersion": 1, "uid": user.uid, "username": user.name, "home": user.home, "profile": profile]
    let plist: [String: Any] = [
        "Label": "com.tantawowa.device-deck", "UserName": user.name,
        "ProgramArguments": [resources + "/runtime/bin/node", resources + "/build/daemon.mjs"],
        "WorkingDirectory": user.home, "RunAtLoad": true, "KeepAlive": true,
        "ThrottleInterval": 10, "ExitTimeOut": 180, "Umask": 0o077,
        "StandardOutPath": "/Library/Logs/Device Deck/daemon.log", "StandardErrorPath": "/Library/Logs/Device Deck/daemon.log",
        "EnvironmentVariables": ["HOME": user.home, "USER": user.name, "LOGNAME": user.name,
            "DEVICE_DECK_HOME": profile, "DEVICE_DECK_SYSTEM_SERVICE": "1", "DEVICE_DECK_HOST_UID": String(user.uid),
            "PATH": resources + "/runtime/bin:" + resources + "/media/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"]
    ]
    return (marker, plist)
}
func save(_ data: Data, _ path: String, mode: mode_t = 0o644) throws {
    let temporary = path + "." + UUID().uuidString
    guard files.createFile(atPath: temporary, contents: data, attributes: [.posixPermissions: mode, .ownerAccountID: 0, .groupOwnerAccountID: 0]) else { try fail("Cannot save service configuration.") }
    defer { try? files.removeItem(atPath: temporary) }
    guard rename(temporary, path) == 0 else { try fail("Cannot replace service configuration.") }
}
func configure(_ uid: String) throws {
    let user = try account(uid), (marker, plist) = try plan(uid)
    try protectedDirectory(sharedPath)
    if files.fileExists(atPath: sharedPath + "/host.json") {
        let existing = try host()
        guard existing["uid"] as? Int == Int(user.uid) else { try fail("This Mac already hosts Device Deck under \(existing["username"] ?? "another account"). Open that account's Device Deck setup to grant access.") }
        if (try? hostCLI(["status"])) != nil { return }
    }
    // A previous login installation must release the same private profile before
    // the boot service takes it over. Drain first so another client cannot reserve
    // a device between the idle check and shutdown.
    if !files.fileExists(atPath: sharedPath + "/host.json"), (try? userCLI(user.uid, ["status"])) != nil {
        _ = try userCLI(user.uid, ["service", "prepare-update"])
        do { _ = try userCLI(user.uid, ["stop"]) }
        catch { _ = try? userCLI(user.uid, ["service", "cancel-update"]); throw error }
    }
    _ = try? run("/bin/launchctl", ["bootout", "gui/\(user.uid)/com.tantawowa.device-deck"])
    let legacy = user.home + "/Library/LaunchAgents/com.tantawowa.device-deck.plist"
    if let info = try? attributes(legacy), info.st_uid == user.uid, info.st_mode & S_IFMT == S_IFREG,
       let data = try? Data(contentsOf: URL(fileURLWithPath: legacy)),
       let value = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
       value["Label"] as? String == "com.tantawowa.device-deck" { try files.removeItem(atPath: legacy) }
    let access = sharedPath + "/access"
    if !files.fileExists(atPath: access) {
        try files.createDirectory(atPath: access, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o711, .ownerAccountID: user.uid, .groupOwnerAccountID: user.gid])
    }
    let accessInfo = try attributes(access)
    guard accessInfo.st_mode & S_IFMT == S_IFDIR, accessInfo.st_uid == user.uid, accessInfo.st_mode & 0o077 == 0o011 else { try fail("The shared access directory has unexpected permissions.") }
    try protectedDirectory("/Library/Logs/Device Deck")
    let log = "/Library/Logs/Device Deck/daemon.log"
    if !files.fileExists(atPath: log) {
        guard files.createFile(atPath: log, contents: nil, attributes: [.posixPermissions: 0o600, .ownerAccountID: user.uid, .groupOwnerAccountID: user.gid]) else { try fail("Cannot create service log.") }
    }
    let logInfo = try attributes(log)
    guard logInfo.st_mode & S_IFMT == S_IFREG, logInfo.st_uid == user.uid, logInfo.st_mode & 0o077 == 0 else { try fail("The service log has unexpected permissions.") }
    try save(JSONSerialization.data(withJSONObject: marker, options: [.sortedKeys]), sharedPath + "/host.json")
    try save(PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0), launchPath)
    _ = try? run("/bin/launchctl", ["bootout", serviceLabel])
    _ = try run("/bin/launchctl", ["bootstrap", "system", launchPath])
    try waitHealthy()
}
func userCLI(_ uid: uid_t, _ arguments: [String]) throws -> String {
    let user = try account(String(uid))
    return try run("/usr/bin/sudo", ["-H", "-u", "#\(uid)", "--", "/usr/bin/env", "DEVICE_DECK_HOME=" + user.home + "/Library/Application Support/Device Deck", appPath + "/Contents/MacOS/devdeck"] + arguments)
}
func hostCLI(_ arguments: [String]) throws -> String {
    let registered = try host()
    return try userCLI(uid_t(registered["uid"] as! Int), arguments)
}
func waitHealthy() throws {
    let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: appPath + "/Contents/Resources/distribution.json"))) as? [String: Any]
    for _ in 0..<30 {
        if let text = try? hostCLI(["status"]), let data = text.data(using: .utf8),
           let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           health["version"] as? String == metadata?["version"] as? String,
           (health["sharedService"] as? [String: Any])?["startsAtBoot"] as? Bool == true { return }
        Thread.sleep(forTimeInterval: 0.5)
    }
    try fail("The shared service was registered but did not become ready. Open Mac setup to retry. Service details are in /Library/Logs/Device Deck/daemon.log.")
}
func signingTeam() throws -> String {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let ownCode = code else { try fail("Cannot verify the updater identity.") }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(ownCode, [], &staticCode) == errSecSuccess, let ownStaticCode = staticCode else { try fail("Cannot inspect the updater signature.") }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(ownStaticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let team = (info as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty else {
        try fail("In-app installation requires a Developer ID signed Device Deck release.")
    }
    return team
}
struct ReleaseVersion {
    let core: [Int]
    let prerelease: [String]?
    init(_ text: String) throws {
        guard text.count <= 128, text.range(of: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[a-z0-9-]+(?:\\.[a-z0-9-]+)*)?$", options: .regularExpression) != nil else {
            try fail("Invalid Device Deck release version.")
        }
        let parts = text.split(separator: "-", maxSplits: 1).map(String.init)
        let values = parts[0].split(separator: ".").compactMap { Int($0) }
        guard values.count == 3 else { try fail("Invalid Device Deck release version.") }
        core = values
        prerelease = parts.count == 2 ? parts[1].split(separator: ".").map(String.init) : nil
        for identifier in prerelease ?? [] where identifier.allSatisfy({ $0.isNumber }) {
            guard identifier == "0" || !identifier.hasPrefix("0") else { try fail("Invalid Device Deck release version.") }
        }
    }
    var numeric: String { core.map(String.init).joined(separator: ".") }
    func compare(_ other: ReleaseVersion) -> Int {
        for (left, right) in zip(core, other.core) where left != right { return left > right ? 1 : -1 }
        guard let left = prerelease else { return other.prerelease == nil ? 0 : 1 }
        guard let right = other.prerelease else { return -1 }
        for index in 0..<max(left.count, right.count) {
            if index >= left.count { return -1 }; if index >= right.count { return 1 }
            let a = left[index], b = right[index]
            if a == b { continue }
            let an = a.allSatisfy { $0.isNumber }, bn = b.allSatisfy { $0.isNumber }
            if an && bn && a.count != b.count { return a.count > b.count ? 1 : -1 }
            if an != bn { return an ? -1 : 1 }
            return a > b ? 1 : -1
        }
        return 0
    }
}
func distribution(_ app: String) throws -> [String: Any] {
    guard let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: app + "/Contents/Resources/distribution.json"))) as? [String: Any],
          metadata["schemaVersion"] as? Int == 1, metadata["application"] as? String == bundleIdentifier,
          metadata["arch"] as? String == "arm64",
          let version = metadata["version"] as? String else { try fail("The installer does not contain a recognized Device Deck application.") }
    _ = try ReleaseVersion(version)
    return metadata
}
func validateExpandedPackage(_ expanded: String, requestedVersion: String, installed: [String: Any]) throws -> String {
    let requested = try ReleaseVersion(requestedVersion)
    guard let installedVersion = installed["version"] as? String, let arch = installed["arch"] as? String,
          requested.compare(try ReleaseVersion(installedVersion)) > 0 else {
        try fail("The update must be newer than the installed Device Deck version.")
    }
    let items = try files.contentsOfDirectory(atPath: expanded)
    guard Set(items).isSubset(of: ["Distribution", "Resources", "component.pkg"]), items.contains("component.pkg") else { try fail("The installer contains unexpected packages.") }
    let distributionXML = try XMLDocument(contentsOf: URL(fileURLWithPath: expanded + "/Distribution"), options: [.nodeLoadExternalEntitiesNever])
    guard distributionXML.rootElement()?.name == "installer-gui-script" else { try fail("The installer distribution is invalid.") }
    let references = try distributionXML.nodes(forXPath: "//pkg-ref")
    guard !references.isEmpty, references.allSatisfy({ node in
        guard let reference = node as? XMLElement, reference.attribute(forName: "id")?.stringValue == bundleIdentifier else { return false }
        let target = reference.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return target.isEmpty || target == "component.pkg"
    }), references.contains(where: { $0.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) == "component.pkg" }) else {
        try fail("The installer references an unexpected package.")
    }
    let component = expanded + "/component.pkg"
    let packageXML = try XMLDocument(contentsOf: URL(fileURLWithPath: component + "/PackageInfo"), options: [.nodeLoadExternalEntitiesNever])
    guard let package = packageXML.rootElement(), package.name == "pkg-info",
          package.attribute(forName: "identifier")?.stringValue == bundleIdentifier,
          package.attribute(forName: "version")?.stringValue == requested.numeric,
          package.attribute(forName: "install-location")?.stringValue == "/" else { try fail("The installer package identity or version does not match Device Deck.") }
    let packageApp = component + "/Payload/Applications/Device Deck.app"
    let metadata = try distribution(packageApp)
    guard metadata["version"] as? String == requestedVersion, metadata["arch"] as? String == arch,
          metadata["media"] as? String == "bundled", metadata["mode"] as? String == "free",
          metadata["signing"] as? String == "developer-id-notarized" else { try fail("The update's version, architecture or bundled components do not match the selected release.") }
    guard let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: packageApp + "/Contents/Info.plist")), options: [], format: nil) as? [String: Any],
          info["CFBundleIdentifier"] as? String == bundleIdentifier,
          info["DeviceDeckReleaseVersion"] as? String == requestedVersion else { try fail("The application's identity does not match this update.") }
    return packageApp
}
func verifyUpdatePackage(_ installer: String, source: String, requestedVersion: String, team: String, expanded: String) throws {
    let installed = try distribution(appPath)
    _ = try ReleaseVersion(requestedVersion)
    guard let arch = installed["arch"] as? String,
          URL(fileURLWithPath: source).lastPathComponent == "device-deck-\(requestedVersion)-macos-\(arch).pkg" else {
        try fail("Choose the downloaded Device Deck installer for this Mac and release.")
    }
    _ = try run("/usr/sbin/pkgutil", ["--expand-full", installer, expanded])
    let packageApp = try validateExpandedPackage(expanded, requestedVersion: requestedVersion, installed: installed)
    _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", packageApp])
    guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { try fail("Invalid Developer ID team.") }
    var code: SecStaticCode?, requirement: SecRequirement?
    let rule = "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(bundleIdentifier)\""
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: packageApp) as CFURL, [], &code) == errSecSuccess,
          SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
          let appCode = code, let appRequirement = requirement,
          SecStaticCodeCheckValidity(appCode, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), appRequirement) == errSecSuccess else {
        try fail("The application inside this installer was not signed by Device Deck's developer.")
    }
}
func copyInstaller(_ source: String, _ target: String, owner: uid_t) throws {
    let fd = open(source, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { try fail("Cannot open the downloaded installer.") }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == owner,
          info.st_mode & 0o022 == 0, info.st_size > 0, info.st_size <= 2 * 1024 * 1024 * 1024 else { try fail("The downloaded installer has unexpected ownership, permissions or size.") }
    let out = open(target, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
    guard out >= 0 else { try fail("Cannot stage the installer.") }
    defer { close(out) }
    var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
    var total: Int64 = 0
    while true {
        let count = read(fd, &buffer, buffer.count)
        if count == 0 { break }
        guard count > 0 else { try fail("Cannot read the downloaded installer.") }
        total += Int64(count)
        guard total <= info.st_size else { try fail("The downloaded installer changed while it was copied.") }
        var written = 0
        while written < count {
            let size = buffer.withUnsafeBytes { write(out, $0.baseAddress! + written, count - written) }
            guard size > 0 else { try fail("Cannot save the installer.") }; written += size
        }
    }
    guard total == info.st_size else { try fail("The downloaded installer changed while it was copied.") }
}
func reopen(_ uid: uid_t) {
    _ = try? run("/bin/launchctl", ["asuser", String(uid), "/usr/bin/sudo", "-H", "-u", "#\(uid)", "--", "/usr/bin/open", appPath])
}
func menuApplications() throws -> [(pid: Int32, uid: uid_t)] {
    let output = try run("/bin/ps", ["-axo", "pid=,uid=,comm="])
    return output.split(separator: "\n").compactMap { line in
        let fields = line.split(maxSplits: 2, omittingEmptySubsequences: true, whereSeparator: { $0 == " " || $0 == "\t" })
        guard fields.count == 3, let pid = Int32(fields[0]), let uid = UInt32(fields[1]),
              fields[2] == appPath + "/Contents/MacOS/Device Deck" else { return nil }
        return (pid, uid)
    }
}
func installedClients() throws -> [Int32] {
    let resources = appPath + "/Contents/Resources"
    let output = try run("/bin/ps", ["-axo", "pid=,comm="])
    return output.split(separator: "\n").compactMap { line in
        let fields = line.split(maxSplits: 1, omittingEmptySubsequences: true, whereSeparator: { $0 == " " || $0 == "\t" })
        guard fields.count == 2, let pid = Int32(fields[0]), fields[1] == resources + "/runtime/bin/node" else { return nil }
        let arguments = (try? run("/bin/ps", ["-p", String(pid), "-o", "command="]))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let known = ["devdeck", "tui", "mcp"].contains { entry in
            let prefix = resources + "/runtime/bin/node " + resources + "/build/" + entry + ".mjs"
            return arguments == prefix || arguments.hasPrefix(prefix + " ")
        }
        return known ? pid : nil
    }
}
func update(_ source: String, uid: String, guiPID: String, version: String) throws {
    let user = try account(uid), team = try signingTeam()
    guard let pid = Int32(guiPID), pid > 1 else { try fail("Invalid application process.") }
    // Never let a user-supplied PID turn the administrator helper into an arbitrary kill tool.
    let processOwner = try run("/bin/ps", ["-p", String(pid), "-o", "uid="]).trimmingCharacters(in: .whitespacesAndNewlines)
    let processPath = try run("/bin/ps", ["-p", String(pid), "-o", "comm="]).trimmingCharacters(in: .whitespacesAndNewlines)
    guard processOwner == uid, processPath == appPath + "/Contents/MacOS/Device Deck" else { try fail("The updating application changed. Try again.") }
    let temporary = "/private/tmp/device-deck-update-" + UUID().uuidString
    try files.createDirectory(atPath: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(atPath: temporary) }
    let installer = temporary + "/Device Deck.pkg"
    try copyInstaller(source, installer, owner: user.uid)
    let signature = try run("/usr/sbin/pkgutil", ["--check-signature", installer])
    guard signature.contains("Developer ID Installer:"), signature.contains("(\(team))") else { try fail("The update was not signed by the same developer as this app.") }
    _ = try run("/usr/sbin/spctl", ["--assess", "--type", "install", installer])
    try verifyUpdatePackage(installer, source: source, requestedVersion: version, team: team, expanded: temporary + "/expanded")
    _ = try hostCLI(["service", "prepare-update"])
    var stopped = false
    var clients = [(pid: Int32, uid: uid_t)]()
    do {
        _ = try run("/bin/launchctl", ["bootout", serviceLabel]); stopped = true
        // All menu apps are clients of the same drained service. Close only the
        // verified installed executable, then reopen each signed-in user's UI.
        clients = try menuApplications()
        for client in clients { kill(client.pid, SIGTERM) }
        // Idle installed CLI/MCP/TUI connections also hold the old runtime open.
        // Only those exact entry points are closed, never unrelated Node jobs.
        for client in try installedClients() { kill(client, SIGTERM) }
        for _ in 0..<100 {
            if try menuApplications().isEmpty && installedClients().isEmpty { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        _ = try run("/usr/sbin/installer", ["-pkg", installer, "-target", "/"])
        _ = try run("/bin/launchctl", ["bootstrap", "system", launchPath]); stopped = false
        try waitHealthy()
        try save(JSONSerialization.data(withJSONObject: ["at": Date().timeIntervalSince1970, "ok": true]), sharedPath + "/last-update.json")
        for clientUID in Set(clients.map { $0.uid } + [user.uid]) { reopen(clientUID) }
    } catch {
        if stopped { _ = try? run("/bin/launchctl", ["bootstrap", "system", launchPath]) }
        else { _ = try? hostCLI(["service", "cancel-update"]) }
        try? save(JSONSerialization.data(withJSONObject: ["at": Date().timeIntervalSince1970, "ok": false, "message": error.localizedDescription]), sharedPath + "/last-update.json")
        for clientUID in Set(clients.map { $0.uid } + [user.uid]) { reopen(clientUID) }
        throw error
    }
}
do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count == 2 && args[0] == "--plan" {
        let (marker, plist) = try plan(args[1])
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["host": marker, "launchDaemon": plist], options: [.prettyPrinted, .sortedKeys]))
        exit(0)
    }
    if args.count == 3 && args[0] == "--compare-versions" {
        print(try ReleaseVersion(args[1]).compare(ReleaseVersion(args[2]))); exit(0)
    }
    if args.count == 5 && args[0] == "--check-package-metadata" {
        let installed: [String: Any] = ["version": args[3], "arch": args[4]]
        _ = try validateExpandedPackage(args[1], requestedVersion: args[2], installed: installed)
        print("Device Deck package metadata matches."); exit(0)
    }
    guard geteuid() == 0 else { try fail("Open Device Deck setup to authorize service changes with macOS.") }
    try trustedApp()
    try protectedDirectory(sharedPath)
    let lock = sharedPath + "/administration.lock"
    // Root-owned lock prevents two authorized setup/update helpers racing.
    if files.fileExists(atPath: lock) {
        let info = try attributes(lock)
        guard info.st_uid == 0, info.st_mode & S_IFMT == S_IFDIR else { try fail("The service administration lock is invalid.") }
        let prior = (try? String(contentsOfFile: lock + "/pid", encoding: .utf8)).flatMap { Int32($0) }
        guard let priorPID = prior, priorPID > 1, kill(priorPID, 0) != 0, errno == ESRCH else { try fail("Another Device Deck setup or update is running. Try again when it finishes.") }
        try files.removeItem(atPath: lock)
    }
    try files.createDirectory(atPath: lock, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(atPath: lock) }
    try String(getpid()).write(toFile: lock + "/pid", atomically: true, encoding: .utf8)
    if args.count == 2 && args[0] == "configure" { try configure(args[1]) }
    else if args.count == 5 && args[0] == "update" { try update(args[1], uid: args[2], guiPID: args[3], version: args[4]) }
    else { try fail("Unsupported service action.") }
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1)
}
