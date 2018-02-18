import * as fs from 'fs'
import * as child_process from 'child_process'
import * as path from 'path'
import {Kak, splice, Spliceable, MessageKakoune, MessageOptions, TempFile} from './libkak/Kak'
export {Kak, splice, Spliceable, MessageKakoune, MessageOptions}

//////////////////////////////////////////////////////////////////////////////
// Standard splice type

export const keyed = <Splice, K extends keyof Splice>(
  k: K,
  expansion: string,
  parse: ((s: string) => Splice[K]),
  embed: (s: string) => string = s => s
) => splice(_ => expansion)<Splice, K>(k, parse, embed)

export const val = splice(s => '%val(' + s + ')')
export const arg = splice(s => '%arg(' + s + ')')
export const opt = splice(s => '%opt(' + s + ')')
export const reg = splice(s => '%reg(' + s + ')')
export const client_env = splice(s => '%val(client_env_' + s + ')')
export const id = <A>(a: A) => a

/** FIXME: does not handle list items with escaped colons due to missing lookbacks in js regex */
export const colons = (s: string) => s.split(':')

export const subkeys = <S extends Record<string, any>, K extends keyof S>(m: S, ...ks: K[]) => ks

export interface Splice {
  buffile: string
  timestamp: number
  session: string
  client: string
  /** buffer content */
  content: string
  selection: string
  /** todo: split at non backslash-escaped : */
  selections: string[]
  selection_desc: Cursor
  selections_desc: Cursor[]
  cursor_line: number
  cursor_column: number
  filetype: string
  1: string
  completers: string[]
  '"': string
}

export const Splice: Spliceable<Splice> = {
  ...val('buffile', id),
  ...val('session', id),
  ...val('client', id),
  ...val('timestamp', parseInt),
  ...val('cursor_line', parseInt),
  ...val('cursor_column', parseInt),
  ...keyed('content', '%val(selection)', id, s => `eval -draft %(exec '%'; ${s})`),
  ...val('selection', id),
  ...val('selection', id),
  ...val('selections', colons),
  ...val('selection_desc', parse_cursor),
  ...val('selections_desc', s => s.split(':').map(parse_cursor)),
  ...opt('filetype', id),
  ...arg('1', id),
  ...opt('completers', colons),
  ...reg('"', id),
}

//////////////////////////////////////////////////////////////////////////////
// File utils

export function Headless(ui: string = 'dummy', ...args: string[]) {
  const n = args.indexOf('-c') == -1 ? ['-n'] : []
  const spawn_args = [...n, '-ui', ui, ...args]
  const kak = child_process.execFile('kak', spawn_args)
  return {
    pid: kak.pid,
    kill() {
      kak.kill()
    },
  }
}

//////////////////////////////////////////////////////////////////////////////
// Make strings to send to kakoune

export function quote(msg: string) {
  // https://github.com/mawww/kakoune/issues/1049
  return (
    "'" +
    msg
      .replace("\\'", "\\\\'")
      .replace("'", "\\'")
      .replace(/\\*$/, '') +
    "'"
  )
}

export interface Pos {
  line: number
  column: number
}

export function format_pos(pos: Pos): string {
  return `${pos.line}.${pos.column}`
}

export function parse_pos(s: string): Pos {
  const [line, column] = s.split('.').map(s => parseInt(s, 10))
  return {line, column}
}

export const zero: Pos = {
  line: 1,
  column: 1,
}

export const zero_indexed = (p: Pos) => ({line: p.line - 1, character: p.column - 1})
export const one_indexed = (p: {line: number; character: number}): Pos => ({
  line: p.line + 1,
  column: p.character + 1,
})

export interface Cursor {
  anchor: Pos
  head: Pos
}

export function format_cursor(cursor: Cursor) {
  return format_pos(cursor.anchor) + ',' + format_pos(cursor.head)
}

export function parse_cursor(s: string): Cursor {
  const [anchor, head] = s.split(',').map(parse_pos)
  return {anchor, head}
}

export function menu(options: {title: string; command: string}[]) {
  if (options.length == 1) {
    return options[0].command
  } else {
    const m = 'menu ' + options.map(opt => quote(opt.title) + ' ' + quote(opt.command)).join(' ')
    console.error({menu: m})
    return m
  }
}

export type InfoPlacement = 'above' | 'below' | 'info' | 'docsclient' | 'statusline'

export function info(msg: string, where: InfoPlacement = 'info', pos?: Pos): string {
  if (msg.trim() == '') {
    return ''
  }
  switch (where) {
    case 'docsclient':
      const tmp = TempFile(msg)
      return `eval -no-hooks -try-client %opt{docsclient} %{
        edit! -scratch '*libkak-doc*'
        exec \%d|cat<space> ${tmp}<ret>
        exec \%|fmt<space> - %val{window_width} <space> -s <ret>
        exec gg
        set buffer filetype rst
        try %{rmhl window/number_lines}
        %sh{rm ${tmp}}
      }`
    case 'statusline':
      return `echo ${quote(msg.replace(/\s+/gm, ' '))}`
    case 'info':
      return `info ${quote(msg)}`
    case 'above':
    case 'below':
      return `info -placement ${where} -anchor ${format_pos(pos || zero)} ${quote(msg)}`
  }
}

export interface CompletionContext {
  cursor_line: number
  cursor_column: number
  timestamp: number
  completions: Completion[]
}

export interface Completion {
  /** the inserted text */
  insert: string
  /** the help text */
  help: string
  /** what is written in the completions menu */
  entry: string
}

export function Completion(insert: string, help: string, entry: string) {
  return {insert, help, entry}
}

export function format_complete(cc: CompletionContext) {
  const format_completion = (c: Completion) =>
    [c.insert, c.help, c.entry].map(s => s.replace(/[|:\\]/g, x => '\\' + x)).join('|')
  const rows = cc.completions.map(format_completion).join(':')
  return `${cc.cursor_line}.${cc.cursor_column}@${cc.timestamp}:${rows}`
}

export function complete_reply(
  optname: string,
  cc: CompletionContext & {completers: string[]; buffile: string}
) {
  let setup = ''
  const opt = `option=${optname}`
  const buffer = quote('buffer=' + cc.buffile)
  if (-1 == cc.completers.indexOf(opt)) {
    setup += `try %{ decl completions ${optname} };`
    setup += `set ${buffer} completers ${opt};`
    // NB: no -add, we prevent all other completers for now
  }
  return setup + `set ${buffer} ${optname} ${quote(format_complete(cc))}`
  // todo: lsp-complete fetch documentation when index in completion list changes
}
