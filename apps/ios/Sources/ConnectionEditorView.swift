import SwiftUI

@MainActor
struct ConnectionEditorView: View {
    let connection: Connection?
    let onSave: (String) throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var address: String
    @State private var errorMessage: String?
    @FocusState private var addressFocused: Bool

    init(connection: Connection?, onSave: @escaping (String) throws -> Void) {
        self.connection = connection
        self.onSave = onSave
        _address = State(initialValue: connection?.address ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("服务地址") {
                    TextField("http://host:port", text: $address, axis: .vertical)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($addressFocused)
                        .onSubmit(save)
                        .accessibilityLabel("服务地址")
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(connection == nil ? "添加连接" : "编辑连接")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存", action: save)
                        .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func save() {
        do {
            try onSave(address)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            addressFocused = true
        }
    }
}
