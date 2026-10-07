import Foundation

@MainActor
final class WebSessionStore {
    private var sessions: [UUID: WebSession] = [:]
    private var recent: [UUID] = []
    private let capacity = 3

    func session(for connection: Connection) -> WebSession {
        if let existing = sessions[connection.id], existing.address != connection.address {
            release(connection.id)
        }
        let session: WebSession
        if let existing = sessions[connection.id] {
            session = existing
        } else {
            session = WebSession(address: connection.address)
            sessions[connection.id] = session
        }
        recent.removeAll { $0 == connection.id }
        recent.append(connection.id)
        while recent.count > capacity, let oldest = recent.first {
            release(oldest)
        }
        return session
    }

    func release(_ id: UUID) {
        sessions.removeValue(forKey: id)?.dispose()
        recent.removeAll { $0 == id }
    }

    func discardInactive(keeping id: UUID?) {
        for candidate in Array(sessions.keys) where candidate != id {
            release(candidate)
        }
    }
}
