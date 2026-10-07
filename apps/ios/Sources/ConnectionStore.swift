import Combine
import Foundation
import OSLog

@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var connections: [Connection] = []
    private let defaults: UserDefaults
    private let key = "pi-desk.connections"
    private let logger = Logger(subsystem: "com.jetcrab.ios", category: "connections")

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        guard let data = defaults.data(forKey: key) else { return }
        do {
            let saved = try JSONDecoder().decode([Connection].self, from: data)
            var seen = Set<String>()
            connections = saved.compactMap { connection in
                guard let address = try? WebEndpoint.normalize(connection.address),
                      seen.insert(address).inserted else { return nil }
                return Connection(id: connection.id, address: address)
            }
        } catch {
            logger.error("读取连接列表失败：\(error.localizedDescription, privacy: .public)")
        }
    }

    func save(_ input: String, replacing id: UUID?) throws {
        let address = try WebEndpoint.normalize(input)
        guard !connections.contains(where: { $0.id != id && $0.address == address }) else {
            throw ConnectionError.duplicate
        }
        var updated = connections
        if let id, let index = updated.firstIndex(where: { $0.id == id }) {
            updated[index] = Connection(id: id, address: address)
        } else {
            updated.append(Connection(id: UUID(), address: address))
        }
        try persist(updated)
    }

    func delete(_ id: UUID) throws {
        try persist(connections.filter { $0.id != id })
    }

    private func persist(_ updated: [Connection]) throws {
        let data = try JSONEncoder().encode(updated)
        defaults.set(data, forKey: key)
        connections = updated
    }
}
