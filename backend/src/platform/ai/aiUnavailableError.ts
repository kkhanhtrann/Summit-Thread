// Signal that a configured answer provider could not complete a request
export class AiUnavailableError extends Error {
  constructor() {
    super('The private assistant is temporarily unavailable');
    this.name = 'AiUnavailableError';
  }
}
