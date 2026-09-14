import AppKit
import Foundation

// A persistent LaunchServices parent gives the daemon and capture helper a stable
// macOS application identity. The daemon always runs as the signed-in user.
final class DeviceDeckApp: NSObject, NSApplicationDelegate {
    private var daemon: Process?
    private var statusItem: NSStatusItem?
    private var starting = false
    private var quitting = false
    private let resources = Bundle.main.resourceURL!
    private var environment = ProcessInfo.processInfo.environment
    private let arguments = Array(CommandLine.arguments.dropFirst())
    private var serviceOnly: Bool { arguments.contains("--service") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard getuid() != 0 else {
            showError("Device Deck must run as your Mac user, never as root.")
            return
        }
        for (flag, key) in [("--profile", "DEVICE_DECK_HOME"), ("--config", "DEVICE_DECK_CONFIG"), ("--port", "DEVICE_DECK_PORT")] {
            if let index = arguments.firstIndex(of: flag), arguments.count > index + 1 {
                environment[key] = arguments[index + 1]
            }
        }
        for key in environment.keys where key.hasPrefix("NODE_") || key.hasPrefix("DYLD_") {
            environment.removeValue(forKey: key)
        }
        environment["PATH"] = [resources.appendingPathComponent("runtime/bin").path,
                               resources.appendingPathComponent("media/bin").path,
                               "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        environment["DEVICE_DECK_APP_HOSTED"] = "1"
        makeMenu()
        starting = true
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                if self.runCLI(["status"]).status == 0 {
                    if !self.serviceOnly { try self.openDashboard() }
                    DispatchQueue.main.async { self.starting = false; NSApp.terminate(nil) }
                    return
                }
                let directory = URL(fileURLWithPath: self.environment["DEVICE_DECK_HOME"] ??
                    NSHomeDirectory() + "/Library/Application Support/Device Deck")
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700])
                let logURL = directory.appendingPathComponent("daemon.log")
                if !FileManager.default.fileExists(atPath: logURL.path) {
                    FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
                }
                let log = try FileHandle(forWritingTo: logURL)
                try log.seekToEnd()
                let process = Process()
                process.executableURL = self.resources.appendingPathComponent("runtime/bin/node")
                process.arguments = [self.resources.appendingPathComponent("build/daemon.mjs").path]
                process.environment = self.environment
                process.standardInput = FileHandle.nullDevice
                process.standardOutput = log
                process.standardError = log
                self.daemon = process
                try process.run()
                try log.close()
                var ready = false
                for _ in 0..<80 {
                    if self.runCLI(["status"]).status == 0 { ready = true; break }
                    if !process.isRunning { break }
                    Thread.sleep(forTimeInterval: 0.25)
                }
                guard ready else {
                    throw NSError(domain: "Device Deck", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "The service could not start. Read " + logURL.path])
                }
                if !self.serviceOnly { try self.openDashboard() }
                DispatchQueue.main.async { self.starting = false }
                process.waitUntilExit()
                DispatchQueue.main.async { self.daemon = nil; NSApp.terminate(nil) }
            } catch {
                DispatchQueue.main.async {
                    self.starting = false
                    // A browser-open failure must not orphan or terminate a
                    // successfully started daemon that other clients can use.
                    self.showError(error.localizedDescription, quit: self.daemon?.isRunning != true)
                }
            }
        }
    }

    private func makeMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "rectangle.stack", accessibilityDescription: "Device Deck")
        item.button?.toolTip = "Device Deck"
        let menu = NSMenu()
        for (title, action) in [("Open Device Deck", #selector(openFromMenu)),
                                ("Check for updates", #selector(checkUpdates)),
                                ("Capture setup", #selector(showSetup)),
                                ("Quit Device Deck", #selector(quitFromMenu))] {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
            entry.target = self
            menu.addItem(entry)
        }
        item.menu = menu
        statusItem = item
    }

    private func runCLI(_ args: [String]) -> (status: Int32, text: String) {
        let process = Process(), output = Pipe()
        process.executableURL = resources.appendingPathComponent("runtime/bin/node")
        process.arguments = [resources.appendingPathComponent("build/devdeck.mjs").path] + args
        process.environment = environment
        process.standardOutput = output; process.standardError = output
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch { return (1, error.localizedDescription) }
    }

    private func openDashboard() throws {
        let result = runCLI(["ui"])
        if result.status != 0 { throw NSError(domain: "Device Deck", code: 1, userInfo: [NSLocalizedDescriptionKey: result.text]) }
    }
    @objc private func openFromMenu() {
        guard !starting else { return }
        DispatchQueue.global().async {
            do { try self.openDashboard() }
            catch { DispatchQueue.main.async { self.showError(error.localizedDescription, quit: false) } }
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openFromMenu(); return false
    }
    @objc private func showSetup() {
        let file = resources.appendingPathComponent("Capture Setup.html")
        NSWorkspace.shared.open(file)
    }
    @objc private func checkUpdates() {
        DispatchQueue.global().async {
            let result = self.runCLI(["update", "check"])
            let data = result.text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let release = data?["release"] as? [String: Any]
            let message: String
            if result.status != 0 {
                message = data?["message"] as? String ?? "The update check failed. Run devdeck update check for details."
            } else if data?["available"] as? Bool == true {
                message = "Device Deck " + (release?["version"] as? String ?? "update") +
                    " is available. Run devdeck update download to save the verified installer. Finish reservations and recordings, then quit Device Deck before installing. Homebrew users should upgrade through Homebrew."
            } else {
                message = data?["message"] as? String ?? "You have the latest available package for this channel."
            }
            DispatchQueue.main.async {
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "Device Deck updates"
                alert.informativeText = message
                alert.addButton(withTitle: "OK")
                alert.runModal()
            }
        }
    }
    @objc private func quitFromMenu() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting || daemon == nil { return .terminateNow }
        if starting { return .terminateCancel }
        DispatchQueue.global().async {
            let result = self.runCLI(["call", "inventory", "{}"])
            let inventory = result.text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let sessions = inventory?["sessions"] as? [[String: Any]] ?? []
            let recordings = inventory?["recordings"] as? [[String: Any]] ?? []
            let occupied = sessions.contains { ($0["state"] as? String) != "closed" } || !recordings.isEmpty
            DispatchQueue.main.async {
                if result.status != 0 || occupied {
                    self.showError(occupied ? "Finish active reservations and recordings before quitting Device Deck." :
                        "Could not check current sessions. Use devdeck status before stopping the service.", quit: false)
                    sender.reply(toApplicationShouldTerminate: false)
                } else {
                    self.quitting = true
                    self.daemon?.terminate()
                    sender.reply(toApplicationShouldTerminate: true)
                }
            }
        }
        return .terminateLater
    }
    private func showError(_ message: String, quit: Bool = true) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Device Deck"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
        if quit { quitting = true; NSApp.terminate(nil) }
    }
}
let app = NSApplication.shared
let delegate = DeviceDeckApp()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
