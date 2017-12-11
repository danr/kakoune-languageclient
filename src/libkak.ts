import * as fs from 'fs'
import * as cp from 'child_process'

export function MessageKakoune(session: string, client: string | undefined = undefined, message: string) {
  if (client) {
    const tmp = cp.execFileSync('mktemp', { encoding: 'utf8' }).trim()
    fs.writeFileSync(tmp, message)
    MessageKakoune(session, undefined,
      `eval -client ${client} %{source ${tmp}}; %sh{rm ${tmp}}`)
  } else {
    cp.execFile('kak', ['-p', session]).stdin.end(message)
  }
}

export type Expand = ((s: string) => string)
export type Parse<Splice, K extends keyof Splice> = ((s: string) => Splice[K])
export interface Details<Splice, K extends keyof Splice> {
  expand: Expand,
  parse: Parse<Splice, K>
}
export type SpliceDetails<Splice extends Record<string, any>> = {
  [K in keyof Splice]: Details<Splice, K>
}

export const splice =
  (expand: Expand) =>
  <Splice, K extends keyof Splice>(k: K, parse: Parse<Splice, K>) =>
  ({[k]: {expand, parse}} as Record<K, Details<Splice, K>>)

export const val = splice(s => '%val{' + s + '}')
export const arg = splice(s => '%arg{' + s + '}')
export const opt = splice(s => '%opt{' + s + '}')
export const reg = splice(s => '%reg{' + s + '}')
export const client_env = splice(s => '%val{client_env_' + s + '}')
export const id = <A>(a: A) => a

export const subkeys = <S extends Record<string, any>, K extends keyof S>(m: S, ...ks: K[]) => ks

export const KakouneBuddy =
  <Splice>(
    details: SpliceDetails<Splice>,
    fifo: string,
    snippet_cb: (kak_snippet: string) => void,
    handler_map: Record<string, (p: Partial<Record<keyof Splice, string>>) => void>) => {
  const bs = "\\"
  snippet_cb(`
def -hidden -allow-override lsp-json-key-value -params 2 %{
  reg q %arg{2}
  exec -buffer *lsp-expand* 'A,"' %arg{1} '":"__"<esc>hh"q<a-R>"p<a-Z>a'
}
def -hidden -allow-override lsp-json-escape %{
  try %{ exec '"pzs["${bs}${bs}]<ret>i${bs}<esc>' }
  try %{ exec '"pzs${bs}n<ret>c${bs}n<esc>' }
  try %{ exec '"pzs${bs}t<ret>c${bs}t<esc>' }
  try %{ exec '"pz;Ls.?${bs}K_<ret>d' }
}`)
  function AskKakoune<K extends keyof Splice>(command: string, args: K[], on: (m: Pick<Splice, K>) => void) {
    const lsp_json_kvs = args.map(k => `lsp-json-key-value ${k} ${details[k].expand(k)}`).join('\n    ')
    snippet_cb(`
  eval -draft -no-hooks %(
    edit -debug -scratch *lsp-expand*
    exec '%di{"command":"${command}"'
  )
  eval -draft -no-hooks -save-regs pq %(
    reg p ''
    ${lsp_json_kvs}
    eval -buffer *lsp-expand* %(
      lsp-json-escape
      exec A}<esc>
      write ${fifo}
    )
  )`)
    handler_map[command] = (parsed_json_line: Partial<Record<keyof Splice, string>>) => {
      const parsed_rhss: Pick<Splice, K> = {} as any
      const keys = Object.keys(parsed_json_line) as K[]
      keys.forEach((k: K) => {
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
    AskKakoune(command_name, args, m => (on(m), delete handler_map[command_name]))
  }
  function def<K extends keyof Splice>(command_name: string, params: string, args: K[], on: (m: Pick<Splice, K>) => void) {
    snippet_cb(`def -allow-override ${command_name} ${params} %(`)
    AskKakoune(command_name, args, on)
    snippet_cb(`)`)
  }
  return {ask, def}
}

