// An error with a machine-readable code, so routes can pick the right HTTP status.
export class AppError extends Error {
  code: string;
  detail?: string;
  constructor(message: string, code: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
