import 'server-only'

export class L4PiSettingsError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'L4PiSettingsError'
  }
}
