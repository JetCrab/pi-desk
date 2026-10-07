import Foundation

struct Connection: Codable, Identifiable, Hashable {
    let id: UUID
    let address: String

    var title: String {
        guard let url = URL(string: address) else { return address }
        let host = url.host ?? address
        return url.path.isEmpty || url.path == "/" ? host : "\(host) · \(url.path)"
    }
}

enum ConnectionError: LocalizedError {
    case invalid(String)
    case duplicate

    var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .duplicate: return "该服务地址已经存在。"
        }
    }
}

enum WebEndpoint {
    static func normalize(_ input: String) throws -> String {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw ConnectionError.invalid("请输入服务地址。") }
        guard value.count <= 2048,
              value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              !value.contains("\\") else {
            throw ConnectionError.invalid("请输入有效的服务地址。")
        }
        if !value.contains("://") {
            value = "http://" + value
        }
        guard var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else {
            throw ConnectionError.invalid("服务地址必须是 http 或 https，且包含主机名。")
        }
        guard components.user == nil, components.password == nil else {
            throw ConnectionError.invalid("服务地址不能包含账号或密码。")
        }

        // URLComponents 的宽松解析不能代替端口边界校验。
        let authorityStart = value.range(of: "://")!.upperBound
        let authority = String(value[authorityStart...].prefix { !"/?#".contains($0) })
        let portText: String?
        if authority.hasPrefix("[") {
            guard let closingBracket = authority.firstIndex(of: "]") else {
                throw ConnectionError.invalid("IPv6 地址需要使用方括号。")
            }
            let suffix = authority[authority.index(after: closingBracket)...]
            guard suffix.isEmpty || suffix.hasPrefix(":") else {
                throw ConnectionError.invalid("请输入有效的主机名和端口。")
            }
            portText = suffix.isEmpty ? nil : String(suffix.dropFirst())
        } else {
            let parts = authority.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count <= 2 else {
                throw ConnectionError.invalid("IPv6 地址需要使用方括号。")
            }
            portText = parts.count == 2 ? String(parts[1]) : nil
        }
        if let portText {
            guard !portText.isEmpty, portText.allSatisfy({ $0 >= "0" && $0 <= "9" }),
                  let port = Int(portText), (1...65535).contains(port) else {
                throw ConnectionError.invalid("端口必须是 1 到 65535 之间的整数。")
            }
            components.port = port
        }
        components.scheme = scheme
        components.host = host.lowercased()
        if components.port == (scheme == "http" ? 80 : 443) {
            components.port = nil
        }
        components.percentEncodedPath = normalizedPath(components.percentEncodedPath)
        guard let url = components.url, let normalized = url.absoluteString.removingPercentEncoding,
              !normalized.contains("\u{0000}") else {
            throw ConnectionError.invalid("请输入有效的服务地址。")
        }
        return url.absoluteString
    }

    static func isHTTP(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return (scheme == "http" || scheme == "https") && url.host != nil
            && url.user == nil && url.password == nil
    }

    static func hasSameOrigin(_ url: URL, as base: URL) -> Bool {
        isHTTP(url) && url.scheme?.lowercased() == base.scheme?.lowercased()
            && url.host?.lowercased() == base.host?.lowercased()
            && effectivePort(url) == effectivePort(base)
    }

    private static func effectivePort(_ url: URL) -> Int {
        url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
    }

    private static func normalizedPath(_ path: String) -> String {
        guard !path.isEmpty else { return "/" }
        var segments: [String] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: false).dropFirst() {
            switch segment {
            case ".": continue
            case "..":
                if !segments.isEmpty { segments.removeLast() }
            default: segments.append(String(segment))
            }
        }
        var result = "/" + segments.joined(separator: "/")
        if (path.hasSuffix("/.") || path.hasSuffix("/..")) && !result.hasSuffix("/") {
            result += "/"
        }
        return result
    }
}
