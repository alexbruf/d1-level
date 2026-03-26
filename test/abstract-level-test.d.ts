declare module 'abstract-level/test' {
  function suite(options: {
    test: (name: string, fn: (t: any) => void) => void
    factory: (options?: Record<string, unknown>) => import('abstract-level').AbstractLevel<any, any, any>
  }): void
  export = suite
}
