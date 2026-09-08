import CoreGraphics
import Foundation

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]) else {
    fail("usage: native-window <pid>", code: 64)
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

let payload: [String: Any] = [
    "pid": pid,
    "visibleWindowCount": visibleWindows.count,
]
let encoded = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data("\n".utf8))
