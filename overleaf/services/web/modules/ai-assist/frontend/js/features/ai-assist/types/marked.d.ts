declare module 'marked' {
  export interface MarkedOptions {
    gfm?: boolean
    breaks?: boolean
    pedantic?: boolean
  }

  export namespace Tokens {
    export interface Generic {
      type: string
      raw?: string
      text?: string
      tokens?: Token[]
      [key: string]: unknown
    }
    export interface Table {
      type: 'table'
      raw?: string
      header: TableCell[]
      rows: TableCell[][]
      tokens?: Token[]
    }
    export interface TableCell {
      text: string
      tokens?: Token[]
      header?: boolean
      align?: 'center' | 'left' | 'right' | null
    }
  }

  export type Token = Tokens.Generic | Tokens.Table | any

  export namespace marked {
    function setOptions(options: MarkedOptions): void
    function parse(src: string, options?: MarkedOptions): string
    function parseInline(src: string, options?: MarkedOptions): string
    function lexer(src: string, options?: MarkedOptions): any
    function parser(tokens: any, options?: MarkedOptions): string
    function use(...args: any[]): void
  }
}
