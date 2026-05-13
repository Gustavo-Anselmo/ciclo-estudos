declare module 'node-cron' {
  export function schedule(
    expression: string,
    func: () => void | Promise<void>,
    options?: { scheduled?: boolean; timezone?: string },
  ): void
}
