import CoreGraphics
import CryptoKit
import Foundation
import Vision

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

// Usage: native-window <pid> [snapshot-path expected-sha256]
guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 4,
      let pid = pid_t(CommandLine.arguments[1]) else {
    fail("usage: native-window <pid> [snapshot-path expected-sha256]", code: 64)
}

// This window-server inventory requires no Accessibility or Screen Recording
// grant and observes the packaged process independently of its own diagnostics.
// https://developer.apple.com/documentation/coregraphics/1455137-cgwindowlistcopywindowinfo
let visibleWindows = (CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] ?? []).filter { window in
    (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
        && (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        && (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0
}

var payload: [String: Any] = [
    "pid": pid,
    "visibleWindowCount": visibleWindows.count,
]

if CommandLine.arguments.count == 4 {
    let snapshotPath = CommandLine.arguments[2]
    let expectedSha256 = CommandLine.arguments[3]

    let snapshotData: Data
    do {
        snapshotData = try Data(contentsOf: URL(fileURLWithPath: snapshotPath))
    } catch {
        fail("Floway rendered snapshot unreadable: \(error.localizedDescription)", code: 66)
    }
    let actualSha256 = SHA256.hash(data: snapshotData).map { String(format: "%02x", $0) }.joined()
    guard actualSha256 == expectedSha256 else {
        fail("Floway rendered snapshot digest mismatch: expected \(expectedSha256), observed \(actualSha256)", code: 65)
    }

    // Vision text recognition reads only the captured image and needs no
    // Accessibility grant, so it works on a clean machine and in CI.
    // https://developer.apple.com/documentation/vision/vnrecognizetextrequest
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: snapshotPath), options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("Floway rendered snapshot recognition failed: \(error.localizedDescription)", code: 74)
    }
    payload["ocrCandidates"] = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    payload["snapshotSha256"] = actualSha256
}

let encoded = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data("\n".utf8))
