import * as fs from 'fs'
import * as cp from 'child_process'
import * as readline from 'readline'
import * as path from 'path'
import { Position } from 'vscode-languageserver-types'

export type InfoPlacement = 'above' | 'below' | 'box' | 'docsclient'

export function quote(msg: string) {
  // https://github.com/mawww/kakoune/issues/1049
  return "'" + msg.replace("\\'", "\\\\'").replace("'", "\\'").replace(/\\*$/, '') + "'"
}

export function make_kak_pos(pos: Position): string {
  return `${pos.line + 1}.${pos.character + 1}`
}

export const zero: Position = ({
  line: 0,
  character: 0
})

export function info(msg: string, where: InfoPlacement='box', pos?: Position): string {
  if (msg.trim() == '') {
    return ''
  }
  switch (where) {
    case 'docsclient':
      const tmp = TempFile(msg)
      return `eval -no-hooks -try-client %opt{docsclient} %{
        edit! -scratch '*lsp-doc*'
        exec \%d|cat<space> ${tmp}<ret>
        exec \%|fmt<space> - %val{window_width} <space> -s <ret>
        exec gg
        set buffer filetype rst
        try %{rmhl window/number_lines}
        %sh{rm ${tmp}}
      }`
    case 'box': return `info ${quote(msg)}`
    case 'above':
    case 'below': return `info -placement ${where} -anchor ${make_kak_pos(pos || zero)} ${quote(msg)}`
  }
}

export function TempFile(contents: string): string {
  const filename = cp.execFileSync('mktemp', { encoding: 'utf8' }).trim()
  fs.writeFileSync(filename, contents)
  return filename
}

export function MessageKakoune({session, client, debug}: { session: string, client?: string, debug?: boolean }, message: string) {
  if (debug) {
    console.log({session, client, message})
  }
  if (message.trim() == '') {
    return
  }
  if (client !== undefined) {
    const tmp = TempFile(message)
    MessageKakoune({ session, debug }, `eval -client ${client} %{source ${tmp}}; %sh{rm ${tmp}}`)
  } else {
    const p = cp.execFile('kak', ['-p', session])
    p.stdin.end(message)
  }
}

export type Expand = ((s: string) => string)
export type Embed = ((s: string) => string)
export type Parse<Splice, K extends keyof Splice> = ((s: string) => Splice[K])
export interface Details<Splice, K extends keyof Splice> {
  expand: Expand,
  embed: Embed,
  parse: Parse<Splice, K>
}
export type SpliceDetails<Splice extends Record<string, any>> = {
  [K in keyof Splice]: Details<Splice, K>
}

export const splice =
  (expand: Expand) =>
  <Splice, K extends keyof Splice>(k: K, parse: Parse<Splice, K>, embed: (s: string) => string = s => s) =>
  ({[k]: {expand, parse, embed}} as Record<K, Details<Splice, K>>)

export const val = splice(s => '%val(' + s + ')')
export const arg = splice(s => '%arg(' + s + ')')
export const opt = splice(s => '%opt(' + s + ')')
export const reg = splice(s => '%reg(' + s + ')')
export const client_env = splice(s => '%val(client_env_' + s + ')')
export const id = <A>(a: A) => a

/** does not handle list items with escaped colons due to missing lookbacks in js regex */
export const colons = (s: string) => s.split(':')

export const subkeys = <S extends Record<string, any>, K extends keyof S>(m: S, ...ks: K[]) => ks

export const KakouneBuddy =
  <Splice>(
    details: SpliceDetails<Splice>,
    handler_map: Record<string, (p: Partial<Record<keyof Splice, string>>) => void>,
    fifo: string,
    snippet_cb: (kak_snippet: string) => void) => {
  const bs = "\\"
  snippet_cb(`
def -hidden -allow-override lsp-json-key-value -params 2 %{
  reg q %arg{2}
  exec -buffer *lsp-expand* 'gea,"' %arg{1} '":"__"<esc>hh"q<a-R>"p<a-Z>a'
}
def -hidden -allow-override lsp-json-escape %{
  try %{ exec '"pzs["${bs}${bs}]<ret>i${bs}<esc>' }
  try %{ exec '"pzs${bs}n<ret>c${bs}n<esc>' }
  try %{ exec '"pzs${bs}t<ret>c${bs}t<esc>' }
  try %{ exec '"pz;Ls.?${bs}K_<ret>d' }
}`)
  function AskKakoune<K extends keyof Splice>(embed: (snippet: string) => string, command: string, args: K[], on: (m: Pick<Splice, K>) => void) {
    const lsp_json_kvs = args.map(k =>
      details[k].embed(`lsp-json-key-value ${k} ${details[k].expand(k)}`)
    ).join('\n    ')
    snippet_cb(embed(`
  eval -draft -no-hooks %(
    edit -debug -scratch *lsp-expand*
    exec '%di{"command":"${command}"'
  )
  eval -draft -no-hooks -save-regs pq %(
    reg p ''
    ${lsp_json_kvs}
    eval -buffer *lsp-expand* %(
      lsp-json-escape
      exec gea}<esc>
      write ${fifo}
    )
  )`))
    handler_map[command] = (parsed_json_line: Partial<Record<keyof Splice, string>>) => {
      const parsed_rhss: Pick<Splice, K> = {} as any
      args.forEach((k: K) => {
        const rhs = parsed_json_line[k]
        if (rhs === undefined) {
          throw 'Missing ' + k
        }
        parsed_rhss[k] = details[k].parse(rhs)
      })
      on(parsed_rhss)
    }
  }
  let ask_counter = 0
  function ask<K extends keyof Splice>(args: K[], on: (m: Pick<Splice, K>) => void) {
    const command_name = '__ask__' + ask_counter++
    AskKakoune(id, command_name, args,
      m => (on(m), delete handler_map[command_name]))
  }
  function def<K extends keyof Splice>(command_name: string, params: string, args: K[], on: (m: Pick<Splice, K>) => void) {
    AskKakoune(s => `def -allow-override ${command_name} ${params} %(` + s + `)`,
      command_name, args, on)
  }
  return {ask, def}
}

export interface Splice {
  buffile: string,
  timestamp: number,
  client: string,
  selection: string,
  cursor_line: number,
  cursor_column: number,
  filetype: string,
  1: string,
  completers: string[] // lsp-specific
}

export const Details: SpliceDetails<Splice> = {
  ...val('buffile', id),
  ...val('client', id),
  ...val('timestamp', parseInt),
  ...val('cursor_line', parseInt),
  ...val('cursor_column', parseInt),
  ...val('selection', id, s => `eval -draft %(exec '%'; ${s})`),
  ...opt('filetype', id),
  ...arg('1', id),
  ...opt('completers', colons),
}

export const StandardKeys = subkeys(Details, 'buffile', 'client', 'timestamp', 'cursor_line', 'cursor_column', 'selection', 'filetype')

export type StandardKeys = typeof StandardKeys[0]

export type Standard = Pick<Splice, StandardKeys>

export function CreateHandler(options?: { debug?: boolean }) {
  const tmpdir = cp.execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim()
  const fifo = path.join(tmpdir, 'fifo')
  cp.execFileSync('mkfifo', [fifo])

  function Readline(on: (line: string) => void) {
    (function go() {
      readline.createInterface({
        input: fs.createReadStream(fifo)
      }).on('line', line => {
        try {
          on(line)
        } catch (e) {
          console.error(e)
        }
        go()
      })
    })()
  }

  const handlers = {}

  Readline(line => {
    if (options && options.debug) {
      console.log(line)
    }
    const m = JSON.parse(line)
    const h = (handlers as any)[m['command']]
    h(m)
  })

  return {fifo, handlers}
}

