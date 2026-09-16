declare module 'marked' {
  export interface MarkedOptions {
    gfm?: boolean
    breaks?: boolean
    pedantic?: boolean
  }

  export namespace marked {
    function setOptions(options: MarkedOptions): void
    function parse(src: string, options?: MarkedOptions): string
    function use(...args: any[]): void
  }
}
