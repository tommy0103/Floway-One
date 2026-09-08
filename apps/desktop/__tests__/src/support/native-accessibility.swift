import ApplicationServices
import CoreGraphics
import Foundation

struct AccessibilityRecord {
    let description: String
    let enabled: Bool?
    let role: String
    let title: String
    let value: String

    var json: [String: Any] {
        var result: [String: Any] = [
            "description": description,
            "role": role,
            "title": title,
            "value": value,
        ]
        if let enabled {
            result["enabled"] = enabled
        }
        return result
    }
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

private func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
    guard let value = attribute(element, name) else { return "" }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return ""
}

private func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool? {
    (attribute(element, name) as? NSNumber)?.boolValue
}

private func elementAttribute(_ element: AXUIElement, _ name: CFString) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return nil
    }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func record(_ element: AXUIElement) -> AccessibilityRecord {
    AccessibilityRecord(
        description: stringAttribute(element, kAXDescriptionAttribute as CFString),
        enabled: boolAttribute(element, kAXEnabledAttribute as CFString),
        role: stringAttribute(element, kAXRoleAttribute as CFString),
        title: stringAttribute(element, kAXTitleAttribute as CFString),
        value: stringAttribute(element, kAXValueAttribute as CFString)
    )
}

private func collect(
    _ root: AXUIElement,
    depth: Int = 0,
    maximumDepth: Int = 12,
    maximumElements: Int = 4096,
    into records: inout [AccessibilityRecord]
) {
    guard depth <= maximumDepth, records.count < maximumElements else { return }
    records.append(record(root))
    for child in children(root) {
        collect(
            child,
            depth: depth + 1,
            maximumDepth: maximumDepth,
            maximumElements: maximumElements,
            into: &records
        )
    }
}

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]) else {
    fail("usage: native-accessibility <pid>", code: 64)
}

// The trust query never raises the operating-system prompt. A verifier must
// report missing authority rather than waiting behind an invisible consent UI.
// https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrusted
guard AXIsProcessTrusted() else {
    fail(
        "macOS Accessibility access is required to inspect the packaged Floway window and tray; grant it to the process running the desktop verifier in System Settings > Privacy & Security > Accessibility",
        code: 77
    )
}

let application = AXUIElementCreateApplication(pid)
guard let applicationWindows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement],
      !applicationWindows.isEmpty else {
    fail("the packaged Floway process exposes no native accessibility window", code: 1)
}

// CoreGraphics observes an actually composited layer-zero window independently
// from the process and accessibility trees.
// https://developer.apple.com/documentation/coregraphics/1455137-cgwindowlistcopywindowinfo
let visibleWindows = (CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] ?? []).filter { window in
    (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
        && (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        && (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0
}
guard !visibleWindows.isEmpty else {
    fail("the packaged Floway process has no visible native window", code: 1)
}

var windowRecords: [AccessibilityRecord] = []
for window in applicationWindows {
    collect(window, into: &windowRecords)
}

// The extras menu bar is the accessibility owner of an application's native
// status item and its menu, distinct from the ordinary application menu bar.
// https://developer.apple.com/documentation/applicationservices/kaxextrasmenubarattribute
guard let extrasMenuBar = elementAttribute(application, kAXExtrasMenuBarAttribute as CFString) else {
    fail("the packaged Floway process exposes no native tray menu bar", code: 1)
}
let trayItems = children(extrasMenuBar)
guard !trayItems.isEmpty else {
    fail("the packaged Floway process exposes no native tray item", code: 1)
}
let trayItem = trayItems.first { item in
    let identity = [
        stringAttribute(item, kAXTitleAttribute as CFString),
        stringAttribute(item, kAXDescriptionAttribute as CFString),
        stringAttribute(item, kAXHelpAttribute as CFString),
    ].joined(separator: " ")
    return identity.localizedCaseInsensitiveContains("Floway")
} ?? trayItems[0]

let pressResult = AXUIElementPerformAction(trayItem, kAXPressAction as CFString)
guard pressResult == .success else {
    fail("the packaged Floway tray item could not be opened through accessibility (AX error \(pressResult.rawValue))", code: 1)
}
Thread.sleep(forTimeInterval: 0.15)
var trayRecords: [AccessibilityRecord] = []
collect(trayItem, into: &trayRecords)
_ = AXUIElementPerformAction(trayItem, kAXPressAction as CFString)

let payload: [String: Any] = [
    "pid": pid,
    "tray": trayRecords.map(\.json),
    "windows": windowRecords.map(\.json),
    "visibleWindowCount": visibleWindows.count,
]
let encoded = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data("\n".utf8))
