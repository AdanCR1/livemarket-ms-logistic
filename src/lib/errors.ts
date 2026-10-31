export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export function assertOk(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new ApiError(status, code, message)
}
