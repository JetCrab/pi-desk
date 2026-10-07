import SwiftUI

@main
@MainActor
struct PiDeskApp: App {
    @StateObject private var connections = ConnectionStore()
    private let sessions = WebSessionStore()

    init() {
        WebDownloads.clearAbandonedFiles()
    }

    var body: some Scene {
        WindowGroup {
            ConnectionListView(store: connections, sessions: sessions)
                .tint(Color.primary)
        }
    }
}
