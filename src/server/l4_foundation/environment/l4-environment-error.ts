export class L4EnvironmentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L4EnvironmentValidationError'
  }
}
