import SwiftUI
import UIKit

@MainActor
struct ConnectionListView: View {
    @ObservedObject var store: ConnectionStore
    let sessions: WebSessionStore
    @State private var selectedID: UUID?
    @State private var editor: EditorRequest?
    @State private var deleting: Connection?
    @State private var errorMessage: String?

    private var selectedConnection: Connection? {
        store.connections.first { $0.id == selectedID }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedID) {
                ForEach(store.connections) { connection in
                    NavigationLink(value: connection.id) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connection.title)
                                .font(.body)
                                .lineLimit(1)
                            Text(connection.address)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 4)
                    }
                    .swipeActions {
                        Button("删除", role: .destructive) { deleting = connection }
                        Button("编辑") { editor = EditorRequest(connection: connection) }
                            .tint(.gray)
                    }
                    .contextMenu {
                        Button("编辑", systemImage: "pencil") {
                            editor = EditorRequest(connection: connection)
                        }
                        Button("删除", systemImage: "trash", role: .destructive) {
                            deleting = connection
                        }
                    }
                }
            }
            .overlay {
                if store.connections.isEmpty {
                    ContentUnavailableView {
                        Label("添加连接", systemImage: "network")
                    } actions: {
                        Button("添加服务地址") { editor = EditorRequest(connection: nil) }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle("Pi Desk")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("添加连接", systemImage: "plus") {
                        editor = EditorRequest(connection: nil)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 360)
        } detail: {
            if let connection = selectedConnection {
                BrowserView(connection: connection, sessions: sessions) {
                    editor = EditorRequest(connection: connection)
                } onDelete: {
                    deleting = connection
                }
                .id(connection.address)
            } else {
                ContentUnavailableView("选择连接", systemImage: "network")
            }
        }
        .sheet(item: $editor) { request in
            ConnectionEditorView(connection: request.connection) { input in
                let previous = request.connection
                let normalized = try WebEndpoint.normalize(input)
                try store.save(normalized, replacing: previous?.id)
                if let previous, previous.address != normalized {
                    sessions.release(previous.id)
                }
            }
        }
        .alert("删除连接？", isPresented: Binding(
            get: { deleting != nil },
            set: { if !$0 { deleting = nil } }
        ), presenting: deleting) { connection in
            Button("删除", role: .destructive) {
                do {
                    try store.delete(connection.id)
                    if selectedID == connection.id { selectedID = nil }
                    sessions.release(connection.id)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
            Button("取消", role: .cancel) {}
        } message: { connection in
            Text(connection.address)
        }
        .alert("操作失败", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            sessions.discardInactive(keeping: selectedID)
        }
    }
}

private struct EditorRequest: Identifiable {
    let id = UUID()
    let connection: Connection?
}
