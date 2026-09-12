// Device Deck stable AVFoundation source discovery and shared JPEG stream.
import Foundation
import AVFoundation
import CoreImage
import AppKit
func die(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
let args = Array(CommandLine.arguments.dropFirst())
if args.first == "clipboard" {
 guard args.count == 2, let image = NSImage(contentsOfFile: args[1]) else { die("Cannot read image for clipboard") }
 let board = NSPasteboard.general; board.clearContents()
 guard board.writeObjects([image]) else { die("macOS clipboard rejected the image") }
 exit(0)
}
let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.external, .builtInWideAngleCamera], mediaType: .video, position: .unspecified).devices
if args.first == "list" {
 let list = devices.filter { $0.deviceType == .external && $0.transportType == 0x75736220 }.map { ["uniqueId": $0.uniqueID, "name": $0.localizedName, "model": $0.modelID, "inUse": $0.isInUseByAnotherApplication ? "true" : "false"] }
 let data = try JSONSerialization.data(withJSONObject: list, options: [.sortedKeys]); FileHandle.standardOutput.write(data); exit(0)
}
guard args.count == 2 && args[0] == "stream", let device = devices.first(where: { $0.uniqueID == args[1] }) else { die("Configured capture source is missing. Choose its unique ID from sources discovery.") }
if device.isInUseByAnotherApplication { die("Capture source is in use by another application") }
let permission = AVCaptureDevice.authorizationStatus(for: .video)
if permission == .notDetermined { let sem = DispatchSemaphore(value: 0); AVCaptureDevice.requestAccess(for: .video) { _ in sem.signal() }; sem.wait() }
guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { die("Camera permission is required for Device Deck's capture helper in System Settings > Privacy & Security > Camera") }
final class Frames: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
 let context = CIContext(); var last: Double = 0
 func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
  let time = ProcessInfo.processInfo.systemUptime
  if time - last < 1.0 / 15.0 { return }; last = time
  guard let pixel = CMSampleBufferGetImageBuffer(sampleBuffer), let color = CGColorSpace(name: CGColorSpace.sRGB) else { return }
  let image = CIImage(cvPixelBuffer: pixel)
  guard let jpeg = context.jpegRepresentation(of: image, colorSpace: color, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85]) else { return }
  do { try FileHandle.standardOutput.write(contentsOf: jpeg) } catch { exit(0) }
 }
}
let session = AVCaptureSession(); session.sessionPreset = .hd1280x720
let frames = Frames(); let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = true
output.setSampleBufferDelegate(frames, queue: DispatchQueue(label: "device-deck-frames"))
do { let input = try AVCaptureDeviceInput(device: device); guard session.canAddInput(input), session.canAddOutput(output) else { die("Unsupported capture format") }; session.addInput(input); session.addOutput(output) } catch { die(error.localizedDescription) }
session.startRunning()
let parentPID = getppid()
let watcher = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
watcher.schedule(deadline: .now() + 2, repeating: 2)
watcher.setEventHandler {
 if getppid() != parentPID { exit(0) }
 if !device.isConnected { die("USB capture source disconnected") }
 if frames.last > 0 && ProcessInfo.processInfo.systemUptime - frames.last > 10 { die("Capture source stopped delivering frames") }
}
watcher.resume()
RunLoop.main.run()
