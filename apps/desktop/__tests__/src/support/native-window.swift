import CoreGraphics
import Foundation
import ApplicationServices

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]) else {
    fail("usage: native-window <pid>", code: 64)
}

// The window-server inventory and accessibility tree observe the packaged
// process independently of its own diagnostics.
// https://developer.apple.com/documentation/coregraphics/1455137-cgwindowlistcopywindowinfo
let visibleWindows = (CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] ?? []).filter { window in
    (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
        && (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        && (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else {
        return nil
    }
    return value
}

var accessibilityText = Set<String>()
var accessibilityActions = Set<String>()
var visited = 0

func visit(_ element: AXUIElement, depth: Int) {
    guard depth <= 24, visited < 4_096 else { return }
    visited += 1
    let role = attribute(element, kAXRoleAttribute as CFString) as? String
    var ownText: [String] = []
    for name in [
        kAXTitleAttribute,
        kAXValueAttribute,
        kAXDescriptionAttribute,
        kAXHelpAttribute,
    ] {
        if let value = attribute(element, name as CFString) as? String,
           !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            accessibilityText.insert(value)
            ownText.append(value)
        }
    }
    var actionNames: CFArray?
    if AXUIElementCopyActionNames(element, &actionNames) == .success,
       let actions = actionNames as? [String],
       actions.contains(kAXPressAction as String),
       let label = ownText.first {
        accessibilityActions.insert("\(role ?? "unknown"): \(label)")
    }
    if let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] {
        for child in children {
            visit(child, depth: depth + 1)
        }
    }
}

visit(AXUIElementCreateApplication(pid), depth: 0)

let payload: [String: Any] = [
    "accessibilityActions": accessibilityActions.sorted(),
    "accessibilityText": accessibilityText.sorted(),
    "pid": pid,
    "visibleWindowCount": visibleWindows.count,
]
let encoded = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data("\n".utf8))
