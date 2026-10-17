export class MiningError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'MiningError';
    this.code = code;
  }
}
