import AppKit
import Foundation
import ServiceManagement
import AVFoundation

// A persistent LaunchServices parent gives the daemon and capture helper a stable
// macOS application identity. The daemon always runs as the signed-in user.
final class DeviceDeckApp: NSObject, NSApplicationDelegate {
    private var daemon: Process?
    private var statusItem: NSStatusItem?
    private var starting = false
    private var quitting = false
    private var setupWindow: NSWindow?
    private var setupStack: NSStackView?
    private var setupStatus = NSTextField(wrappingLabelWithString: "Checking this Mac…")
    private var loginItem: NSMenuItem?
    private var busy = false
    private var captureBridge: Process?
    private var sharing: [String: Any] = [:]
    private var pendingUpdate: String?
    private var pendingUpdateVersion: String?
    private var updateTimer: Timer?
    private var bridgeError: String?
    private var checkedLastUpdate = false
    private let resources = Bundle.main.resourceURL!
    private var environment = ProcessInfo.processInfo.environment
    private let arguments = Array(CommandLine.arguments.dropFirst())
    private var serviceOnly: Bool { arguments.contains("--service") }
    private var isolated: Bool { arguments.contains("--profile") || environment["DEVICE_DECK_HOME"] != nil }
    private var isHost: Bool { sharing["isHost"] as? Bool == true }
    private let loginPreferenceKey = "openMenuBarAppAtLogin"
    private var wantsLogin: Bool { UserDefaults.standard.bool(forKey: loginPreferenceKey) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard getuid() != 0 else {
            showError("Device Deck must run as your Mac user, never as root.")
            return
        }
        for (flag, key) in [("--profile", "DEVICE_DECK_HOME"), ("--config", "DEVICE_DECK_CONFIG"), ("--port", "DEVICE_DECK_PORT"), ("--host", "DEVICE_DECK_HOST")] {
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
        if !isolated && UserDefaults.standard.object(forKey: loginPreferenceKey) == nil {
            // Show the first-run default before setup. Existing installations
            // retain their current setting when adopting the saved preference.
            let status = SMAppService.mainApp.status
            UserDefaults.standard.set(!UserDefaults.standard.bool(forKey: "macSetupCompleted") || status == .enabled || status == .requiresApproval, forKey: loginPreferenceKey)
        }
        makeMenu()
        if !isolated {
            // Login-item launches carry no command-line marker. Completed setups
            // stay quiet; explicit Dock/Finder reopen opens the dashboard below.
            refreshSetup(openWhenReady: !serviceOnly && !UserDefaults.standard.bool(forKey: "macSetupCompleted"))
            return
        }
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
                if self.arguments.contains("--setup") { DispatchQueue.main.async { self.showSetup() } }
                else if !self.serviceOnly { try self.openDashboard() }
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
                                ("Mac setup…", #selector(showSetup)),
                                ("Check for updates…", #selector(checkUpdates)),
                                ("Open at login", #selector(toggleLogin)),
                                ("Quit menu-bar app", #selector(quitFromMenu))] {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
            entry.target = self
            menu.addItem(entry)
            if title == "Open at login" { loginItem = entry; entry.state = wantsLogin ? .on : .off; entry.isEnabled = !isolated }
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
        if !isolated && sharing["running"] as? Bool != true { showSetup(); return }
        DispatchQueue.global().async {
            do { try self.openDashboard() }
            catch { DispatchQueue.main.async { self.showError(error.localizedDescription, quit: false) } }
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if setupWindow?.isVisible == true || (!isolated && (!UserDefaults.standard.bool(forKey: "macSetupCompleted") || sharing["running"] as? Bool != true)) {
            showSetup()
        } else { openFromMenu() }
        return false
    }
    @objc private func showSetup() {
        if setupWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 610, height: 650), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.title = "Device Deck setup"; window.isReleasedWhenClosed = false; window.minSize = NSSize(width: 560, height: 520)
            let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
            let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
            stack.edgeInsets = NSEdgeInsets(top: 26, left: 28, bottom: 26, right: 28)
            scroll.documentView = stack; window.contentView = scroll
            stack.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor), stack.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor), stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor)])
            setupWindow = window; setupStack = stack; window.center()
        }
        renderSetup(); setupWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        if !isolated { refreshSetup() }
    }
    private func text(_ value: String, heading: Bool = false) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.font = heading ? .boldSystemFont(ofSize: 16) : .systemFont(ofSize: 13)
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return label
    }
    private func button(_ title: String, _ action: Selector) -> NSButton { NSButton(title: title, target: self, action: action) }
    private func renderSetup() {
        guard let stack = setupStack else { return }
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        let title = text("Set up Device Deck on this Mac", heading: true); title.font = .boldSystemFont(ofSize: 23); stack.addArrangedSubview(title)
        stack.addArrangedSubview(text("One shared workspace for this Mac. Your devices, reservations and captures stay together, including work started by CI."))
        stack.addArrangedSubview(text("Background service", heading: true))
        if sharing["configured"] as? Bool == true {
            let host = sharing["host"] as? [String: Any]
            stack.addArrangedSubview(text("Hosted by \(host?["username"] as? String ?? "this Mac"). The service starts at boot, before login."))
            if sharing["running"] as? Bool != true {
                stack.addArrangedSubview(text(sharing["message"] as? String ?? "The shared service is not responding."))
                if isHost {
                    let repair = button("Start shared service", #selector(configureService)); repair.isEnabled = !busy; stack.addArrangedSubview(repair)
                    stack.addArrangedSubview(button("Open Login Items settings", #selector(openLoginSettings)))
                    stack.addArrangedSubview(button("Open service log", #selector(openServiceLog)))
                }
            }
        } else {
            stack.addArrangedSubview(text("Use \(NSUserName()) as the hosting account. macOS will ask an administrator to approve starting the service at boot. It runs as this account, never as root."))
            let start = button("Start shared service", #selector(configureService)); start.isEnabled = !busy && !isolated; stack.addArrangedSubview(start)
        }
        let login = NSButton(checkboxWithTitle: "Open menu-bar app at login", target: self, action: #selector(toggleLogin))
        login.state = wantsLogin ? .on : .off; login.isEnabled = !isolated
        stack.addArrangedSubview(login)
        stack.addArrangedSubview(text("The background service starts independently. The menu-bar app provides camera access while the hosting account is logged in."))
        if SMAppService.mainApp.status == .requiresApproval { stack.addArrangedSubview(button("Open Login Items settings", #selector(openLoginSettings))) }
        stack.addArrangedSubview(text("Capture and permissions", heading: true))
        if let error = bridgeError { stack.addArrangedSubview(text("Camera connection: " + error)) }
        let media = FileManager.default.isExecutableFile(atPath: resources.appendingPathComponent("media/bin/ffmpeg").path)
        stack.addArrangedSubview(text(media ? "Recording tools are included. No separate encoder installation is needed." : "This development build has no bundled recording tools. Public installers include them."))
        if isHost || sharing["configured"] as? Bool != true {
            let permission = AVCaptureDevice.authorizationStatus(for: .video)
            stack.addArrangedSubview(text(permission == .authorized ? "Camera access is allowed for capture cards." : "Allow Camera access if you use USB capture cards. You can skip this for network-only devices."))
            if permission == .notDetermined { stack.addArrangedSubview(button("Allow Camera access", #selector(allowCamera))) }
            else if permission != .authorized { stack.addArrangedSubview(button("Open Camera settings", #selector(openCameraSettings))) }
        }
        stack.addArrangedSubview(text("Apple simulators need Xcode and runtimes. Android devices need platform tools and debugging approval. Camera capture and Apple simulators may need the hosting account's desktop session."))
        stack.addArrangedSubview(button("Device setup guide", #selector(openDeviceGuide)))
        stack.addArrangedSubview(text("Mac account access", heading: true))
        if isHost {
            stack.addArrangedSubview(text("Allow accounts that should control this Mac's devices and captures, including CI. Removing access also ends that account's dashboard access."))
            let grants = sharing["grants"] as? [[String: Any]] ?? []
            let allowed = Set(grants.compactMap { $0["uid"] as? Int })
            for user in sharing["users"] as? [[String: Any]] ?? [] {
                guard let uid = user["uid"] as? Int, uid != Int(getuid()), let name = user["username"] as? String else { continue }
                let item = NSButton(checkboxWithTitle: name, target: self, action: #selector(toggleAccount(_:)))
                item.identifier = NSUserInterfaceItemIdentifier(name); item.tag = uid; item.state = allowed.contains(uid) ? .on : .off; item.isEnabled = !busy
                stack.addArrangedSubview(item)
            }
        } else {
            stack.addArrangedSubview(text(sharing["authorized"] as? Bool == true ? "This account can use the shared service. Manage account access from the hosting account." : "The hosting account can allow other users here after starting the shared service."))
        }
        setupStatus = text(busy ? "Working…" : sharing["running"] as? Bool == true ? "The shared service is ready." : "Complete service setup to continue.")
        setupStatus.textColor = .secondaryLabelColor; stack.addArrangedSubview(setupStatus)
        let actions = NSStackView(views: [button("Refresh setup", #selector(refreshFromSetup)), button("Open dashboard", #selector(finishSetup))]); actions.spacing = 12
        stack.addArrangedSubview(actions)
        for view in stack.arrangedSubviews { view.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor, constant: -56).isActive = true }
    }
    private func refreshSetup(openWhenReady: Bool = false) {
        DispatchQueue.global().async {
            let result = self.runCLI(["sharing", "status"])
            var state = result.text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            if result.status != 0 { state["message"] = result.text }
            if state["isHost"] as? Bool == true {
                let users = self.runCLI(["sharing", "users"])
                let value = users.text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                state["users"] = value?["users"]
            }
            DispatchQueue.main.async {
                self.sharing = state; self.startCaptureBridge(); self.renderSetup()
                self.showLastUpdateFailure()
                if openWhenReady {
                    if state["running"] as? Bool == true && UserDefaults.standard.bool(forKey: "macSetupCompleted") { self.openFromMenu() }
                    else { self.showSetup() }
                }
            }
        }
    }
    private func showLastUpdateFailure() {
        guard !isolated, !checkedLastUpdate else { return }; checkedLastUpdate = true
        let file = URL(fileURLWithPath: "/Library/Application Support/Device Deck/last-update.json")
        guard let data = try? Data(contentsOf: file), let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let at = result["at"] as? Double, at > UserDefaults.standard.double(forKey: "lastUpdateResultSeen") else { return }
        UserDefaults.standard.set(at, forKey: "lastUpdateResultSeen")
        if result["ok"] as? Bool == false { showError("The update did not finish. " + (result["message"] as? String ?? "Open Mac setup and try again."), quit: false) }
    }
    @objc private func refreshFromSetup() { refreshSetup() }
    @objc private func finishSetup() {
        if isolated || sharing["running"] as? Bool == true {
            if !isolated {
                do { try applyLoginPreference() }
                catch { showError("Device Deck is ready. Its login preference could not be applied. " + error.localizedDescription, quit: false) }
                UserDefaults.standard.set(true, forKey: "macSetupCompleted")
            }
            setupWindow?.close(); openFromMenu()
        } else { setupStatus.stringValue = "Start the shared service, or ask the hosting account to allow this account, then refresh setup." }
    }
    @objc private func configureService() {
        guard !busy else { return }; busy = true; renderSetup()
        DispatchQueue.global().async {
            do {
                try self.administratorAction(["configure", String(getuid())])
                for _ in 0..<40 { if self.runCLI(["status"]).status == 0 { break }; Thread.sleep(forTimeInterval: 0.5) }
                DispatchQueue.main.async {
                    self.busy = false
                    // Apply the visible first-run choice without overriding an
                    // intentional opt-out when the shared service is repaired.
                    do { try self.applyLoginPreference() }
                    catch { self.showError("The service is configured. Enable Open at login to keep camera capture available after login. " + error.localizedDescription, quit: false) }
                    self.loginItem?.state = self.wantsLogin ? .on : .off
                    self.refreshSetup()
                }
            } catch { DispatchQueue.main.async { self.busy = false; self.renderSetup(); self.showError(error.localizedDescription, quit: false) } }
        }
    }
    private func administratorAction(_ arguments: [String]) throws {
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let command = ([Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/device-deck-service").path] + arguments).map(quote).joined(separator: " ")
        let literal = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", "do shell script \"" + literal + "\" with administrator privileges"]
        process.standardOutput = output; process.standardError = output
        try process.run(); let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        if process.terminationStatus != 0 { throw NSError(domain: "Device Deck", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "Service setup was cancelled."]) }
    }
    private func applyLoginPreference() throws {
        let status = SMAppService.mainApp.status
        if wantsLogin && status == .notRegistered { try SMAppService.mainApp.register() }
        else if !wantsLogin && (status == .enabled || status == .requiresApproval) { try SMAppService.mainApp.unregister() }
    }
    @objc private func toggleLogin() {
        do {
            let enabled = !wantsLogin
            let status = SMAppService.mainApp.status
            if enabled {
                if status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
                else if status != .enabled { try SMAppService.mainApp.register() }
            } else if status == .enabled || status == .requiresApproval { try SMAppService.mainApp.unregister() }
            UserDefaults.standard.set(enabled, forKey: loginPreferenceKey)
            loginItem?.state = enabled ? .on : .off; renderSetup()
        } catch { renderSetup(); showError(error.localizedDescription, quit: false) }
    }
    @objc private func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }
    @objc private func openServiceLog() { NSWorkspace.shared.open(URL(fileURLWithPath: "/Library/Logs/Device Deck/daemon.log")) }
    @objc private func allowCamera() { AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async { self.renderSetup() } } }
    @objc private func openCameraSettings() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")!) }
    @objc private func openDeviceGuide() { NSWorkspace.shared.open(resources.appendingPathComponent("Capture Setup.html")) }
    @objc private func toggleAccount(_ sender: NSButton) {
        guard let name = sender.identifier?.rawValue, !busy else { return }
        busy = true; renderSetup()
        let arguments = sender.state == .on ? ["sharing", "grant", name] : ["sharing", "revoke", String(sender.tag)]
        DispatchQueue.global().async {
            let result = self.runCLI(arguments)
            DispatchQueue.main.async { self.busy = false; if result.status != 0 { self.showError(result.text, quit: false) }; self.refreshSetup() }
        }
    }
    private func startCaptureBridge() {
        guard !isolated, isHost, captureBridge?.isRunning != true,
              let host = sharing["host"] as? [String: Any], let profile = host["profile"] as? String else { return }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("build/native/deck-camera")
        process.arguments = ["--broker", profile + "/camera.sock"]
        var env = environment; env.removeValue(forKey: "DEVICE_DECK_SYSTEM_SERVICE"); process.environment = env
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice
        let errors = Pipe(); process.standardError = errors
        process.terminationHandler = { finished in
            let detail = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            DispatchQueue.main.async {
                self.captureBridge = nil
                if !self.quitting {
                    self.bridgeError = detail.isEmpty ? "The desktop camera connection stopped. Choose Refresh setup to retry." : detail
                    self.renderSetup()
                }
            }
        }
        do { try process.run(); captureBridge = process; bridgeError = nil }
        catch { bridgeError = "Could not start. " + error.localizedDescription }
    }
    @objc private func checkUpdates() {
        guard !busy else { return }
        if let file = pendingUpdate { offerInstallation(file); return }
        busy = true
        DispatchQueue.global().async {
            let result = self.runCLI(["update", "check"])
            let data = result.text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let release = data?["release"] as? [String: Any]
            DispatchQueue.main.async {
                self.busy = false
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "Device Deck updates"
                if result.status != 0 {
                    alert.informativeText = data?["message"] as? String ?? "The update check failed. Check your internet connection and try again."
                    alert.addButton(withTitle: "OK"); alert.runModal()
                } else if data?["available"] as? Bool == true {
                    alert.informativeText = "Device Deck \(release?["version"] as? String ?? "update") is available. Download the installer, then install when this Mac's device sessions have finished."
                    alert.addButton(withTitle: "Download update"); alert.addButton(withTitle: "Later")
                    if alert.runModal() == .alertFirstButtonReturn { self.downloadUpdate() }
                } else {
                    alert.informativeText = data?["message"] as? String ?? "You have the latest available package for this channel."
                    alert.addButton(withTitle: "OK"); alert.runModal()
                }
            }
        }
    }
    private func downloadUpdate() {
        busy = true
        let progress = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
        progress.title = "Downloading Device Deck"
        let label = NSTextField(wrappingLabelWithString: "Downloading and verifying the installer…")
        label.frame = NSRect(x: 24, y: 67, width: 352, height: 28)
        let spinner = NSProgressIndicator(frame: NSRect(x: 24, y: 32, width: 352, height: 16))
        spinner.isIndeterminate = true; spinner.style = .bar; spinner.startAnimation(nil)
        progress.contentView?.addSubview(label); progress.contentView?.addSubview(spinner); progress.center(); progress.makeKeyAndOrderFront(nil)
        DispatchQueue.global().async {
            let result = self.runCLI(["update", "download"])
            let data = result.text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                progress.close(); self.busy = false
                if result.status == 0, let file = data?["file"] as? String, let version = data?["version"] as? String {
                    self.pendingUpdate = file; self.pendingUpdateVersion = version; self.offerInstallation(file)
                } else { self.showError(data?["message"] as? String ?? "The download failed. Check your internet connection and try again.", quit: false) }
            }
        }
    }
    private func offerInstallation(_ file: String) {
        let alert = NSAlert(); alert.messageText = "Install Device Deck update?"
        alert.informativeText = "This updates the shared service for every account on this Mac. Active reservations and recordings must finish first. Open Device Deck clients will disconnect and the menu-bar apps will reopen. macOS will ask an administrator to approve installation. Your configuration and captures are preserved."
        alert.addButton(withTitle: "Install and reopen"); alert.addButton(withTitle: "Install when idle"); alert.addButton(withTitle: "Later")
        switch alert.runModal() {
        case .alertFirstButtonReturn: installUpdate(file)
        case .alertSecondButtonReturn:
            updateTimer?.invalidate()
            updateTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in self.checkUpdateIdle(file) }
            statusItem?.button?.toolTip = "Device Deck update is waiting for device sessions to finish"
            checkUpdateIdle(file)
        default: break
        }
    }
    private func checkUpdateIdle(_ file: String) {
        guard !busy else { return }; busy = true
        DispatchQueue.global().async {
            let result = self.runCLI(["call", "inventory", "{}"])
            let data = result.text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let sessions = data?["sessions"] as? [[String: Any]] ?? []
            let recordings = data?["recordings"] as? [[String: Any]] ?? []
            let idle = result.status == 0 && data != nil && !sessions.contains { ($0["state"] as? String) != "closed" } && recordings.isEmpty
            DispatchQueue.main.async {
                self.busy = false
                if idle { self.updateTimer?.invalidate(); self.updateTimer = nil; self.statusItem?.button?.toolTip = "Device Deck"; self.installUpdate(file) }
            }
        }
    }
    private func installUpdate(_ file: String) {
        guard !busy else { return }
        guard let version = pendingUpdateVersion else { showError("Download the update again before installing.", quit: false); return }
        guard !isolated, sharing["configured"] as? Bool == true else { showError("Complete Mac setup before installing an update from the app.", quit: false); showSetup(); return }
        busy = true; updateTimer?.invalidate(); updateTimer = nil
        DispatchQueue.global().async {
            do { try self.administratorAction(["update", file, String(getuid()), String(getpid()), version]) }
            catch { DispatchQueue.main.async { self.busy = false; self.showError(error.localizedDescription, quit: false) } }
        }
    }
    @objc private func quitFromMenu() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        if daemon == nil && captureBridge?.isRunning != true { return .terminateNow }
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
                    self.daemon?.terminate(); self.captureBridge?.terminate(); self.updateTimer?.invalidate()
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
