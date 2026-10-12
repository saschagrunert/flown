/**
 * Settle like `promise`, unless it takes longer than `timeoutMs`: then
 * reject with `message`. What the promise stands for is not stopped by
 * that (an import or a frame cannot be), only given up on; a caller with
 * something to take back does so when the result settles.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
